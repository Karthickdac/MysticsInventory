// Make `@workspace/db` import-safe at module-init time and point the
// test harness at the local Postgres dev database. Each Vitest worker
// then carves out its own schema (`test_w<VITEST_POOL_ID>`) — see
// `test/helpers/inMemoryDb.ts`.
process.env.DATABASE_URL ??=
  "postgres://postgres:password@helium:5432/heliumdb";
process.env.EINVOICE_API_BASE ??= "https://einvoice.test";
process.env.APP_ENCRYPTION_KEY ??= "x".repeat(48);
process.env.NODE_ENV ??= "test";
// Disable the bulk worker's IRP rate-limit spacing and force a
// single-worker fan-out under test. The 150ms default makes
// otherwise-fast bulk-worker tests sleep for hundreds of ms per
// row, and single-worker fan-out makes the per-call DB queue
// ordering deterministic.
process.env.BULK_IRP_MIN_SPACING_MS ??= "0";
process.env.BULK_CONCURRENCY ??= "1";
