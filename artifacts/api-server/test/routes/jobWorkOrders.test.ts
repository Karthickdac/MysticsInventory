import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDbModuleMock, drizzleOrmMock } from "../helpers/mockModules";

// Mock @workspace/db and drizzle-orm before importing the route module
// so the table sentinels and expression helpers are in place.
vi.mock("@workspace/db", () => createDbModuleMock());
vi.mock("drizzle-orm", () => drizzleOrmMock);

import { dbMock, resetDbMock } from "../helpers/dbMock";
import { ensureVendorWarehouse } from "../../src/routes/jobWorkOrders";

// The dbMock has the same shape as the inner transaction handle (it
// supports select/insert with the chainable, awaitable methods the
// route uses). Passing it through `as never` sidesteps the strict
// drizzle Tx type without compromising the runtime behaviour.
const tx = dbMock as never;

describe("ensureVendorWarehouse", () => {
  beforeEach(() => {
    resetDbMock();
  });

  it("reuses the existing virtual warehouse when one already exists", async () => {
    dbMock.queueSelect([{ id: 99 }]);

    const id = await ensureVendorWarehouse(tx, 1, 7, "Acme Stitching");

    expect(id).toBe(99);
    // Existence check only — no INSERT issued.
    expect(dbMock.selectCalls()).toHaveLength(1);
    expect(dbMock.insertCalls()).toHaveLength(0);
  });

  it("creates a fresh virtual warehouse when none exists", async () => {
    dbMock.queueSelect([]);
    dbMock.queueInsert([{ id: 123 }]);

    const id = await ensureVendorWarehouse(tx, 1, 7, "Acme Stitching");

    expect(id).toBe(123);
    expect(dbMock.insertCalls()).toHaveLength(1);
    // Loser-path re-select must not run when the INSERT succeeded.
    expect(dbMock.selectCalls()).toHaveLength(1);
  });

  it("reuses the winner's warehouse when a concurrent insert wins the race", async () => {
    // First ensureVendorWarehouse caller passes the existence check
    // (no row yet), then loses the INSERT race to a parallel caller
    // that committed first. Postgres raises unique_violation (23505)
    // on the partial unique index. The function must catch it,
    // re-read, and return the winner's id instead of bubbling a 500.

    dbMock.queueSelect([]); // initial existence check: empty
    // Make the next insert throw a synthetic 23505 error matching
    // node-postgres' shape (`err.code === "23505"`).
    const originalInsert = dbMock.insert;
    let insertCallCount = 0;
    (dbMock as unknown as { insert: () => unknown }).insert = () => {
      insertCallCount++;
      const chain: Record<string, unknown> = {};
      const methods = ["values", "returning", "onConflictDoNothing"];
      for (const m of methods) {
        chain[m] = () => chain;
      }
      const rejection = Promise.reject(
        Object.assign(new Error("duplicate key value violates unique constraint"), {
          code: "23505",
          constraint: "warehouses_org_job_worker_idx",
        }),
      );
      // Swallow the unhandled rejection warning; the route awaits it.
      rejection.catch(() => undefined);
      chain.then = (
        onFulfilled: ((value: unknown) => unknown) | null,
        onRejected: ((reason: unknown) => unknown) | null,
      ) => rejection.then(onFulfilled ?? undefined, onRejected ?? undefined);
      chain.catch = (onRejected: (reason: unknown) => unknown) =>
        rejection.catch(onRejected);
      chain.finally = (onFinally: () => void) => rejection.finally(onFinally);
      return chain;
    };

    // Recovery re-select returns the warehouse the winner just committed.
    dbMock.queueSelect([{ id: 555 }]);

    try {
      const id = await ensureVendorWarehouse(tx, 1, 7, "Acme Stitching");
      expect(id).toBe(555);
    } finally {
      (dbMock as unknown as { insert: () => unknown }).insert = originalInsert;
    }

    expect(insertCallCount).toBe(1);
    // One existence-check select + one recovery re-select.
    expect(dbMock.selectCalls()).toHaveLength(2);
  });

  it("re-throws non-unique-violation insert errors", async () => {
    dbMock.queueSelect([]);

    const originalInsert = dbMock.insert;
    (dbMock as unknown as { insert: () => unknown }).insert = () => {
      const chain: Record<string, unknown> = {};
      for (const m of ["values", "returning"]) {
        chain[m] = () => chain;
      }
      const rejection = Promise.reject(
        Object.assign(new Error("connection terminated"), { code: "57P01" }),
      );
      rejection.catch(() => undefined);
      chain.then = (
        onFulfilled: ((value: unknown) => unknown) | null,
        onRejected: ((reason: unknown) => unknown) | null,
      ) => rejection.then(onFulfilled ?? undefined, onRejected ?? undefined);
      chain.catch = (onRejected: (reason: unknown) => unknown) =>
        rejection.catch(onRejected);
      chain.finally = (onFinally: () => void) => rejection.finally(onFinally);
      return chain;
    };

    try {
      await expect(
        ensureVendorWarehouse(tx, 1, 7, "Acme Stitching"),
      ).rejects.toMatchObject({ code: "57P01" });
    } finally {
      (dbMock as unknown as { insert: () => unknown }).insert = originalInsert;
    }
  });
});
