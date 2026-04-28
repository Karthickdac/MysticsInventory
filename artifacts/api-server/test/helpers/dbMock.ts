// Tiny chainable Drizzle-like mock. Tests queue per-method results
// in the order they expect them to be consumed; every chain method
// (`from`, `where`, `set`, `returning`, `limit`, …) returns the same
// chain object, which is also a thenable resolving to the queued
// payload. The mock records each call so tests can assert on the
// total number of selects/updates/etc.

interface ChainCall {
  fn: string;
  args: unknown[];
}

export interface ChainRecord {
  kind: "select" | "update" | "insert" | "delete";
  calls: ChainCall[];
  result: unknown;
}

const CHAIN_METHODS = [
  "from",
  "innerJoin",
  "leftJoin",
  "rightJoin",
  "fullJoin",
  "where",
  "set",
  "values",
  "returning",
  "onConflictDoNothing",
  "onConflictDoUpdate",
  "limit",
  "offset",
  "orderBy",
  "groupBy",
  "having",
  "for",
];

function makeChain(record: ChainRecord) {
  const chain: Record<string, unknown> = {
    __record: record,
  };
  for (const m of CHAIN_METHODS) {
    chain[m] = (...args: unknown[]) => {
      record.calls.push({ fn: m, args });
      return chain;
    };
  }
  // Make the chain thenable so `await db.select().from(...).limit(1)`
  // resolves to the queued payload.
  chain.then = (
    onFulfilled: ((value: unknown) => unknown) | null,
    onRejected: ((reason: unknown) => unknown) | null,
  ) =>
    Promise.resolve(record.result).then(
      onFulfilled ?? undefined,
      onRejected ?? undefined,
    );
  chain.catch = (onRejected: (reason: unknown) => unknown) =>
    Promise.resolve(record.result).catch(onRejected);
  chain.finally = (onFinally: () => void) =>
    Promise.resolve(record.result).finally(onFinally);
  return chain;
}

interface DbMockState {
  select: { queue: unknown[]; records: ChainRecord[] };
  update: { queue: unknown[]; records: ChainRecord[] };
  insert: { queue: unknown[]; records: ChainRecord[] };
  delete: { queue: unknown[]; records: ChainRecord[] };
}

interface ExecuteRecord {
  args: unknown[];
  result: unknown;
}

const state: DbMockState = {
  select: { queue: [], records: [] },
  update: { queue: [], records: [] },
  insert: { queue: [], records: [] },
  delete: { queue: [], records: [] },
};

const executeState: { queue: unknown[]; records: ExecuteRecord[] } = {
  queue: [],
  records: [],
};

function take(kind: "select" | "update" | "insert" | "delete") {
  const slot = state[kind];
  // Default to [] when the test forgot to queue a result; that
  // matches "no rows" for selects and "no returning rows" for
  // updates/deletes.
  const result = slot.queue.length > 0 ? slot.queue.shift() : [];
  const record: ChainRecord = { kind, calls: [], result };
  slot.records.push(record);
  return makeChain(record);
}

export const dbMock = {
  select: () => take("select"),
  update: () => take("update"),
  insert: () => take("insert"),
  delete: () => take("delete"),
  // `db.execute(sql\`...\`)` is a single-await call (no chain), so
  // the mock is just "consume the next queued result". Default to
  // an empty rowset when nothing was queued — matches the no-op
  // shape Drizzle returns for an UPDATE that matches no rows.
  execute: async (...args: unknown[]) => {
    const result =
      executeState.queue.length > 0 ? executeState.queue.shift() : [];
    executeState.records.push({ args, result });
    return result;
  },
  queueSelect(rows: unknown) {
    state.select.queue.push(rows);
  },
  queueUpdate(rows: unknown) {
    state.update.queue.push(rows);
  },
  queueInsert(rows: unknown) {
    state.insert.queue.push(rows);
  },
  queueDelete(rows: unknown) {
    state.delete.queue.push(rows);
  },
  queueExecute(rows: unknown) {
    executeState.queue.push(rows);
  },
  selectCalls: () => state.select.records,
  updateCalls: () => state.update.records,
  insertCalls: () => state.insert.records,
  deleteCalls: () => state.delete.records,
  executeCalls: () => executeState.records,
};

export function resetDbMock(): void {
  for (const slot of [state.select, state.update, state.insert, state.delete]) {
    slot.queue.length = 0;
    slot.records.length = 0;
  }
  executeState.queue.length = 0;
  executeState.records.length = 0;
}
