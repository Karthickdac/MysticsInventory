import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Install fake timers BEFORE importing the module so its module-level
// `setInterval` sweep is registered against the fake clock.
vi.useFakeTimers();

const {
  createImportJob,
  getImportJob,
  finishImportJob,
  updateImportJob,
  stopImportJobSweep,
} = await import("../../src/lib/shopifyImportJobs.ts");

const ORG = 1;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const RETENTION_MS = 60 * 60 * 1000;

afterAll(() => {
  stopImportJobSweep();
  vi.useRealTimers();
});

describe("shopifyImportJobs background sweep", () => {
  it("reclaims finished jobs past retention without a new import being started", () => {
    const job = createImportJob({
      organizationId: ORG,
      fromDate: null,
      toDate: null,
      total: 0,
    });
    finishImportJob(job.id, "completed");
    // Backdate the finish so it is already past the retention window.
    updateImportJob(job.id, {
      finishedAt: new Date(Date.now() - RETENTION_MS - 1000).toISOString(),
    });

    expect(getImportJob(ORG, job.id)).not.toBeNull();

    // No new import is created; only the timer sweep should reclaim it.
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS + 1);

    expect(getImportJob(ORG, job.id)).toBeNull();
  });

  it("leaves running and recently-finished jobs untouched on sweep", () => {
    const running = createImportJob({
      organizationId: ORG,
      fromDate: null,
      toDate: null,
      total: 5,
    });
    const fresh = createImportJob({
      organizationId: ORG,
      fromDate: null,
      toDate: null,
      total: 1,
    });
    finishImportJob(fresh.id, "completed");

    vi.advanceTimersByTime(SWEEP_INTERVAL_MS + 1);

    expect(getImportJob(ORG, running.id)).not.toBeNull();
    expect(getImportJob(ORG, fresh.id)).not.toBeNull();
  });
});
