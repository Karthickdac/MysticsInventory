// Self-contained in-memory database simulator that mirrors the slice
// of Drizzle's API the job-work-orders routes actually exercise. It is
// purpose-built for cross-tenant isolation tests where we need real
// behaviour (WHERE filters, joins, RETURNING, transactions) instead
// of the queue-based stub used elsewhere in this test suite.
//
// To keep the surface tractable we only implement what these routes
// touch: select with optional join + projection, insert/update/delete
// with returning, asc/desc/limit, and the small set of drizzle helpers
// (eq, ne, and, or, inArray, isNull, gt, lt, sql template). The sql
// tagged-template support is intentionally narrow — it recognises just
// the two patterns used by the JWO routes (numeric add/subtract with
// a ::numeric cast, and a `> 0` comparison in WHERE).
//
// Tables and column metadata are exposed via Proxy "table sentinels"
// that produce `{__table, __column}` references on attribute access,
// matching the shape of the existing mockModules helper.

interface ColumnRef {
  __table: string;
  __column: string;
}

interface TableRef {
  __table: string;
  __isTable: true;
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
  | { kind: "lt"; args: [ColumnRef, unknown] }
  | { kind: "gt"; args: [ColumnRef, unknown] }
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
      return { __table: name, __column: String(prop) } as ColumnRef;
    },
  }) as TableRef;
}

// ──────────────────────────────────────────────────────────────────
// Drizzle helper replacements. Each one returns a tagged AST node
// the in-memory query engine knows how to evaluate.
// ──────────────────────────────────────────────────────────────────

export const inMemoryDrizzleOrmMock = {
  eq: (a: unknown, b: unknown): Expr => ({ kind: "eq", args: [a, b] }),
  ne: (a: unknown, b: unknown): Expr => ({ kind: "ne", args: [a, b] }),
  and: (...args: unknown[]): Expr => ({
    kind: "and",
    args: args.filter((a) => a !== undefined) as Expr[],
  }),
  or: (...args: unknown[]): Expr => ({ kind: "or", args: args as Expr[] }),
  inArray: (col: ColumnRef, vals: unknown[]): Expr => ({
    kind: "inArray",
    args: [col, vals],
  }),
  isNull: (col: ColumnRef): Expr => ({ kind: "isNull", args: [col] }),
  gt: (col: ColumnRef, v: unknown): Expr => ({ kind: "gt", args: [col, v] }),
  lt: (col: ColumnRef, v: unknown): Expr => ({ kind: "lt", args: [col, v] }),
  asc: (col: ColumnRef) => ({ __order: "asc", col }),
  desc: (col: ColumnRef) => ({ __order: "desc", col }),
  sql: (parts: TemplateStringsArray | readonly string[], ...values: unknown[]) =>
    ({ __sql: true, parts: parts as readonly string[], values }) as SqlExpr,
};

// ──────────────────────────────────────────────────────────────────
// Lookup helpers. Joined queries store rows under their table name
// (`{job_work_orders: {...}, suppliers: {...}}`); single-table queries
// keep the row flat. Both shapes are handled by `lookupColumn`.
// ──────────────────────────────────────────────────────────────────

function lookupColumn(
  row: AnyRow | JoinedRow,
  col: ColumnRef,
): unknown {
  const joined = (row as JoinedRow)[col.__table];
  if (joined && typeof joined === "object") return joined[col.__column];
  return (row as AnyRow)[col.__column];
}

function resolveValue(
  v: unknown,
  row: AnyRow | JoinedRow,
): unknown {
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

function evaluateExpr(expr: Expr | undefined, row: AnyRow | JoinedRow): boolean {
  if (!expr) return true;
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
    case "gt": {
      const a = Number(resolveValue(expr.args[0], row));
      const b = Number(expr.args[1]);
      return Number.isFinite(a) && Number.isFinite(b) && a > b;
    }
    case "lt": {
      const a = Number(resolveValue(expr.args[0], row));
      const b = Number(expr.args[1]);
      return Number.isFinite(a) && Number.isFinite(b) && a < b;
    }
    case "sql":
      return evaluateSqlPredicate(expr.sql, row);
    default:
      return true;
  }
}

// Recognise only the literal patterns the JWO routes use as WHERE
// clauses: `${col} > 0`. Anything else is rejected loudly so a future
// change can't silently bypass filtering.
function evaluateSqlPredicate(s: SqlExpr, row: AnyRow | JoinedRow): boolean {
  const joined = s.parts.map((p, i) => p + (i < s.values.length ? "§" : "")).join("");
  if (/^§ ?> ?0\s*$/.test(joined.trim()) && isColumnRef(s.values[0])) {
    const v = Number(lookupColumn(row, s.values[0]));
    return Number.isFinite(v) && v > 0;
  }
  throw new Error(`Unrecognised sql predicate in test: ${joined}`);
}

// SET expressions only ever look like `${col} + ${literal}::numeric`
// or `${col} - ${literal}::numeric` in this route module. Both add
// (signed) the literal to the existing column value.
function evaluateSqlSet(s: SqlExpr, row: AnyRow): unknown {
  // Reconstruct a normalised template ignoring whitespace.
  const skeleton = s.parts.map((p) => p.replace(/\s+/g, " ").trim()).join("§");
  // Patterns:
  //   `§ + §::numeric`  → row[col] + Number(literal)
  //   `§ - §::numeric`  → row[col] - Number(literal)
  //   `§ + §`           → same, no cast
  //   `§ - §`           → same, no cast
  const m = skeleton.match(/^§\s*([+\-])\s*§(::[a-z]+)?\s*$/);
  if (m && isColumnRef(s.values[0])) {
    const op = m[1];
    const cur = Number(row[s.values[0].__column] ?? 0);
    const delta = Number(s.values[1] ?? 0);
    const result = op === "+" ? cur + delta : cur - delta;
    return String(result);
  }
  throw new Error(`Unrecognised sql SET expression in test: ${skeleton}`);
}

// ──────────────────────────────────────────────────────────────────
// Query plan + executor
// ──────────────────────────────────────────────────────────────────

interface JoinSpec {
  table: TableRef;
  on: Expr;
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
    const plan: SelectPlan = { projection, joins: [], order: [] };
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

  async execute(): Promise<unknown[]> {
    return [];
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
    chain.innerJoin = (table: TableRef, on: Expr) => {
      plan.joins.push({ table, on });
      return chain;
    };
    chain.leftJoin = chain.innerJoin;
    chain.where = (e: Expr) => {
      plan.where = e;
      return chain;
    };
    chain.orderBy = (...args: Array<{ __order: "asc" | "desc"; col: ColumnRef }>) => {
      for (const a of args)
        plan.order.push({ col: a.col, dir: a.__order });
      return chain;
    };
    chain.limit = (n: number) => {
      plan.limit = n;
      return chain;
    };
    chain.offset = () => chain;
    chain.for = () => chain;
    chain.groupBy = () => chain;
    chain.having = () => chain;
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
    if (!plan.table)
      throw new Error("select() chain missing .from(table)");
    let rows: JoinedRow[] = this.rowsOf(plan.table.__table).map((r) => ({
      [plan.table!.__table]: r,
    }));
    for (const join of plan.joins) {
      const other = this.rowsOf(join.table.__table);
      const next: JoinedRow[] = [];
      for (const left of rows) {
        for (const right of other) {
          const candidate: JoinedRow = {
            ...left,
            [join.table.__table]: right,
          };
          if (evaluateExpr(join.on, candidate)) next.push(candidate);
        }
      }
      rows = next;
    }
    rows = rows.filter((r) => evaluateExpr(plan.where, r));
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

    return rows.map((r) => {
      if (!plan.projection) {
        // Implicit `select()` returns the main table's full row.
        return r[plan.table!.__table];
      }
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(plan.projection)) {
        if (isColumnRef(val)) {
          out[key] = lookupColumn(r, val);
        } else if (isTableRef(val)) {
          // Whole-table projection (e.g. `select({o: jobWorkOrdersTable, ...})`).
          out[key] = r[val.__table];
        } else if (isSqlExpr(val)) {
          out[key] = "0"; // not used by tested routes; safe default
        } else {
          out[key] = val;
        }
      }
      return out;
    });
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
          Math.max(
            this.nextId.get(plan.table.__table) ?? 0,
            Number(row.id),
          ),
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
    return removed;
  }
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
  warehousesTable: tableSentinel("warehouses"),
  stockMovementsTable: tableSentinel("stock_movements"),
  jobWorkOrdersTable: tableSentinel("job_work_orders"),
  jobWorkOrderComponentsTable: tableSentinel("job_work_order_components"),
  jobWorkIssuesTable: tableSentinel("job_work_issues"),
  jobWorkIssueLinesTable: tableSentinel("job_work_issue_lines"),
  jobWorkReceiptsTable: tableSentinel("job_work_receipts"),
  jobWorkReceiptComponentsTable: tableSentinel("job_work_receipt_components"),
  purchaseOrdersTable: tableSentinel("purchase_orders"),
  purchaseOrderLinesTable: tableSentinel("purchase_order_lines"),
  supplierPaymentAllocationsTable: tableSentinel("supplier_payment_allocations"),
  salesOrdersTable: tableSentinel("sales_orders"),
  salesOrderLinesTable: tableSentinel("sales_order_lines"),
  einvoiceBulkBatchesTable: tableSentinel("einvoice_bulk_batches"),
};

export function createInMemoryDbModuleMock() {
  return {
    db: memDb,
    pool: { end: async () => undefined },
    ...tables,
  };
}
