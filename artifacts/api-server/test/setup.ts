// Make the imports of `@workspace/db` (which throws unless
// DATABASE_URL is set) safe at module-init time. The actual `db`
// export is replaced with an in-memory mock in the per-test setup,
// but the table schemas are still imported from the real package.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.EINVOICE_API_BASE ??= "https://einvoice.test";
process.env.APP_ENCRYPTION_KEY ??= "x".repeat(48);
process.env.NODE_ENV ??= "test";
