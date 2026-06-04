import crypto from "node:crypto";

/**
 * In-memory tracker for historical Shopify order imports.
 *
 * The import can take a while (paging through hundreds of orders), so the
 * route kicks it off in the background and returns a job id the frontend
 * polls. State lives in-process: this app runs as a single Node process
 * (one pm2 instance / one Replit container), so a Map is sufficient. If
 * the API is ever scaled to multiple instances this must move to a shared
 * store (DB / Redis) — a poll could otherwise land on an instance that
 * doesn't know the job.
 */
export type ImportJobStatus = "running" | "completed" | "failed";

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
  fromDate: string | null;
  toDate: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const jobs = new Map<string, ImportJob>();

// Finished jobs are retained for an hour so a slow poller can still read
// the final result, then garbage-collected to bound memory.
const RETENTION_MS = 60 * 60 * 1000;

function gc(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (
      job.finishedAt &&
      now - new Date(job.finishedAt).getTime() > RETENTION_MS
    ) {
      jobs.delete(id);
    }
  }
}

export function createImportJob(input: {
  organizationId: number;
  fromDate: string | null;
  toDate: string | null;
  total: number | null;
}): ImportJob {
  gc();
  const job: ImportJob = {
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    status: "running",
    total: input.total,
    processed: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    fromDate: input.fromDate,
    toDate: input.toDate,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  return job;
}

/** Fetch a job, scoped to the owning org (returns null on mismatch). */
export function getImportJob(
  organizationId: number,
  id: string,
): ImportJob | null {
  const job = jobs.get(id);
  if (!job || job.organizationId !== organizationId) return null;
  return job;
}

export function updateImportJob(
  id: string,
  patch: Partial<Omit<ImportJob, "id" | "organizationId">>,
): void {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch);
}

export function finishImportJob(
  id: string,
  status: "completed" | "failed",
  error?: string,
): void {
  const job = jobs.get(id);
  if (!job) return;
  job.status = status;
  job.error = error ?? null;
  job.finishedAt = new Date().toISOString();
}
