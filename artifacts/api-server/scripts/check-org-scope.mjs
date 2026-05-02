#!/usr/bin/env node
// Org-scope lint: every drizzle query against an org-scoped table must
// filter by `<table>.organizationId`.
//
// Catches the class of bug where a route forgets to add
// `eq(<table>.organizationId, t.organizationId)` to its WHERE clause and
// therefore silently returns / mutates rows from other tenants.
//
// Statically detected by walking the api-server source with the
// TypeScript compiler API:
//
//   1. Parse `lib/db/src/schema/*.ts` to learn which `<xxxTable>`
//      identifiers refer to a Postgres table that has an `organizationId`
//      column. Those are the org-scoped tables.
//
//   2. Walk every `.ts` file under `artifacts/api-server/src/`. For each
//      method-call chain that contains `.from(<orgScopedTable>)`,
//      `.update(<orgScopedTable>)` or `.delete(<orgScopedTable>)`, find
//      the matching `.where(...)` in the same chain and verify the
//      WHERE expression mentions `<orgScopedTable>.organizationId`.
//
//   3. Anything that legitimately needs to query across tenants (super-
//      admin dashboards, webhooks that arrive without auth, OAuth state
//      lookups, the auth bootstrap itself) must opt in explicitly with
//      a `// org-scope-allow: <reason>` comment on or just above the
//      offending `.from(...)` / `.update(...)` / `.delete(...)` line.
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
const SRC_DIR = path.join(REPO_ROOT, "artifacts/api-server/src");

const ALLOW_MARKER = "org-scope-allow";
const ALLOW_LOOKBACK_LINES = 3;

// ── Step 1: discover org-scoped tables from schema files ──────────────

async function discoverOrgScopedTables() {
  const files = (await fs.readdir(SCHEMA_DIR))
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .map((f) => path.join(SCHEMA_DIR, f));
  const orgScoped = new Set();
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
        const cols = decl.initializer.arguments[1];
        if (!cols || !ts.isObjectLiteralExpression(cols)) continue;
        const hasOrgId = cols.properties.some(
          (p) =>
            ts.isPropertyAssignment(p) &&
            ts.isIdentifier(p.name) &&
            p.name.text === "organizationId",
        );
        if (hasOrgId) orgScoped.add(decl.name.text);
      }
    });
  }
  return orgScoped;
}

// ── Step 2: walk source files and check call chains ───────────────────

async function listSourceFiles(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listSourceFiles(full)));
    } else if (e.isFile() && e.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function isMethodCallNamed(node, name) {
  if (!ts.isCallExpression(node)) return false;
  const e = node.expression;
  return (
    ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.name) &&
    e.name.text === name
  );
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

// True if `expr` directly references `<tableIdent>.organizationId`
// anywhere in its subtree (no identifier resolution).
function mentionsOrganizationIdDirect(expr, tableIdent) {
  let found = false;
  function visit(n) {
    if (found || !n) return;
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === tableIdent &&
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

// Returns the line (0-indexed) of the `from` / `update` / `delete`
// identifier itself — not the chain head. That gives the developer a
// stable place to attach a `// org-scope-allow: ...` comment that
// won't drift if unrelated lines above the chain change.
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

// Returns a list of violations for one source file.
function checkFile(filePath, orgScopedTables) {
  const src = readFileSync(filePath, "utf8");
  const sf = ts.createSourceFile(
    filePath,
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations = [];

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const m = methodName(node);
      if (m === "from" || m === "update" || m === "delete") {
        const arg = node.arguments[0];
        if (arg && ts.isIdentifier(arg) && orgScopedTables.has(arg.text)) {
          const tableIdent = arg.text;
          if (!hasAllowComment(sf, node)) {
            const chain = collectChain(node);
            const whereCall = findWhereCall(chain);
            // Strict check: the WHERE argument expression — after
            // bounded resolution of any local identifiers it
            // references inside the enclosing function — must
            // constrain the query by `<table>.organizationId`.
            // No whole-function-body fallback.
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
              const line = methodIdentLine(sf, node);
              const character = methodIdentColumn(sf, node);
              violations.push({
                file: path.relative(REPO_ROOT, filePath),
                line: line + 1,
                column: character + 1,
                op: m,
                table: tableIdent,
                reason: whereCall
                  ? `WHERE clause does not reference ${tableIdent}.organizationId`
                  : `query on org-scoped table has no .where(...) clause`,
              });
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
  const orgScopedTables = await discoverOrgScopedTables();
  if (orgScopedTables.size === 0) {
    console.error(
      "check-org-scope: could not find any org-scoped tables in lib/db/src/schema. " +
        "Did the schema layout change?",
    );
    process.exit(2);
  }
  const files = await listSourceFiles(SRC_DIR);
  let total = 0;
  for (const f of files) {
    const violations = checkFile(f, orgScopedTables);
    for (const v of violations) {
      console.log(
        `${v.file}:${v.line}:${v.column}  ${v.op}(${v.table}) — ${v.reason}`,
      );
      total++;
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
      "Add `eq(<table>.organizationId, ...)` to the WHERE clause, or, if the\n" +
        "query intentionally crosses tenants (super-admin / webhook / OAuth\n" +
        "state lookup / auth bootstrap), prefix the offending line with a\n" +
        "`// org-scope-allow: <reason>` comment.",
    );
    process.exit(1);
  }
  console.log(
    `check-org-scope: ok (${files.length} files, ${orgScopedTables.size} org-scoped tables checked).`,
  );
}

main().catch((err) => {
  console.error("check-org-scope: fatal error", err);
  process.exit(2);
});
