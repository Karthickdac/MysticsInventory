#!/usr/bin/env node
// Org-scope lint: every query against an org-scoped table must filter
// by the table's `organization_id` column.
//
// Catches the class of bug where a route forgets to add an
// `eq(<table>.organizationId, t.organizationId)` predicate (or its
// raw-SQL equivalent) to its WHERE clause and therefore silently
// returns / mutates rows from other tenants.
//
// Statically detected by walking every workspace package that depends
// on `@workspace/db` with the TypeScript compiler API:
//
//   1. Parse `lib/db/src/schema/*.ts` to learn:
//      - Which `<xxxTable>` identifiers refer to a Postgres table
//        that has an `organizationId` column.
//      - The corresponding underlying SQL table name (the first
//        argument to `pgTable("…", …)`).
//      Together these are the org-scoped tables.
//
//   2. Discover every workspace package whose `package.json` declares
//      `@workspace/db` in `dependencies` / `devDependencies` (lib/db
//      itself is excluded — it owns the schema). Walk every `.ts`
//      file under each consumer's `src/` directory and flag the
//      following shapes when they touch an org-scoped table without
//      a tenant filter:
//
//      a. Drizzle query-builder chains —
//         `db.select().from(<orgScopedTable>)`,
//         `db.update(<orgScopedTable>)`, `db.delete(<orgScopedTable>)`.
//         The chain's `.where(...)` must constrain the query by
//         `eq(<orgScopedTable>.organizationId, …)` (with bounded
//         intra-function dataflow for `where` arguments built up via
//         a local conds array, an aliased variable, etc).
//
//      b. Drizzle relational API — `db.query.<x>.findFirst(...)` or
//         `db.query.<x>.findMany(...)`. The argument object's
//         `where` property (either an arrow callback receiving the
//         table + ops, or a direct expression) must mention
//         `.organizationId` somewhere.
//
//      c. Raw SQL — any `<expr>.execute(sql\`…\`)` whose template
//         text mentions an org-scoped underlying SQL table name
//         (matched at word boundaries, case-insensitive) must also
//         contain a tenant predicate that mentions `organization_id`
//         in a `WHERE` or `ON` clause (also case-insensitive). A
//         loose substring check is *not* enough: queries like
//         `SELECT organization_id FROM users` (column appears in
//         SELECT, no tenant filter) or `UPDATE users SET
//         organization_id = X` (no WHERE at all) would otherwise
//         pass while still leaking across tenants. SQL line / block
//         comments are stripped before the predicate match so a
//         decorative `-- organization_id` annotation can't satisfy
//         the rule.
//
//   3. Anything that legitimately needs to query across tenants
//      (super-admin dashboards, webhooks that arrive without auth,
//      OAuth state lookups, the auth bootstrap itself, single-row
//      lookups by a globally unique UUID, etc) must opt in
//      explicitly with a `// org-scope-allow: <reason>` comment on
//      or just above the offending call site (the `.from(...)` /
//      `.update(...)` / `.delete(...)` / `.execute(...)` /
//      `.findFirst(...)` / `.findMany(...)` line).
//
// Exit code:
//   0 — no violations
//   1 — at least one violation (printed in `path:line:col` format).

import ts from "typescript";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const SCHEMA_DIR = path.join(REPO_ROOT, "lib/db/src/schema");
const DB_PACKAGE_NAME = "@workspace/db";

const ALLOW_MARKER = "org-scope-allow";

// Roots under which we look for workspace packages. Mirrors the
// `packages:` globs in pnpm-workspace.yaml (artifacts/*, lib/*,
// lib/integrations/*). We don't parse the YAML to avoid pulling in a
// dependency for a one-line list.
const PACKAGE_ROOTS = ["artifacts", "lib", "lib/integrations"];

// ── Step 1: discover org-scoped tables from schema files ──────────────
//
// Returns:
//   {
//     identNames:  Set<string>            — JS export identifiers
//                                            (e.g. "usersTable").
//     sqlNames:    Set<string>            — underlying SQL names
//                                            (e.g. "users").
//     identToSql:  Map<string, string>    — ident → sql name.
//   }

async function discoverOrgScopedTables() {
  const files = (await fs.readdir(SCHEMA_DIR))
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .map((f) => path.join(SCHEMA_DIR, f));
  const identNames = new Set();
  const sqlNames = new Set();
  const identToSql = new Map();
  for (const fp of files) {
    const src = readFileSync(fp, "utf8");
    const sf = ts.createSourceFile(fp, src, ts.ScriptTarget.Latest, true);
    sf.forEachChild((node) => {
      if (!ts.isVariableStatement(node)) return;
      const isExported = node.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (!isExported) return;
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        if (!decl.initializer || !ts.isCallExpression(decl.initializer)) continue;
        const callee = decl.initializer.expression;
        if (!ts.isIdentifier(callee) || callee.text !== "pgTable") continue;
        const nameArg = decl.initializer.arguments[0];
        const cols = decl.initializer.arguments[1];
        if (!cols || !ts.isObjectLiteralExpression(cols)) continue;
        const hasOrgId = cols.properties.some(
          (p) =>
            ts.isPropertyAssignment(p) &&
            ts.isIdentifier(p.name) &&
            p.name.text === "organizationId",
        );
        if (!hasOrgId) continue;
        const ident = decl.name.text;
        identNames.add(ident);
        if (nameArg && ts.isStringLiteral(nameArg)) {
          const sqlName = nameArg.text;
          sqlNames.add(sqlName);
          identToSql.set(ident, sqlName);
        }
      }
    });
  }
  return { identNames, sqlNames, identToSql };
}

// ── Step 2a: discover workspace packages that import @workspace/db ────
//
// Returns: Array<{ name: string, srcDir: string }>

async function discoverDbConsumers() {
  const consumers = [];
  for (const root of PACKAGE_ROOTS) {
    const fullRoot = path.join(REPO_ROOT, root);
    let entries;
    try {
      entries = await fs.readdir(fullRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const pkgDir = path.join(fullRoot, e.name);
      const pkgJsonPath = path.join(pkgDir, "package.json");
      let raw;
      try {
        raw = readFileSync(pkgJsonPath, "utf8");
      } catch {
        continue;
      }
      let pkg;
      try {
        pkg = JSON.parse(raw);
      } catch {
        continue;
      }
      // lib/db itself owns the schema — skip it.
      if (pkg.name === DB_PACKAGE_NAME) continue;
      const deps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
      };
      if (!(DB_PACKAGE_NAME in deps)) continue;
      const srcDir = path.join(pkgDir, "src");
      try {
        const st = await fs.stat(srcDir);
        if (!st.isDirectory()) continue;
      } catch {
        continue;
      }
      consumers.push({ name: pkg.name ?? path.relative(REPO_ROOT, pkgDir), srcDir });
    }
  }
  consumers.sort((a, b) => a.name.localeCompare(b.name));
  return consumers;
}

// ── Step 2b: walk source files and check call chains ──────────────────

async function listSourceFiles(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listSourceFiles(full)));
    } else if (e.isFile() && e.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function methodName(call) {
  const e = call.expression;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) {
    return e.name.text;
  }
  return null;
}

// Walk both directions of a `.a().b().c()` chain, collecting every
// CallExpression node that is part of the same fluent chain.
function collectChain(seedCall) {
  // Climb up to the outermost call.
  let head = seedCall;
  while (true) {
    const parent = head.parent;
    if (
      parent &&
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === head &&
      parent.parent &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent
    ) {
      head = parent.parent;
      continue;
    }
    break;
  }
  // Descend through the chain collecting calls.
  const calls = [];
  let cur = head;
  while (cur && ts.isCallExpression(cur)) {
    calls.push(cur);
    const e = cur.expression;
    if (!ts.isPropertyAccessExpression(e)) break;
    cur = e.expression;
  }
  return calls;
}

function findWhereCall(chainCalls) {
  return chainCalls.find((c) => methodName(c) === "where");
}

// Walk up to the nearest function-like ancestor (route handler /
// helper / arrow callback). Returned body is the scope used for
// bounded intra-function dataflow when checking the WHERE expression
// — see `whereSatisfiesOrgScope`.
function enclosingFunctionBody(node) {
  let cur = node.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isConstructorDeclaration(cur) ||
      ts.isGetAccessorDeclaration(cur) ||
      ts.isSetAccessorDeclaration(cur)
    ) {
      return cur.body;
    }
    cur = cur.parent;
  }
  return undefined;
}

// Collect every expression that flows into the local identifier
// `name` within `functionBody`:
//   - `const name = <expr>` / `let name = <expr>` initializers.
//   - `name = <expr>` reassignments.
//   - `name.push(<expr>)` / `name.unshift(<expr>)` for the array-of-
//     conds pattern, including spread arguments inside push.
//
// Bounded to one function scope on purpose — we deliberately do NOT
// follow identifiers out of the function, so a leak inside a callee
// can't satisfy the rule for its caller.
function collectIdentifierSources(name, functionBody) {
  const sources = [];
  if (!functionBody) return sources;
  function visit(n) {
    if (!n) return;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer
    ) {
      sources.push(n.initializer);
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left) &&
      n.left.text === name
    ) {
      sources.push(n.right);
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === name &&
      ts.isIdentifier(n.expression.name)
    ) {
      const m = n.expression.name.text;
      if (m === "push" || m === "unshift") {
        for (const a of n.arguments) sources.push(a);
      }
    }
    n.forEachChild(visit);
  }
  visit(functionBody);
  return sources;
}

// Bounded dataflow: does the WHERE argument expression — possibly
// after expanding any local identifiers it references — constrain the
// query by an equality predicate on `<tableIdent>.organizationId`?
//
// We specifically require an `eq(<tableIdent>.organizationId, …)` (or
// the symmetric `eq(…, <tableIdent>.organizationId)`) leaf predicate.
// Non-equality predicates such as `inArray(table.organizationId, …)`,
// `ne(table.organizationId, …)`, or `isNotNull(table.organizationId)`
// do NOT satisfy the rule — they don't pin the row set to a single
// tenant and would still leak cross-org data.
//
// `eq` leaves are accepted anywhere they appear, including inside
// nested `and(...)` / `or(...)` aggregators. (We do not try to prove
// the predicate is reachable from every disjunctive branch — that
// would require semantic boolean reasoning. Authors who write
// `or(eq(table.organizationId, …), unsafePredicate)` should add a
// `// org-scope-allow:` comment with a justification.)
//
// Supported shapes:
//   .where(eq(X.organizationId, ...))
//   .where(and(eq(X.organizationId, ...), other...))
//   .where(and(...conds))            — when `conds` is a local array
//                                      whose initializer / pushes
//                                      include eq(X.organizationId,…).
//   .where(myCondVar)                — when `myCondVar` resolves to
//                                      an expression that matches.
//
// Crucially, the expansion is bounded to the immediately enclosing
// function body and to a small set of expression shapes — we never
// fall back to a broad "does the whole function mention org id?"
// scan, which would let unscoped queries slip past whenever a
// sibling query in the same function happens to be scoped.
function whereSatisfiesOrgScope(whereArg, tableIdent, functionBody) {
  const visited = new Set();
  function isOrgIdProperty(expr) {
    return (
      expr &&
      ts.isPropertyAccessExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === tableIdent &&
      ts.isIdentifier(expr.name) &&
      expr.name.text === "organizationId"
    );
  }
  function calleeNameOf(call) {
    const c = call.expression;
    if (ts.isIdentifier(c)) return c.text;
    if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.name)) {
      return c.name.text;
    }
    return null;
  }
  function check(expr) {
    if (!expr) return false;
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isNonNullExpression(expr) ||
      (ts.isTypeAssertionExpression && ts.isTypeAssertionExpression(expr))
    ) {
      return check(expr.expression);
    }
    if (ts.isSpreadElement(expr)) {
      return check(expr.expression);
    }
    if (ts.isArrayLiteralExpression(expr)) {
      for (const el of expr.elements) {
        if (check(el)) return true;
      }
      return false;
    }
    if (ts.isCallExpression(expr)) {
      // Leaf acceptance: eq(<table>.organizationId, …) — either arg
      // position. Drizzle's eq is an equality op, so both orderings
      // pin the row set to a single tenant id.
      if (calleeNameOf(expr) === "eq" && expr.arguments.length >= 2) {
        if (
          isOrgIdProperty(expr.arguments[0]) ||
          isOrgIdProperty(expr.arguments[1])
        ) {
          return true;
        }
      }
      // Otherwise descend into arguments — handles `and(...)` /
      // `or(...)` aggregators and any other wrappers that contain
      // an eq predicate inside.
      for (const a of expr.arguments) {
        if (check(a)) return true;
      }
      return false;
    }
    if (ts.isBinaryExpression(expr)) {
      return check(expr.left) || check(expr.right);
    }
    if (ts.isConditionalExpression(expr)) {
      return check(expr.whenTrue) || check(expr.whenFalse);
    }
    if (ts.isIdentifier(expr)) {
      const key = expr.text;
      if (visited.has(key)) return false;
      visited.add(key);
      const sources = collectIdentifierSources(key, functionBody);
      for (const s of sources) {
        if (check(s)) return true;
      }
      return false;
    }
    return false;
  }
  return check(whereArg);
}

// Returns the line (0-indexed) of the method identifier itself —
// not the chain head. That gives the developer a stable place to
// attach a `// org-scope-allow: ...` comment that won't drift if
// unrelated lines above the chain change.
function methodIdentLine(sourceFile, callNode) {
  const e = callNode.expression;
  if (ts.isPropertyAccessExpression(e)) {
    return sourceFile.getLineAndCharacterOfPosition(e.name.getStart(sourceFile))
      .line;
  }
  return sourceFile.getLineAndCharacterOfPosition(callNode.getStart(sourceFile))
    .line;
}

function methodIdentColumn(sourceFile, callNode) {
  const e = callNode.expression;
  if (ts.isPropertyAccessExpression(e)) {
    return sourceFile.getLineAndCharacterOfPosition(e.name.getStart(sourceFile))
      .character;
  }
  return sourceFile.getLineAndCharacterOfPosition(callNode.getStart(sourceFile))
    .character;
}

function hasAllowComment(sourceFile, callNode) {
  const fullText = sourceFile.text;
  const callLine = methodIdentLine(sourceFile, callNode);
  const lines = fullText.split(/\r?\n/);
  // Walk upward from the call line through any preceding contiguous
  // block of `//` comment / blank lines, looking for the marker.
  // Walking stops at the first non-comment, non-blank source line —
  // so an allow comment must be visually attached to the call site.
  // Within that walk there is no fixed line budget, which lets the
  // marker sit on the first line of a multi-line rationale.
  for (let l = callLine; l >= 0; l--) {
    const line = lines[l] ?? "";
    if (line.includes(ALLOW_MARKER)) return true;
    if (l === callLine) continue;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("//")) continue;
    break;
  }
  return false;
}

// ── Step 2c: raw SQL helpers ──────────────────────────────────────────

// Concatenate all literal segments of a (possibly substituted)
// template. Substitutions are replaced with a single space so a
// template like sql`SELECT … WHERE id = ${id}` doesn't accidentally
// glue identifiers across the gap.
function templateText(template) {
  if (!template) return "";
  if (ts.isNoSubstitutionTemplateLiteral(template)) {
    return template.text;
  }
  if (ts.isTemplateExpression(template)) {
    let out = template.head.text;
    for (const span of template.templateSpans) {
      out += " " + span.literal.text;
    }
    return out;
  }
  return "";
}

function tagIsSql(tag) {
  if (ts.isIdentifier(tag)) return tag.text === "sql";
  if (ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.name)) {
    return tag.name.text === "sql";
  }
  return false;
}

// Tenant-predicate match: `organization_id` must appear after a
// `WHERE` or `ON` keyword (case-insensitive). Substring presence
// alone is *not* enough — `SELECT organization_id FROM …`,
// `UPDATE … SET organization_id = X` (no WHERE), or a column list
// `INSERT INTO foo (organization_id, …)` would otherwise satisfy a
// naïve check despite not constraining the row set to a tenant.
const ORG_ID_PREDICATE_RE = /\b(?:where|on)\b[\s\S]*?\borganization_id\b/i;

// Strip SQL line (`-- …`) and block (`/* … */`) comments before
// scanning, so a decorative annotation like
// `WHERE id = $1 -- organization_id` does not satisfy the predicate.
function stripSqlComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function rawSqlHasOrgIdPredicate(text) {
  return ORG_ID_PREDICATE_RE.test(stripSqlComments(text));
}

function rawSqlMentionsOrgScopedTable(text, sqlNames) {
  const stripped = stripSqlComments(text);
  for (const name of sqlNames) {
    // Word-boundary, case-insensitive — avoids false positives where
    // an org-scoped name is a substring of an unrelated identifier.
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(stripped)) return name;
  }
  return null;
}

// ── Step 2d: db.query relational API helpers ──────────────────────────
//
// Detects `db.query.<x>.findFirst(...)` / `db.query.<x>.findMany(...)`
// where `<x>` is an org-scoped table identifier. Requires the call's
// first argument to be an object literal with a `where` property
// whose value mentions `.organizationId` somewhere — either as a
// direct expression (`eq(usersTable.organizationId, …)`) or inside
// an arrow callback (`(users, { eq }) => eq(users.organizationId, …)`).
//
// Intentionally weaker than the query-builder check (we only require
// `.organizationId` to appear, not specifically inside an `eq`)
// because the relational API's table parameter is an arbitrary local
// alias, which makes a strict structural match brittle.

function isDbQueryRelationalCall(call) {
  // Shape: <ANY>.<x>.<findFirst|findMany>(...)
  // and the property *behind* <x> is `query`.
  const e = call.expression;
  if (!ts.isPropertyAccessExpression(e)) return null;
  if (!ts.isIdentifier(e.name)) return null;
  const m = e.name.text;
  if (m !== "findFirst" && m !== "findMany") return null;
  const tableProp = e.expression;
  if (!ts.isPropertyAccessExpression(tableProp)) return null;
  if (!ts.isIdentifier(tableProp.name)) return null;
  const queryProp = tableProp.expression;
  if (!ts.isPropertyAccessExpression(queryProp)) return null;
  if (!ts.isIdentifier(queryProp.name) || queryProp.name.text !== "query") {
    return null;
  }
  return { method: m, tableIdent: tableProp.name.text };
}

function expressionMentionsOrganizationId(expr) {
  let found = false;
  function visit(n) {
    if (found || !n) return;
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === "organizationId"
    ) {
      found = true;
      return;
    }
    n.forEachChild(visit);
  }
  visit(expr);
  return found;
}

function dbQueryWhereSatisfiesOrgScope(call) {
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
  const whereProp = arg.properties.find(
    (p) =>
      ts.isPropertyAssignment(p) &&
      ((ts.isIdentifier(p.name) && p.name.text === "where") ||
        (ts.isStringLiteral(p.name) && p.name.text === "where")),
  );
  if (!whereProp || !ts.isPropertyAssignment(whereProp)) return false;
  const value = whereProp.initializer;
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
    return expressionMentionsOrganizationId(value.body);
  }
  return expressionMentionsOrganizationId(value);
}

// ── Step 2e: per-file checker ─────────────────────────────────────────

// Returns a list of violations for one source file.
function checkFile(filePath, orgScoped) {
  const { identNames, sqlNames } = orgScoped;
  const src = readFileSync(filePath, "utf8");
  const sf = ts.createSourceFile(
    filePath,
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations = [];

  function record(node, op, table, reason) {
    const line = methodIdentLine(sf, node);
    const character = methodIdentColumn(sf, node);
    violations.push({
      file: path.relative(REPO_ROOT, filePath),
      line: line + 1,
      column: character + 1,
      op,
      table,
      reason,
    });
  }

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const m = methodName(node);

      // (a) Drizzle query-builder: from / update / delete on org-
      //     scoped table identifier.
      if (m === "from" || m === "update" || m === "delete") {
        const arg = node.arguments[0];
        if (arg && ts.isIdentifier(arg) && identNames.has(arg.text)) {
          const tableIdent = arg.text;
          if (!hasAllowComment(sf, node)) {
            const chain = collectChain(node);
            const whereCall = findWhereCall(chain);
            const body = enclosingFunctionBody(node);
            const ok =
              whereCall &&
              whereCall.arguments.length > 0 &&
              whereSatisfiesOrgScope(
                whereCall.arguments[0],
                tableIdent,
                body,
              );
            if (!ok) {
              record(
                node,
                m,
                tableIdent,
                whereCall
                  ? `WHERE clause does not reference ${tableIdent}.organizationId`
                  : `query on org-scoped table has no .where(...) clause`,
              );
            }
          }
        }
      }

      // (b) Drizzle relational API: db.query.<table>.findFirst /
      //     findMany on org-scoped table identifier.
      if (m === "findFirst" || m === "findMany") {
        const info = isDbQueryRelationalCall(node);
        if (info && identNames.has(info.tableIdent)) {
          if (!hasAllowComment(sf, node)) {
            if (!dbQueryWhereSatisfiesOrgScope(node)) {
              record(
                node,
                info.method,
                info.tableIdent,
                `db.query.${info.tableIdent}.${info.method}(...) does not constrain by .organizationId`,
              );
            }
          }
        }
      }

      // (c) Raw SQL: <expr>.execute(sql`…`).
      if (m === "execute") {
        const arg = node.arguments[0];
        if (
          arg &&
          ts.isTaggedTemplateExpression(arg) &&
          tagIsSql(arg.tag)
        ) {
          const text = templateText(arg.template);
          const matched = rawSqlMentionsOrgScopedTable(text, sqlNames);
          if (matched && !rawSqlHasOrgIdPredicate(text)) {
            if (!hasAllowComment(sf, node)) {
              record(
                node,
                "execute",
                matched,
                `raw SQL touches org-scoped table "${matched}" without an organization_id predicate`,
              );
            }
          }
        }
      }
    }
    node.forEachChild(visit);
  }
  visit(sf);
  return violations;
}

// ── Step 3: drive the check ───────────────────────────────────────────

async function main() {
  const orgScoped = await discoverOrgScopedTables();
  if (orgScoped.identNames.size === 0) {
    console.error(
      "check-org-scope: could not find any org-scoped tables in lib/db/src/schema. " +
        "Did the schema layout change?",
    );
    process.exit(2);
  }
  const consumers = await discoverDbConsumers();
  if (consumers.length === 0) {
    console.error(
      `check-org-scope: no workspace package depends on ${DB_PACKAGE_NAME}. ` +
        "Did the workspace layout change?",
    );
    process.exit(2);
  }
  let totalFiles = 0;
  let total = 0;
  for (const c of consumers) {
    const files = await listSourceFiles(c.srcDir);
    totalFiles += files.length;
    for (const f of files) {
      const violations = checkFile(f, orgScoped);
      for (const v of violations) {
        console.log(
          `${v.file}:${v.line}:${v.column}  ${v.op}(${v.table}) — ${v.reason}`,
        );
        total++;
      }
    }
  }
  if (total > 0) {
    console.log("");
    console.log(
      `check-org-scope: found ${total} potential org-scope leak${
        total === 1 ? "" : "s"
      }.`,
    );
    console.log(
      "Add an org-scope predicate (eq(<table>.organizationId, …) for Drizzle\n" +
        "queries, or `WHERE organization_id = …` in raw SQL), or, if the query\n" +
        "intentionally crosses tenants (super-admin / webhook / OAuth state\n" +
        "lookup / auth bootstrap / lookup by globally unique UUID), prefix the\n" +
        "offending line with a `// org-scope-allow: <reason>` comment.",
    );
    process.exit(1);
  }
  const consumerNames = consumers.map((c) => c.name).join(", ");
  console.log(
    `check-org-scope: ok (${totalFiles} files across ${consumers.length} package${
      consumers.length === 1 ? "" : "s"
    } [${consumerNames}], ${orgScoped.identNames.size} org-scoped tables checked).`,
  );
}

// Only run the CLI when invoked directly (`node check-org-scope.mjs`).
// When the file is imported (e.g. from a unit test), skip main() so the
// importer can exercise the small pure helpers without scanning the
// entire workspace or triggering process.exit().
const __isCli = (() => {
  try {
    return (
      process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
    );
  } catch {
    return false;
  }
})();

if (__isCli) {
  main().catch((err) => {
    console.error("check-org-scope: fatal error", err);
    process.exit(2);
  });
}

// Test-only surface. Not part of the CLI contract; exported solely so
// `test/lib/checkOrgScope.test.ts` can assert the behaviour of the
// small pure helpers without spawning a child process or scanning the
// entire workspace. Keep this list minimal — anything exposed here
// becomes a contract another file may rely on.
export const __testOnly = {
  ORG_ID_PREDICATE_RE,
  stripSqlComments,
  rawSqlHasOrgIdPredicate,
  rawSqlMentionsOrgScopedTable,
  checkFile,
  discoverOrgScopedTables,
};
