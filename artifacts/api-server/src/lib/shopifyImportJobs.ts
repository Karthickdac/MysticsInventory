import crypto from "node:crypto";
import { and, eq, lt, isNotNull, sql } from "drizzle-orm";
import { db, shopifyImportJobsTable, type ShopifyImportJobRow } from "@workspace/db";

/**
 * Persistent tracker for historical Shopify order imports.
 *
 * The import can take a while (paging through hundreds of orders), so the
 * route kicks it off in the background and returns a job id the frontend
 * polls. State is persisted in the `shopify_import_jobs` table so the result
 * — including the list of `failedOrders` a merchant needs to retry —
 * survives a server restart (a crash, deploy, or workflow restart mid-import
 * no longer loses the job).
 */
export type ImportJobStatus =
  | "running"
  | "completed"
  | "completed_with_errors"
  | "failed";

/**
 * A Shopify order that threw during import, with a short human-readable
 * reason so the merchant can see *why* it failed (missing SKU, validation
 * error, etc.) and fix the root cause instead of blindly retrying.
 */
export interface FailedOrder {
  id: string;
  reason: string;
}

export interface ImportJob {
  id: string;
  organizationId: number;
  status: ImportJobStatus;
  /** Total orders to process; null until known (count call in flight). */
  total: number | null;
  processed: number;
  imported: number;
  skipped: number;
  failed: number;
  /** Shopify orders that threw during import, with the failure reason, so they can be retried. */
  failedOrders: FailedOrder[];
  fromDate: string | null;
  toDate: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

// Finished jobs are retained for an hour so a slow poller can still read
// the final result, then garbage-collected to bound table growth.
const RETENTION_MS = 60 * 60 * 1000;

// Captured once at module load (before the server starts listening). Any
// `running` row with `startedAt` before this instant must belong to a prior
// process — used by startup reconciliation to avoid failing jobs this
// process legitimately starts after boot. Jobs created here get a DB
// `defaultNow()` timestamp that is strictly after this value.
const PROCESS_BOOT_AT = new Date();

function mapRow(row: ShopifyImportJobRow): ImportJob {
  return {
    id: row.id,
    organizationId: row.organizationId,
    status: row.status as ImportJobStatus,
    total: row.total,
    processed: row.processed,
    imported: row.imported,
    skipped: row.skipped,
    failed: row.failed,
    failedOrders: row.failedOrders,
    fromDate: row.fromDate,
    toDate: row.toDate,
    error: row.error,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

/**
 * Delete finished jobs whose retention window has elapsed. Exported so the
 * sweep timer, `createImportJob`, and tests can all trigger it deterministically.
 */
export async function sweepFinishedImportJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_MS);
  await db
    // org-scope-allow: retention GC of finished jobs across all orgs; bounded
    // by finishedAt and never touches a tenant's in-flight job.
    .delete(shopifyImportJobsTable)
    .where(
      and(
        isNotNull(shopifyImportJobsTable.finishedAt),
        lt(shopifyImportJobsTable.finishedAt, cutoff),
      ),
    );
}

// Sweep on a timer so finished jobs are reclaimed even if no new import is
// ever started. `.unref()` keeps this background timer from holding the
// process open on shutdown.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void sweepFinishedImportJobs().catch(() => undefined);
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

ensureSweep();

/** Test-only: stop the background sweep timer so it doesn't leak across runs. */
export function stopImportJobSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

export async function createImportJob(input: {
  organizationId: number;
  fromDate: string | null;
  toDate: string | null;
  total: number | null;
}): Promise<ImportJob> {
  await sweepFinishedImportJobs().catch(() => undefined);
  const [row] = await db
    .insert(shopifyImportJobsTable)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      status: "running",
      total: input.total,
      fromDate: input.fromDate,
      toDate: input.toDate,
    })
    .returning();
  return mapRow(row!);
}

/** Fetch a job, scoped to the owning org (returns null on mismatch). */
export async function getImportJob(
  organizationId: number,
  id: string,
): Promise<ImportJob | null> {
  const rows = await db
    .select()
    .from(shopifyImportJobsTable)
    .where(
      and(
        eq(shopifyImportJobsTable.id, id),
        eq(shopifyImportJobsTable.organizationId, organizationId),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Atomically bump per-order progress counters (and optionally append a
 * failed Shopify order with its failure reason). Atomic SQL increments avoid
 * a read-modify-write race and keep each order's progress write to a single
 * statement.
 */
export async function incrementImportJob(
  id: string,
  delta: {
    processed?: number;
    imported?: number;
    skipped?: number;
    failed?: number;
    failedOrder?: FailedOrder;
  },
): Promise<void> {
  const { failedOrder } = delta;
  await db
    // org-scope-allow: job id is a globally-unique server-generated UUID; the
    // owning org is fixed at insert time and never changes.
    .update(shopifyImportJobsTable)
    .set({
      processed: sql`${shopifyImportJobsTable.processed} + ${delta.processed ?? 0}`,
      imported: sql`${shopifyImportJobsTable.imported} + ${delta.imported ?? 0}`,
      skipped: sql`${shopifyImportJobsTable.skipped} + ${delta.skipped ?? 0}`,
      failed: sql`${shopifyImportJobsTable.failed} + ${delta.failed ?? 0}`,
      failedOrders:
        failedOrder !== undefined
          ? sql`${shopifyImportJobsTable.failedOrders} || ${JSON.stringify([
              failedOrder,
            ])}::jsonb`
          : sql`${shopifyImportJobsTable.failedOrders}`,
    })
    .where(eq(shopifyImportJobsTable.id, id));
}

/** Set arbitrary fields on a job (used for status/total fixups + tests). */
export async function updateImportJob(
  id: string,
  patch: Partial<Omit<ImportJob, "id" | "organizationId">>,
): Promise<void> {
  const set: Partial<typeof shopifyImportJobsTable.$inferInsert> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.total !== undefined) set.total = patch.total;
  if (patch.processed !== undefined) set.processed = patch.processed;
  if (patch.imported !== undefined) set.imported = patch.imported;
  if (patch.skipped !== undefined) set.skipped = patch.skipped;
  if (patch.failed !== undefined) set.failed = patch.failed;
  if (patch.failedOrders !== undefined)
    set.failedOrders = patch.failedOrders;
  if (patch.fromDate !== undefined) set.fromDate = patch.fromDate;
  if (patch.toDate !== undefined) set.toDate = patch.toDate;
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.startedAt !== undefined) set.startedAt = new Date(patch.startedAt);
  if (patch.finishedAt !== undefined)
    set.finishedAt = patch.finishedAt === null ? null : new Date(patch.finishedAt);
  if (Object.keys(set).length === 0) return;
  await db
    // org-scope-allow: job id is a globally-unique server-generated UUID; the
    // owning org is fixed at insert time and never changes.
    .update(shopifyImportJobsTable)
    .set(set)
    .where(eq(shopifyImportJobsTable.id, id));
}

export async function finishImportJob(
  id: string,
  status: "completed" | "completed_with_errors" | "failed",
  error?: string,
): Promise<void> {
  await db
    // org-scope-allow: job id is a globally-unique server-generated UUID; the
    // owning org is fixed at insert time and never changes.
    .update(shopifyImportJobsTable)
    .set({ status, error: error ?? null, finishedAt: new Date() })
    .where(eq(shopifyImportJobsTable.id, id));
}

/**
 * Startup recovery: a job left in `running` state can only be an orphan from
 * a process that exited mid-import (the in-process background loop driving it
 * did not survive the restart). Flip those to `failed` so the UI stops
 * polling forever — the partial progress and accumulated `failedOrders`
 * are preserved, so the merchant can still retry the orders that did fail.
 */
export async function reconcileOrphanedImportJobs(): Promise<void> {
  await db
    // org-scope-allow: startup recovery scans every interrupted job across all
    // tenants; each row's org is fixed and untouched by this status fixup.
    .update(shopifyImportJobsTable)
    .set({
      status: "failed",
      error: "Import interrupted by a server restart",
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(shopifyImportJobsTable.status, "running"),
        // Only jobs from a prior process — never a job this process just
        // started while reconciliation is still in flight after boot.
        lt(shopifyImportJobsTable.startedAt, PROCESS_BOOT_AT),
      ),
    );
}
