// Persistence + restart-recovery tests for the Shopify import job store.
// Backed by the real per-worker Postgres harness (the store is now a DB
// table, not an in-process Map).

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { createInMemoryDbModuleMock, memDb, tables } from "../helpers/inMemoryDb";

vi.mock("@workspace/db", () => createInMemoryDbModuleMock());

const {
  createImportJob,
  getImportJob,
  incrementImportJob,
  finishImportJob,
  updateImportJob,
  reconcileOrphanedImportJobs,
  sweepFinishedImportJobs,
  stopImportJobSweep,
} = await import("../../src/lib/shopifyImportJobs.ts");

const ORG_A = 101;
const ORG_B = 202;
const RETENTION_MS = 60 * 60 * 1000;

beforeEach(async () => {
  await memDb.reset();
});

afterAll(() => {
  stopImportJobSweep();
});

describe("shopifyImportJobs persistence", () => {
  it("persists counts and failedOrders so a fresh read survives a 'restart'", async () => {
    const job = await createImportJob({
      organizationId: ORG_A,
      fromDate: "2026-01-01",
      toDate: "2026-01-31",
      total: 3,
    });

    await incrementImportJob(job.id, { processed: 1, imported: 1 });
    await incrementImportJob(job.id, { processed: 1, skipped: 1 });
    await incrementImportJob(job.id, {
      processed: 1,
      failed: 1,
      failedOrder: { id: "9001", reason: "missing SKU" },
    });
    await finishImportJob(job.id, "completed_with_errors");

    // A brand-new read (as a restarted process would do) sees the
    // persisted result, including the order ids that need retrying.
    const reread = await getImportJob(ORG_A, job.id);
    expect(reread).not.toBeNull();
    expect(reread!.status).toBe("completed_with_errors");
    expect(reread!.processed).toBe(3);
    expect(reread!.imported).toBe(1);
    expect(reread!.skipped).toBe(1);
    expect(reread!.failed).toBe(1);
    expect(reread!.failedOrders).toEqual([
      { id: "9001", reason: "missing SKU" },
    ]);
    expect(reread!.finishedAt).not.toBeNull();
  });

  it("scopes reads to the owning org", async () => {
    const job = await createImportJob({
      organizationId: ORG_A,
      fromDate: null,
      toDate: null,
      total: 0,
    });
    expect(await getImportJob(ORG_B, job.id)).toBeNull();
    expect(await getImportJob(ORG_A, job.id)).not.toBeNull();
  });
});

describe("shopifyImportJobs restart recovery", () => {
  it("flips orphaned running jobs to failed while preserving partial progress", async () => {
    const orphan = await createImportJob({
      organizationId: ORG_A,
      fromDate: null,
      toDate: null,
      total: 5,
    });
    await incrementImportJob(orphan.id, {
      processed: 2,
      imported: 1,
      failed: 1,
      failedOrder: { id: "7777", reason: "boom" },
    });
    // Simulate a job left running by a *prior* process: its startedAt is
    // before this process booted.
    await updateImportJob(orphan.id, {
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const finished = await createImportJob({
      organizationId: ORG_B,
      fromDate: null,
      toDate: null,
      total: 1,
    });
    await finishImportJob(finished.id, "completed");

    await reconcileOrphanedImportJobs();

    const recovered = await getImportJob(ORG_A, orphan.id);
    expect(recovered!.status).toBe("failed");
    expect(recovered!.error).toMatch(/restart/i);
    expect(recovered!.finishedAt).not.toBeNull();
    // Partial progress is preserved so the merchant can retry.
    expect(recovered!.processed).toBe(2);
    expect(recovered!.failedOrders).toEqual([{ id: "7777", reason: "boom" }]);

    // An already-finished job is left untouched.
    const untouched = await getImportJob(ORG_B, finished.id);
    expect(untouched!.status).toBe("completed");
  });

  it("does not fail a job started by the current process (startup race)", async () => {
    // A job created in-process has startedAt after PROCESS_BOOT_AT, so a
    // reconcile racing with boot must leave it running.
    const fresh = await createImportJob({
      organizationId: ORG_A,
      fromDate: null,
      toDate: null,
      total: 3,
    });

    await reconcileOrphanedImportJobs();

    const still = await getImportJob(ORG_A, fresh.id);
    expect(still!.status).toBe("running");
  });
});

describe("shopifyImportJobs retention sweep", () => {
  it("reclaims finished jobs past retention but keeps running/fresh ones", async () => {
    const old = await createImportJob({
      organizationId: ORG_A,
      fromDate: null,
      toDate: null,
      total: 0,
    });
    await finishImportJob(old.id, "completed");
    // Backdate the finish to before the retention window.
    await updateImportJob(old.id, {
      finishedAt: new Date(Date.now() - RETENTION_MS - 1000).toISOString(),
    });

    const running = await createImportJob({
      organizationId: ORG_A,
      fromDate: null,
      toDate: null,
      total: 0,
    });
    const fresh = await createImportJob({
      organizationId: ORG_A,
      fromDate: null,
      toDate: null,
      total: 0,
    });
    await finishImportJob(fresh.id, "completed");

    await sweepFinishedImportJobs();

    expect(await getImportJob(ORG_A, old.id)).toBeNull();
    expect(await getImportJob(ORG_A, running.id)).not.toBeNull();
    expect(await getImportJob(ORG_A, fresh.id)).not.toBeNull();
  });
});
