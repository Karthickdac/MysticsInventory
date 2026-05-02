// Self-contained in-memory database simulator that mirrors the slice
// of Drizzle's API the inventory routes actually exercise. It is
// purpose-built for cross-tenant isolation tests where we need real
// behaviour (WHERE filters, joins, RETURNING, transactions) instead
// of the queue-based stub used elsewhere.
//
// To keep the surface tractable we only implement what these routes
// touch: select with optional join + projection, insert/update/delete
// with returning, asc/desc/limit, groupBy with the small set of sql
// aggregate templates used (COUNT(*), COALESCE(SUM(col), 0), …), and
// the drizzle helpers (eq, ne, and, or, inArray, isNull, isNotNull,
// gt, lt, gte, lte, ilike, sql template). The sql tagged-template
// support is intentionally narrow — it recognises only the literal
// patterns the tested routes use, and throws loudly on anything else
// so a future change can't silently bypass filtering.
//
// Tables and column metadata are exposed via Proxy "table sentinels"
// that produce `{__table, __column}` references on attribute access,
// matching the shape of the existing mockModules helper. Aliased
// self-joins use `sql.identifier(name)` to emit `{__identifier}`
// references, and the join target is parsed out of the
// `${tableRef} AS ${sql.identifier(...)}` template literal.

interface ColumnRef {
  __table: string;
  __column: string;
}

interface TableRef {
  __table: string;
  __isTable: true;
}

interface IdentifierRef {
  __identifier: string;
}

interface SqlExpr {
  __sql: true;
  parts: readonly string[];
  values: unknown[];
}

type Expr =
  | { kind: "eq"; args: [unknown, unknown] }
  | { kind: "ne"; args: [unknown, unknown] }
  | { kind: "and"; args: Expr[] }
  | { kind: "or"; args: Expr[] }
  | { kind: "inArray"; args: [ColumnRef, unknown[]] }
  | { kind: "isNull"; args: [ColumnRef] }
  | { kind: "isNotNull"; args: [ColumnRef] }
  | { kind: "lt"; args: [ColumnRef, unknown] }
  | { kind: "gt"; args: [ColumnRef, unknown] }
  | { kind: "lte"; args: [ColumnRef, unknown] }
  | { kind: "gte"; args: [ColumnRef, unknown] }
  | { kind: "ilike"; args: [ColumnRef, string] }
  | { kind: "sql"; sql: SqlExpr };

type AnyRow = Record<string, unknown>;
type JoinedRow = Record<string, AnyRow>;

function isColumnRef(v: unknown): v is ColumnRef {
  return (
    typeof v === "object" &&
    v !== null &&
    "__column" in (v as Record<string, unknown>) &&
    "__table" in (v as Record<string, unknown>)
  );
}

function isTableRef(v: unknown): v is TableRef {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<string, unknown>).__isTable === true
  );
}

function isIdentifierRef(v: unknown): v is IdentifierRef {
  return (
    typeof v === "object" &&
    v !== null &&
    "__identifier" in (v as Record<string, unknown>)
  );
}

function isSqlExpr(v: unknown): v is SqlExpr {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<string, unknown>).__sql === true
  );
}

function tableSentinel(name: string): TableRef {
  const target: TableRef = { __table: name, __isTable: true };
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t)
        return (t as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof prop === "symbol") return undefined;
      // Drizzle exposes a few synthetic helpers like `$inferSelect`
      // that routes only ever use as TS type carriers — at runtime
      // they should resolve to a harmless empty object.
      if (String(prop).startsWith("$")) return {};
      return { __table: name, __column: String(prop) } as ColumnRef;
    },
  }) as TableRef;
}

// ──────────────────────────────────────────────────────────────────
// Drizzle helper replacements. Each one returns a tagged AST node
// the in-memory query engine knows how to evaluate.
// ──────────────────────────────────────────────────────────────────

const sqlFn = (
  parts: TemplateStringsArray | readonly string[],
  ...values: unknown[]
): SqlExpr => ({
  __sql: true,
  parts: parts as readonly string[],
  values,
});

(sqlFn as unknown as { identifier: (name: string) => IdentifierRef }).identifier = (
  name: string,
) => ({ __identifier: name });

export const inMemoryDrizzleOrmMock = {
  eq: (a: unknown, b: unknown): Expr => ({ kind: "eq", args: [a, b] }),
  ne: (a: unknown, b: unknown): Expr => ({ kind: "ne", args: [a, b] }),
  and: (...args: unknown[]): Expr => ({
    kind: "and",
    args: args.filter((a) => a !== undefined) as Expr[],
  }),
  or: (...args: unknown[]): Expr => ({
    kind: "or",
    args: args.filter((a) => a !== undefined) as Expr[],
  }),
  inArray: (col: ColumnRef, vals: unknown[]): Expr => ({
    kind: "inArray",
    args: [col, vals],
  }),
  isNull: (col: ColumnRef): Expr => ({ kind: "isNull", args: [col] }),
  isNotNull: (col: ColumnRef): Expr => ({ kind: "isNotNull", args: [col] }),
  gt: (col: ColumnRef, v: unknown): Expr => ({ kind: "gt", args: [col, v] }),
  lt: (col: ColumnRef, v: unknown): Expr => ({ kind: "lt", args: [col, v] }),
  gte: (col: ColumnRef, v: unknown): Expr => ({ kind: "gte", args: [col, v] }),
  lte: (col: ColumnRef, v: unknown): Expr => ({ kind: "lte", args: [col, v] }),
  ilike: (col: ColumnRef, v: string): Expr => ({
    kind: "ilike",
    args: [col, String(v)],
  }),
  asc: (col: ColumnRef) => ({ __order: "asc" as const, col }),
  desc: (col: ColumnRef) => ({ __order: "desc" as const, col }),
  // count() / sum() are exposed for routes that import them, but tests
  // currently express aggregates through `sql<string>\`COUNT(*)\``
  // templates. These helpers therefore just forward through to a
  // tagged sql expression so the projection evaluator handles them.
  count: (col?: ColumnRef): SqlExpr =>
    col ? sqlFn(["COUNT(", ")"], col) : sqlFn(["COUNT(*)"]),
  sum: (col: ColumnRef): SqlExpr =>
    sqlFn(["COALESCE(SUM(", "), 0)"], col),
  sql: sqlFn,
};

// ──────────────────────────────────────────────────────────────────
// Lookup helpers. Joined queries store rows under their table name
// (`{job_work_orders: {...}, suppliers: {...}}`); single-table queries
// keep the row flat. Aliased self-joins use the alias as the key.
// ──────────────────────────────────────────────────────────────────

function lookupColumn(
  row: AnyRow | JoinedRow,
  col: ColumnRef,
): unknown {
  const joined = (row as JoinedRow)[col.__table];
  if (joined && typeof joined === "object") return joined[col.__column];
  return (row as AnyRow)[col.__column];
}

function lookupAliasColumn(
  row: AnyRow | JoinedRow,
  alias: string,
  column: string,
): unknown {
  const joined = (row as JoinedRow)[alias];
  if (joined && typeof joined === "object") return joined[column];
  return undefined;
}

function resolveValue(v: unknown, row: AnyRow | JoinedRow): unknown {
  if (isColumnRef(v)) return lookupColumn(row, v);
  return v;
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  // Numeric columns come back as strings from drizzle-pg, so normalise
  // either side when one looks numeric and the other doesn't.
  if (typeof a === "number" || typeof b === "number") {
    const na = typeof a === "number" ? a : Number(a);
    const nb = typeof b === "number" ? b : Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  }
  return String(a) === String(b);
}

function compareScalar(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  // Prefer numeric comparison when both sides parse as finite numbers.
  // Falls back to lexicographic string comparison so ISO date strings
  // (`2026-01-31` vs `2026-02-01`) sort correctly.
  const na = typeof a === "number" ? a : Number(a);
  const nb = typeof b === "number" ? b : Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) {
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  const sa = String(a);
  const sb = String(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

function ilikeMatch(value: unknown, pattern: string): boolean {
  if (value == null) return false;
  // SQL ILIKE: % is wildcard, _ matches single char, case-insensitive.
  const str = String(value).toLowerCase();
  const escaped = pattern
    .toLowerCase()
    .replace(/[.+^$(){}|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");
  return new RegExp(`^${escaped}$`).test(str);
}

function evaluateExpr(
  expr: Expr | SqlExpr | undefined,
  row: AnyRow | JoinedRow,
): boolean {
  if (!expr) return true;
  // Raw sql template literals embedded directly in `and(...)` (e.g.
  // `and(eq(...), sql\`status NOT IN ('a','b')\`)`) arrive here as
  // bare SqlExpr nodes without a `kind` discriminator. Dispatch them
  // to the predicate evaluator so they participate in WHERE filtering
  // instead of silently passing as `true`.
  if (isSqlExpr(expr)) return evaluateSqlPredicate(expr, row);
  switch (expr.kind) {
    case "eq":
      return looseEquals(
        resolveValue(expr.args[0], row),
        resolveValue(expr.args[1], row),
      );
    case "ne":
      return !looseEquals(
        resolveValue(expr.args[0], row),
        resolveValue(expr.args[1], row),
      );
    case "and":
      return expr.args.every((a) => evaluateExpr(a, row));
    case "or":
      return expr.args.some((a) => evaluateExpr(a, row));
    case "inArray": {
      const lhs = resolveValue(expr.args[0], row);
      return (expr.args[1] ?? []).some((v) => looseEquals(lhs, v));
    }
    case "isNull":
      return resolveValue(expr.args[0], row) == null;
    case "isNotNull":
      return resolveValue(expr.args[0], row) != null;
    case "gt":
      return compareScalar(resolveValue(expr.args[0], row), expr.args[1]) > 0;
    case "lt":
      return compareScalar(resolveValue(expr.args[0], row), expr.args[1]) < 0;
    case "gte":
      return compareScalar(resolveValue(expr.args[0], row), expr.args[1]) >= 0;
    case "lte":
      return compareScalar(resolveValue(expr.args[0], row), expr.args[1]) <= 0;
    case "ilike":
      return ilikeMatch(resolveValue(expr.args[0], row), expr.args[1]);
    case "sql":
      return evaluateSqlPredicate(expr.sql, row);
    default:
      return true;
  }
}

// Render a sql template to a single string with `§` placeholders for
// each interpolated value, so we can pattern-match on the literal text.
function sqlSkeleton(s: SqlExpr): string {
  return s.parts
    .map((p, i) => p + (i < s.values.length ? "§" : ""))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

// Recognise the literal patterns the tested routes use as WHERE
// clauses. Anything else is rejected loudly so a future change can't
// silently bypass filtering.
function evaluateSqlPredicate(s: SqlExpr, row: AnyRow | JoinedRow): boolean {
  const sk = sqlSkeleton(s);
  // ${col} > 0 (and similar numeric literal compares)
  let m = sk.match(/^§\s*>\s*(-?\d+(?:\.\d+)?)$/);
  if (m && isColumnRef(s.values[0])) {
    const v = Number(lookupColumn(row, s.values[0]));
    return Number.isFinite(v) && v > Number(m[1]);
  }
  m = sk.match(/^§\s*>=\s*(-?\d+(?:\.\d+)?)$/);
  if (m && isColumnRef(s.values[0])) {
    const v = Number(lookupColumn(row, s.values[0]));
    return Number.isFinite(v) && v >= Number(m[1]);
  }
  m = sk.match(/^§\s*<=\s*(-?\d+(?:\.\d+)?)$/);
  if (m && isColumnRef(s.values[0])) {
    const v = Number(lookupColumn(row, s.values[0]));
    return Number.isFinite(v) && v <= Number(m[1]);
  }
  // ${col} >= ${literal} (col-vs-string-literal date or numeric)
  m = sk.match(/^§\s*>=\s*§$/);
  if (m && isColumnRef(s.values[0])) {
    const a = lookupColumn(row, s.values[0]);
    const b = s.values[1];
    if (a == null || b == null) return false;
    return compareScalar(a, b) >= 0;
  }
  // ${col} <= ${literal}
  m = sk.match(/^§\s*<=\s*§$/);
  if (m && isColumnRef(s.values[0])) {
    const a = lookupColumn(row, s.values[0]);
    const b = s.values[1];
    if (a == null || b == null) return false;
    return compareScalar(a, b) <= 0;
  }
  // ${col} IS NULL
  if (/^§\s+IS\s+NULL$/i.test(sk) && isColumnRef(s.values[0])) {
    return lookupColumn(row, s.values[0]) == null;
  }
  // ${col} IS NOT NULL
  if (/^§\s+IS\s+NOT\s+NULL$/i.test(sk) && isColumnRef(s.values[0])) {
    return lookupColumn(row, s.values[0]) != null;
  }
  // ${col} IN ('a','b',...) — literal status list
  m = sk.match(/^§\s+IN\s*\(([^)]+)\)$/i);
  if (m && isColumnRef(s.values[0])) {
    const list = m[1]
      .split(",")
      .map((t) => t.trim().replace(/^'(.*)'$/, "$1"));
    const v = lookupColumn(row, s.values[0]);
    return list.some((item) => looseEquals(v, item));
  }
  // ${col} NOT IN ('a','b',...) — literal status exclusion list
  m = sk.match(/^§\s+NOT\s+IN\s*\(([^)]+)\)$/i);
  if (m && isColumnRef(s.values[0])) {
    const list = m[1]
      .split(",")
      .map((t) => t.trim().replace(/^'(.*)'$/, "$1"));
    const v = lookupColumn(row, s.values[0]);
    return !list.some((item) => looseEquals(v, item));
  }
  // ${col} <> 'literal'
  m = sk.match(/^§\s*<>\s*'([^']*)'$/);
  if (m && isColumnRef(s.values[0])) {
    return !looseEquals(lookupColumn(row, s.values[0]), m[1]);
  }
  // lower(${col}) = lower(${val})  — used by tenant.ts email lookup
  if (/^lower\(§\)\s*=\s*lower\(§\)$/i.test(sk) && isColumnRef(s.values[0])) {
    const a = String(lookupColumn(row, s.values[0]) ?? "").toLowerCase();
    const b = String(s.values[1] ?? "").toLowerCase();
    return a === b;
  }
  // ${alias}.id = ${col} — aliased self-join condition
  m = sk.match(/^§\.([a-zA-Z_]+)\s*=\s*§$/);
  if (m && isIdentifierRef(s.values[0]) && isColumnRef(s.values[1])) {
    const aliasVal = lookupAliasColumn(row, s.values[0].__identifier, m[1]);
    const colVal = lookupColumn(row, s.values[1]);
    return looseEquals(aliasVal, colVal);
  }
  throw new Error(`Unrecognised sql predicate in test: ${sk}`);
}

// SET expressions: `${col} + ${literal}::numeric`, `${col} - ${literal}`,
// etc. Both add (signed) the literal to the existing column value.
function evaluateSqlSet(s: SqlExpr, row: AnyRow): unknown {
  const sk = sqlSkeleton(s);
  const m = sk.match(/^§\s*([+\-])\s*§(::[a-z]+)?$/);
  if (m && isColumnRef(s.values[0])) {
    const op = m[1];
    const cur = Number(row[s.values[0].__column] ?? 0);
    const delta = Number(s.values[1] ?? 0);
    const result = op === "+" ? cur + delta : cur - delta;
    return String(result);
  }
  throw new Error(`Unrecognised sql SET expression in test: ${sk}`);
}

// Projection-side aggregate evaluator. Called only when groupBy is in
// effect (otherwise sql expressions in projections fall through to the
// "0" default). Evaluates against the rows in the current group.
function evaluateSqlAggregate(
  s: SqlExpr,
  groupRows: JoinedRow[],
): unknown {
  const sk = sqlSkeleton(s);
  // COUNT(*) optionally with a cast suffix
  if (/^COUNT\(\*\)(::\w+)?$/i.test(sk)) return String(groupRows.length);
  // COUNT(*) FILTER (WHERE ${col} IS NOT NULL)::int
  let mF = sk.match(/^COUNT\(\*\)\s+FILTER\s*\(\s*WHERE\s+§\s+IS\s+NOT\s+NULL\s*\)(::\w+)?$/i);
  if (mF && isColumnRef(s.values[0])) {
    const col = s.values[0];
    return String(
      groupRows.filter((r) => lookupColumn(r, col) != null).length,
    );
  }
  // COUNT(*) FILTER (WHERE ${col} IS NULL)::int
  mF = sk.match(/^COUNT\(\*\)\s+FILTER\s*\(\s*WHERE\s+§\s+IS\s+NULL\s*\)(::\w+)?$/i);
  if (mF && isColumnRef(s.values[0])) {
    const col = s.values[0];
    return String(
      groupRows.filter((r) => lookupColumn(r, col) == null).length,
    );
  }
  // COUNT(${col}) — non-null count
  let m = sk.match(/^COUNT\(§\)(::\w+)?$/i);
  if (m && isColumnRef(s.values[0])) {
    const col = s.values[0];
    return String(
      groupRows.filter((r) => lookupColumn(r, col) != null).length,
    );
  }
  // COALESCE(SUM(${col}), 0) and ::numeric variants
  m = sk.match(/^COALESCE\(SUM\(§(::\w+)?\),\s*0\)(::\w+)?$/i);
  if (m && isColumnRef(s.values[0])) {
    const col = s.values[0];
    const sum = groupRows.reduce(
      (acc, r) => acc + Number(lookupColumn(r, col) ?? 0),
      0,
    );
    return String(sum);
  }
  // COALESCE(SUM(${a} * ${b}), 0)
  m = sk.match(/^COALESCE\(SUM\(§(::\w+)?\s*\*\s*§(::\w+)?\),\s*0\)(::\w+)?$/i);
  if (m && isColumnRef(s.values[0]) && isColumnRef(s.values[1])) {
    const colA = s.values[0];
    const colB = s.values[1];
    const sum = groupRows.reduce(
      (acc, r) =>
        acc +
        Number(lookupColumn(r, colA) ?? 0) *
          Number(lookupColumn(r, colB) ?? 0),
      0,
    );
    return String(sum);
  }
  // SUM(${col}) without coalesce
  m = sk.match(/^SUM\(§(::\w+)?\)(::\w+)?$/i);
  if (m && isColumnRef(s.values[0])) {
    const col = s.values[0];
    const sum = groupRows.reduce(
      (acc, r) => acc + Number(lookupColumn(r, col) ?? 0),
      0,
    );
    return String(sum);
  }
  throw new Error(`Unrecognised sql aggregate in projection: ${sk}`);
}

// Projection-side scalar evaluator (used in non-groupBy selects too).
// Currently just supports the alias-column shorthand
// `${sql.identifier(alias)}.name` produced by stockTransfers' aliased
// warehouse self-joins.
function evaluateSqlScalar(s: SqlExpr, row: JoinedRow): unknown {
  const sk = sqlSkeleton(s);
  const m = sk.match(/^§\.([a-zA-Z_]+)$/);
  if (m && isIdentifierRef(s.values[0])) {
    return lookupAliasColumn(row, s.values[0].__identifier, m[1]);
  }
  // Fall through to the aggregate evaluator with a single-row "group"
  // so simple SUM / COUNT in a non-groupBy projection still works.
  return evaluateSqlAggregate(s, [row]);
}

// True when a sql template in a projection is an aggregate (COUNT, SUM,
// COALESCE(SUM,0), ...). Used by runSelect to collapse all matching rows
// into a single "group" when the query has aggregates but no groupBy.
function isAggregateSql(s: SqlExpr): boolean {
  const sk = sqlSkeleton(s);
  return /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(sk);
}

// Recognise `${tableRef} AS ${sql.identifier(alias)}` for aliased
// self-joins. Returns { table, alias } or null.
function parseAliasedJoinTarget(
  s: SqlExpr,
): { table: TableRef; alias: string } | null {
  const sk = sqlSkeleton(s);
  if (/^§\s+AS\s+§$/i.test(sk)) {
    const t = s.values[0];
    const a = s.values[1];
    if (isTableRef(t) && isIdentifierRef(a)) {
      return { table: t, alias: a.__identifier };
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────
// Query plan + executor
// ──────────────────────────────────────────────────────────────────

interface JoinSpec {
  table: TableRef;
  alias?: string;
  on: Expr | SqlExpr;
}

interface OrderSpec {
  col: ColumnRef;
  dir: "asc" | "desc";
}

interface SelectPlan {
  projection: Record<string, unknown> | undefined;
  table?: TableRef;
  joins: JoinSpec[];
  where?: Expr;
  order: OrderSpec[];
  limit?: number;
  groupBy: ColumnRef[];
  having?: Expr;
}

interface UpdatePlan {
  table: TableRef;
  setObj?: Record<string, unknown>;
  where?: Expr;
  returning?: Record<string, unknown>;
}

interface InsertPlan {
  table: TableRef;
  rows?: AnyRow[];
  returning?: Record<string, unknown>;
  conflictDoNothing?: boolean;
}

interface DeletePlan {
  table: TableRef;
  where?: Expr;
  returning?: Record<string, unknown>;
}

class Thenable<T> {
  constructor(private executor: () => T | Promise<T>) {}
  then<R1 = T, R2 = never>(
    onFulfilled?: (v: T) => R1 | Promise<R1>,
    onRejected?: (e: unknown) => R2 | Promise<R2>,
  ): Promise<R1 | R2> {
    return Promise.resolve()
      .then(() => this.executor())
      .then(onFulfilled ?? undefined, onRejected ?? undefined);
  }
  catch<R = never>(onRejected?: (e: unknown) => R | Promise<R>) {
    return this.then(undefined, onRejected);
  }
  finally(onFinally?: () => void) {
    return this.then(
      (v) => {
        onFinally?.();
        return v;
      },
      (e) => {
        onFinally?.();
        throw e;
      },
    );
  }
}

export class InMemoryDb {
  private store: Map<string, AnyRow[]> = new Map();
  private nextId: Map<string, number> = new Map();

  reset() {
    this.store.clear();
    this.nextId.clear();
  }

  rowsOf(table: string): AnyRow[] {
    let r = this.store.get(table);
    if (!r) {
      r = [];
      this.store.set(table, r);
    }
    return r;
  }

  // Direct seeding helper for tests. Bypasses route handlers and
  // returns the inserted row (id auto-assigned if not provided).
  seed(table: TableRef | string, row: AnyRow): AnyRow {
    const name = typeof table === "string" ? table : table.__table;
    if (row.id == null) {
      const next = (this.nextId.get(name) ?? 0) + 1;
      this.nextId.set(name, next);
      row.id = next;
    } else {
      this.nextId.set(
        name,
        Math.max(this.nextId.get(name) ?? 0, Number(row.id)),
      );
    }
    if (!("createdAt" in row)) row.createdAt = new Date();
    this.rowsOf(name).push(row);
    return row;
  }

  // ──────────────────────────────────────────────────────────────
  // Public chainable API matching drizzle's surface
  // ──────────────────────────────────────────────────────────────

  select(projection?: Record<string, unknown>) {
    const plan: SelectPlan = {
      projection,
      joins: [],
      order: [],
      groupBy: [],
    };
    return this.makeSelectChain(plan);
  }

  update(table: TableRef) {
    const plan: UpdatePlan = { table };
    return this.makeUpdateChain(plan);
  }

  insert(table: TableRef) {
    const plan: InsertPlan = { table };
    return this.makeInsertChain(plan);
  }

  delete(table: TableRef) {
    const plan: DeletePlan = { table };
    return this.makeDeleteChain(plan);
  }

  async transaction<T>(cb: (tx: InMemoryDb) => Promise<T>): Promise<T> {
    return await cb(this);
  }

  // tx.execute(sql\`SELECT … FOR UPDATE\`) — recognises only the
  // single-row org-scoped lock pattern used by customerPayments /
  // supplierPayments delete handlers. Returns `{ rows: […] }` so the
  // route's `.then((r) => r.rows ?? r)` shape is satisfied.
  async execute(s?: SqlExpr): Promise<{ rows: AnyRow[] }> {
    if (!s || !isSqlExpr(s)) return { rows: [] };
    const sk = sqlSkeleton(s);
    // Pattern: SELECT col1, col2, ... FROM § WHERE id = § AND organization_id = § FOR UPDATE
    const m = sk.match(
      /^SELECT\s+(.+?)\s+FROM\s+§\s+WHERE\s+id\s*=\s*§\s+AND\s+organization_id\s*=\s*§\s+FOR\s+UPDATE$/i,
    );
    if (m && isTableRef(s.values[0])) {
      const cols = m[1].split(",").map((c) => c.trim());
      const id = s.values[1];
      const orgId = s.values[2];
      const rows = this.rowsOf(s.values[0].__table)
        .filter(
          (r) => looseEquals(r.id, id) && looseEquals(r.organizationId, orgId),
        )
        .map((r) => {
          const out: AnyRow = {};
          for (const c of cols) {
            // Map snake_case sql column names to camelCase row keys.
            const camel = c.replace(/_([a-z])/g, (_, g: string) =>
              g.toUpperCase(),
            );
            out[c] = r[camel] !== undefined ? r[camel] : r[c];
          }
          return out;
        });
      return { rows };
    }
    throw new Error(`Unrecognised sql in execute(): ${sk}`);
  }

  // ──────────────────────────────────────────────────────────────
  // Internal: chain builders
  // ──────────────────────────────────────────────────────────────

  private makeSelectChain(plan: SelectPlan): unknown {
    const self = this;
    const chain: Record<string, unknown> = {};
    chain.from = (table: TableRef) => {
      plan.table = table;
      return chain;
    };
    chain.innerJoin = (target: TableRef | SqlExpr, on: Expr | SqlExpr) => {
      if (isSqlExpr(target)) {
        const aliased = parseAliasedJoinTarget(target);
        if (!aliased) {
          throw new Error(
            `Unrecognised sql join target in test: ${sqlSkeleton(target)}`,
          );
        }
        plan.joins.push({ table: aliased.table, alias: aliased.alias, on });
      } else {
        plan.joins.push({ table: target, on });
      }
      return chain;
    };
    chain.leftJoin = chain.innerJoin;
    chain.where = (e: Expr) => {
      plan.where = e;
      return chain;
    };
    chain.orderBy = (
      ...args: Array<{ __order: "asc" | "desc"; col: ColumnRef } | ColumnRef>
    ) => {
      for (const a of args) {
        if (a && typeof a === "object" && "__order" in a) {
          plan.order.push({ col: a.col, dir: a.__order });
        } else if (isColumnRef(a)) {
          plan.order.push({ col: a, dir: "asc" });
        }
      }
      return chain;
    };
    chain.limit = (n: number) => {
      plan.limit = n;
      return chain;
    };
    chain.offset = () => chain;
    chain.for = () => chain; // for("update") is a no-op in single-thread tests.
    chain.groupBy = (...cols: ColumnRef[]) => {
      for (const c of cols) if (isColumnRef(c)) plan.groupBy.push(c);
      return chain;
    };
    chain.having = (e: Expr) => {
      plan.having = e;
      return chain;
    };
    const thenable = new Thenable(() => self.runSelect(plan));
    chain.then = thenable.then.bind(thenable);
    chain.catch = thenable.catch.bind(thenable);
    chain.finally = thenable.finally.bind(thenable);
    return chain;
  }

  private makeUpdateChain(plan: UpdatePlan): unknown {
    const self = this;
    const chain: Record<string, unknown> = {};
    chain.set = (s: Record<string, unknown>) => {
      plan.setObj = s;
      return chain;
    };
    chain.where = (e: Expr) => {
      plan.where = e;
      return chain;
    };
    chain.returning = (proj?: Record<string, unknown>) => {
      plan.returning = proj ?? {};
      return chain;
    };
    const thenable = new Thenable(() => self.runUpdate(plan));
    chain.then = thenable.then.bind(thenable);
    chain.catch = thenable.catch.bind(thenable);
    chain.finally = thenable.finally.bind(thenable);
    return chain;
  }

  private makeInsertChain(plan: InsertPlan): unknown {
    const self = this;
    const chain: Record<string, unknown> = {};
    chain.values = (v: AnyRow | AnyRow[]) => {
      plan.rows = Array.isArray(v) ? v : [v];
      return chain;
    };
    chain.returning = (proj?: Record<string, unknown>) => {
      plan.returning = proj ?? {};
      return chain;
    };
    chain.onConflictDoNothing = () => {
      plan.conflictDoNothing = true;
      return chain;
    };
    chain.onConflictDoUpdate = () => chain;
    const thenable = new Thenable(() => self.runInsert(plan));
    chain.then = thenable.then.bind(thenable);
    chain.catch = thenable.catch.bind(thenable);
    chain.finally = thenable.finally.bind(thenable);
    return chain;
  }

  private makeDeleteChain(plan: DeletePlan): unknown {
    const self = this;
    const chain: Record<string, unknown> = {};
    chain.where = (e: Expr) => {
      plan.where = e;
      return chain;
    };
    chain.returning = (proj?: Record<string, unknown>) => {
      plan.returning = proj ?? {};
      return chain;
    };
    const thenable = new Thenable(() => self.runDelete(plan));
    chain.then = thenable.then.bind(thenable);
    chain.catch = thenable.catch.bind(thenable);
    chain.finally = thenable.finally.bind(thenable);
    return chain;
  }

  // ──────────────────────────────────────────────────────────────
  // Internal: executors
  // ──────────────────────────────────────────────────────────────

  private runSelect(plan: SelectPlan): unknown[] {
    if (!plan.table) throw new Error("select() chain missing .from(table)");
    let rows: JoinedRow[] = this.rowsOf(plan.table.__table).map((r) => ({
      [plan.table!.__table]: r,
    }));
    for (const join of plan.joins) {
      const other = this.rowsOf(join.table.__table);
      const next: JoinedRow[] = [];
      const key = join.alias ?? join.table.__table;
      for (const left of rows) {
        for (const right of other) {
          const candidate: JoinedRow = { ...left, [key]: right };
          let matches: boolean;
          if (isSqlExpr(join.on)) {
            matches = evaluateSqlPredicate(join.on, candidate);
          } else {
            matches = evaluateExpr(join.on, candidate);
          }
          if (matches) next.push(candidate);
        }
      }
      rows = next;
    }
    rows = rows.filter((r) => evaluateExpr(plan.where, r));

    // GroupBy: bucket rows by the groupBy columns. Aggregates in the
    // projection are evaluated against each bucket; non-aggregate cols
    // pull from the first row of the bucket.
    let projectFn: (r: JoinedRow) => unknown;
    // Detect aggregate-only projections (e.g. `select({ c: sql\`COUNT(*)\` })`)
    // without an explicit groupBy. In real SQL that collapses the entire
    // result set into one row; we mirror that here so callers like
    // assertOwnership get the right total instead of one row per match.
    const projectionHasAggregate =
      plan.groupBy.length === 0 &&
      !!plan.projection &&
      Object.values(plan.projection).some(
        (v) => isSqlExpr(v) && isAggregateSql(v),
      );
    if (plan.groupBy.length > 0) {
      const groups = new Map<string, JoinedRow[]>();
      const order: string[] = [];
      for (const r of rows) {
        const key = plan.groupBy
          .map((c) => JSON.stringify(lookupColumn(r, c) ?? null))
          .join("|");
        const arr = groups.get(key);
        if (arr) arr.push(r);
        else {
          groups.set(key, [r]);
          order.push(key);
        }
      }
      const groupRows: JoinedRow[] = order.map((k) => {
        const bucket = groups.get(k)!;
        // Carry the bucket on the representative row so the projection
        // can see it (using a non-enumerable-ish private key).
        const repr = { ...bucket[0] } as JoinedRow & { __group?: JoinedRow[] };
        repr.__group = bucket;
        return repr;
      });
      rows = groupRows;
      projectFn = (r: JoinedRow) => {
        const bucket = (r as JoinedRow & { __group?: JoinedRow[] }).__group ?? [r];
        return projectGroup(plan, r, bucket);
      };
    } else if (projectionHasAggregate) {
      // Collapse all matching rows into a single synthetic row whose
      // projection is evaluated over the entire bucket.
      const bucket = rows;
      const repr = (rows[0] ?? {}) as JoinedRow;
      rows = [repr];
      projectFn = (r: JoinedRow) => projectGroup(plan, r, bucket);
    } else {
      projectFn = (r: JoinedRow) => projectGroup(plan, r, [r]);
    }

    for (const o of [...plan.order].reverse()) {
      rows.sort((a, b) => {
        const av = lookupColumn(a, o.col);
        const bv = lookupColumn(b, o.col);
        if (av == null && bv == null) return 0;
        if (av == null) return o.dir === "asc" ? -1 : 1;
        if (bv == null) return o.dir === "asc" ? 1 : -1;
        if (av < bv) return o.dir === "asc" ? -1 : 1;
        if (av > bv) return o.dir === "asc" ? 1 : -1;
        return 0;
      });
    }
    if (plan.limit != null) rows = rows.slice(0, plan.limit);

    return rows.map(projectFn);
  }

  private runUpdate(plan: UpdatePlan): unknown[] {
    const rows = this.rowsOf(plan.table.__table);
    const updated: AnyRow[] = [];
    for (const r of rows) {
      if (!evaluateExpr(plan.where, r)) continue;
      if (plan.setObj) {
        for (const [k, v] of Object.entries(plan.setObj)) {
          if (isSqlExpr(v)) r[k] = evaluateSqlSet(v, r);
          else r[k] = v;
        }
      }
      updated.push(r);
    }
    if (plan.returning !== undefined) {
      return updated.map((r) => projectRow(r, plan.returning!));
    }
    return updated;
  }

  private runInsert(plan: InsertPlan): unknown[] {
    if (!plan.rows) return [];
    const inserted: AnyRow[] = [];
    for (const raw of plan.rows) {
      const row = { ...raw };
      if (row.id == null) {
        const next = (this.nextId.get(plan.table.__table) ?? 0) + 1;
        this.nextId.set(plan.table.__table, next);
        row.id = next;
      } else {
        this.nextId.set(
          plan.table.__table,
          Math.max(this.nextId.get(plan.table.__table) ?? 0, Number(row.id)),
        );
      }
      if (!("createdAt" in row)) row.createdAt = new Date();
      this.rowsOf(plan.table.__table).push(row);
      inserted.push(row);
    }
    if (plan.returning !== undefined) {
      return inserted.map((r) => projectRow(r, plan.returning!));
    }
    return inserted;
  }

  private runDelete(plan: DeletePlan): unknown[] {
    const rows = this.rowsOf(plan.table.__table);
    const kept: AnyRow[] = [];
    const removed: AnyRow[] = [];
    for (const r of rows) {
      if (evaluateExpr(plan.where, r)) removed.push(r);
      else kept.push(r);
    }
    this.store.set(plan.table.__table, kept);
    if (plan.returning !== undefined) {
      return removed.map((r) => projectRow(r, plan.returning!));
    }
    return removed;
  }
}

function projectGroup(
  plan: SelectPlan,
  repr: JoinedRow,
  bucket: JoinedRow[],
): unknown {
  if (!plan.projection) {
    // Implicit `select()` returns the main table's full row.
    return repr[plan.table!.__table];
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(plan.projection)) {
    if (isColumnRef(val)) {
      out[key] = lookupColumn(repr, val);
    } else if (isTableRef(val)) {
      out[key] = repr[val.__table];
    } else if (isSqlExpr(val)) {
      // Aggregates always evaluate over the bucket (a real group, or a
      // synthetic single-group bucket the executor collapsed into when
      // the projection is aggregate-only without groupBy). Non-aggregate
      // sql expressions (e.g. aliased identifier projections) evaluate
      // per-row against the representative row.
      if (plan.groupBy.length > 0 || isAggregateSql(val)) {
        out[key] = evaluateSqlAggregate(val, bucket);
      } else {
        out[key] = evaluateSqlScalar(val, repr);
      }
    } else {
      out[key] = val;
    }
  }
  return out;
}

function projectRow(
  row: AnyRow,
  proj: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.keys(proj).length === 0) {
    // Empty projection (e.g. `.returning()` with no args) → full row.
    return { ...row };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(proj)) {
    if (isColumnRef(v)) out[k] = row[v.__column];
    else out[k] = v;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────
// Module-level fixture: a single shared in-memory DB plus the table
// sentinels the routes expect to be exported from `@workspace/db`.
// Test files use `vi.mock("@workspace/db", () => createInMemoryDbModuleMock())`.
// ──────────────────────────────────────────────────────────────────

export const memDb = new InMemoryDb();

export const tables = {
  organizationsTable: tableSentinel("organizations"),
  organizationMembersTable: tableSentinel("organization_members"),
  usersTable: tableSentinel("users"),
  teamInvitationsTable: tableSentinel("team_invitations"),
  customersTable: tableSentinel("customers"),
  suppliersTable: tableSentinel("suppliers"),
  itemsTable: tableSentinel("items"),
  itemBundleComponentsTable: tableSentinel("item_bundle_components"),
  itemWarehouseStockTable: tableSentinel("item_warehouse_stock"),
  itemBatchesTable: tableSentinel("item_batches"),
  itemBatchWarehouseStockTable: tableSentinel("item_batch_warehouse_stock"),
  itemBatchMovementsTable: tableSentinel("item_batch_movements"),
  warehousesTable: tableSentinel("warehouses"),
  stockMovementsTable: tableSentinel("stock_movements"),
  stockTransfersTable: tableSentinel("stock_transfers"),
  stockTransferLinesTable: tableSentinel("stock_transfer_lines"),
  jobWorkOrdersTable: tableSentinel("job_work_orders"),
  jobWorkOrderComponentsTable: tableSentinel("job_work_order_components"),
  jobWorkIssuesTable: tableSentinel("job_work_issues"),
  jobWorkIssueLinesTable: tableSentinel("job_work_issue_lines"),
  jobWorkReceiptsTable: tableSentinel("job_work_receipts"),
  jobWorkReceiptComponentsTable: tableSentinel("job_work_receipt_components"),
  purchaseOrdersTable: tableSentinel("purchase_orders"),
  purchaseOrderLinesTable: tableSentinel("purchase_order_lines"),
  goodsReceiptsTable: tableSentinel("goods_receipts"),
  goodsReceiptLinesTable: tableSentinel("goods_receipt_lines"),
  shipmentsTable: tableSentinel("shipments"),
  shipmentLinesTable: tableSentinel("shipment_lines"),
  customerPaymentsTable: tableSentinel("customer_payments"),
  customerPaymentAllocationsTable: tableSentinel(
    "customer_payment_allocations",
  ),
  supplierPaymentsTable: tableSentinel("supplier_payments"),
  supplierPaymentAllocationsTable: tableSentinel(
    "supplier_payment_allocations",
  ),
  salesOrdersTable: tableSentinel("sales_orders"),
  salesOrderLinesTable: tableSentinel("sales_order_lines"),
  einvoiceBulkBatchesTable: tableSentinel("einvoice_bulk_batches"),
  emailLogTable: tableSentinel("email_log"),
  paymentLinksTable: tableSentinel("payment_links"),
  shopifyOauthStatesTable: tableSentinel("shopify_oauth_states"),
  shopifyOutboxTable: tableSentinel("shopify_outbox"),
  shiprocketShipmentsTable: tableSentinel("shiprocket_shipments"),
};

export function createInMemoryDbModuleMock() {
  return {
    db: memDb,
    pool: { end: async () => undefined },
    ...tables,
  };
}
