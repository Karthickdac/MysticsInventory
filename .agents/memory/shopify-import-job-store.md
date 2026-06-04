---
name: Shopify import job store (DB-backed + startup reconcile)
description: Why the historical Shopify import job store is a DB table and how startup orphan-recovery avoids failing live jobs
---

# Shopify historical-import job store

The job store for historical Shopify order imports is a **DB table**
(`shopify_import_jobs`), not an in-process Map. It must survive a restart so a
merchant can still read the result and the `failedOrderIds` list to retry.

**Why:** imports run in-process in the background; a crash/deploy/workflow
restart mid-import used to silently lose all progress and the failed-order list.

## Startup orphan reconciliation — the race that matters
On boot, any `running` row can only be an orphan from a dead process (imports
never resume). Reconcile flips them to `failed` (preserving counts +
`failedOrderIds`). But it is wired fire-and-forget after `app.listen`, so the
server can accept traffic and create *new* `running` rows while reconcile is
still in flight.

**Rule:** reconcile must only fail rows whose `startedAt` is before this
process booted. Capture a module-load `PROCESS_BOOT_AT = new Date()` and add
`startedAt < PROCESS_BOOT_AT` to the reconcile WHERE. New jobs get a DB
`defaultNow()` timestamp strictly after boot, so they are never wrongly failed.

**How to apply:** any background job store with "flip orphaned running → failed
on startup" semantics, wired fire-and-forget after the server starts listening,
needs this boot-timestamp guard. Resume-style recovery (e.g. einvoice bulk
batches, which *resume* rather than fail) does not, because re-picking up a live
row is harmless.

## Concurrency
Per-order progress writes use single-statement SQL increments + JSONB `||`
append (`incrementImportJob`), so concurrent order writes never lose updates.

## Schema deployment
New tables ship via drizzle **push** (`scripts/post-merge.sh` runs
`pnpm --filter db push`), not generated migration files — do not hand-author a
migration SQL for a new table here.
