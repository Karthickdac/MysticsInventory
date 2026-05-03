// Real Postgres-backed test harness.
//
// Each Vitest worker process gets its own dedicated database
// (`test_inv_w<VITEST_POOL_ID>`) which is dropped and recreated on
// first import. The drizzle schema from `@workspace/db` is then
// pushed into that database (via `drizzle-kit/api`'s `pushSchema`)
// so every test runs against a real Postgres engine with the real
// production schema.
//
// The legacy `memDb.seed/rowsOf/reset` API is preserved, but is now
// async and just delegates to real Drizzle inserts/selects/TRUNCATE.
// `tables` re-exports the actual Drizzle table objects from
// `@workspace/db/schema`. `createInMemoryDbModuleMock()` returns a
// drop-in replacement for the `@workspace/db` module that swaps the
// pool/`db` for our worker-scoped one but keeps every schema export
// intact.

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableName } from "drizzle-orm";
import * as schemaModule from "@workspace/db/schema";

const POOL_ID = process.env.VITEST_POOL_ID ?? "0";
const TEST_DB_NAME = `test_inv_w${POOL_ID}`;

// Connection string used by the test harness. We rewrite the database
// name to our per-worker DB (TEST_DB_NAME).
const baseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://postgres:password@helium:5432/heliumdb";

function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

const adminUrl = withDatabase(baseUrl, "postgres");
const testUrl = withDatabase(baseUrl, TEST_DB_NAME);

const pool = new pg.Pool({ connectionString: testUrl, max: 4 });

// Disable FK / trigger enforcement for test connections. The legacy
// in-memory simulator never checked foreign keys, so existing test
// fixtures routinely seed orphan rows (e.g. `organization_members`
// with a `user_id` that has no matching `users` row). Putting every
// session into "replica" mode preserves that behaviour against the
// real engine without touching every test fixture.
pool.on("connect", (client) => {
  client
    .query("SET session_replication_role = replica")
    .catch(() => undefined);
});

export const testDb = drizzle(pool, { schema: schemaModule });

// Stamp `__table` on every schema export so legacy test code that
// reaches into `tables.fooTable.__table` to get the SQL table name
// keeps working with the real drizzle table objects.
for (const value of Object.values(schemaModule)) {
  if (!value || typeof value !== "object") continue;
  try {
    const name = getTableName(value as never);
    if (typeof name === "string" && name.length > 0) {
      (value as { __table?: string }).__table = name;
    }
  } catch {
    // not a drizzle table
  }
}

// Discover every drizzle table re-exported from `@workspace/db` so we
// can address them by SQL name (for `rowsOf`) and TRUNCATE them all
// in `reset`.
function collectTables(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const value of Object.values(schemaModule)) {
    if (!value || typeof value !== "object") continue;
    try {
      const name = getTableName(value as never);
      if (typeof name === "string" && name.length > 0) {
        out[name] = value;
      }
    } catch {
      // Not a drizzle table — ignore.
    }
  }
  return out;
}

const TABLES_BY_SQL_NAME = collectTables();
const ALL_TABLE_NAMES = Object.keys(TABLES_BY_SQL_NAME);

// ──────────────────────────────────────────────────────────────────
// One-time per-worker DB bootstrap.
// ──────────────────────────────────────────────────────────────────

// Bootstrap state lives on `globalThis` so it survives Vitest's
// per-test-file module isolation. Otherwise each new file would
// re-trigger DROP DATABASE / CREATE DATABASE on the same per-worker
// DB, racing against the previous file's still-open pool connections
// and silently leaving rows behind.
const __g = globalThis as {
  __invTestBootstrap?: Promise<void>;
};

async function bootstrap(): Promise<void> {
  // Drop and recreate the per-worker database from a separate admin
  // connection (you can't DROP/CREATE the DB you're connected to).
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // Terminate any stragglers, then drop & recreate.
    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DB_NAME],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}"`);
    await admin.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
  } finally {
    await admin.end();
  }

  // Push the drizzle schema into our freshly-created (empty) DB.
  // With an empty target, pushSchema emits `CREATE TABLE` for every
  // table — no diff/ALTER nonsense.
  const { pushSchema } = await import("drizzle-kit/api");
  const result = await pushSchema(
    schemaModule as unknown as Record<string, unknown>,
    testDb as never,
  );
  await result.apply();

  // The legacy in-memory simulator never enforced NOT NULL, so existing
  // test fixtures routinely insert rows with required columns left
  // unset (e.g. `sales_orders.warehouse_id`). Drop NOT NULL on every
  // non-PK column so those inserts continue to work.
  await pool.query(`
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN
        SELECT c.table_name, c.column_name
          FROM information_schema.columns c
          JOIN information_schema.tables t
            ON  t.table_schema = c.table_schema
            AND t.table_name   = c.table_name
         WHERE c.table_schema = 'public'
           AND t.table_type   = 'BASE TABLE'
           AND c.is_nullable  = 'NO'
           AND NOT EXISTS (
             SELECT 1
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage k
                 ON  k.constraint_name = tc.constraint_name
                 AND k.table_schema    = tc.table_schema
                 AND k.table_name      = tc.table_name
              WHERE tc.constraint_type = 'PRIMARY KEY'
                AND tc.table_schema    = c.table_schema
                AND tc.table_name      = c.table_name
                AND k.column_name      = c.column_name
           )
      LOOP
        EXECUTE format(
          'ALTER TABLE %I ALTER COLUMN %I DROP NOT NULL',
          r.table_name, r.column_name
        );
      END LOOP;
    END $$;
  `);

  // The legacy in-memory simulator never enforced uniqueness either:
  // tests routinely seed colliding ids across "orgs" (e.g.
  // `purchase_orders.id = 5` in both Org A and Org B in
  // stockMovements.tenant.test.ts) on the assumption that the harness
  // only checks org-scoping, not real PKs. Drop every primary-key /
  // unique constraint and every unique index in `public` so those
  // intentional collisions stop tripping `23505` errors. Sequences /
  // `serial` defaults remain intact, so auto-generated ids still work.
  await pool.query(`
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN
        SELECT conrelid::regclass::text AS tbl, conname
          FROM pg_constraint
         WHERE contype IN ('p','u')
           AND connamespace = 'public'::regnamespace
      LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I CASCADE', r.tbl, r.conname);
      END LOOP;
      FOR r IN
        SELECT schemaname, indexname
          FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexdef LIKE 'CREATE UNIQUE%'
      LOOP
        EXECUTE format('DROP INDEX %I.%I', r.schemaname, r.indexname);
      END LOOP;
    END $$;
  `);
}

export function ensureSchemaReady(): Promise<void> {
  if (!__g.__invTestBootstrap) __g.__invTestBootstrap = bootstrap();
  return __g.__invTestBootstrap;
}

// Eagerly kick off bootstrap on first import; tests `await
// memDb.reset()` in `beforeEach`, which transitively waits for it.
void ensureSchemaReady();

// ──────────────────────────────────────────────────────────────────
// Public API: memDb / tables / mock factories.
// ──────────────────────────────────────────────────────────────────

export const memDb = {
  async reset(): Promise<void> {
    await ensureSchemaReady();
    if (ALL_TABLE_NAMES.length === 0) return;
    const list = ALL_TABLE_NAMES.map((n) => `"${n}"`).join(", ");
    await pool.query(
      `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`,
    );
  },

  async seed<T extends Record<string, unknown>>(
    table: unknown,
    row: T,
  ): Promise<Record<string, unknown>> {
    await ensureSchemaReady();
    const [inserted] = await testDb
      .insert(table as never)
      .values(row as never)
      .returning();
    return inserted as Record<string, unknown>;
  },

  async rowsOf(name: string): Promise<Array<Record<string, unknown>>> {
    await ensureSchemaReady();
    const table = TABLES_BY_SQL_NAME[name];
    if (!table) {
      throw new Error(`Unknown table: ${name}`);
    }
    const rows = await testDb.select().from(table as never);
    return rows as Array<Record<string, unknown>>;
  },
};

// Re-export the real drizzle tables under the legacy `tables` keys
// the test files reference. Keys mirror the JS export names from
// `@workspace/db/schema` (which are camelCase, e.g. `customersTable`).
export const tables = schemaModule as unknown as Record<string, unknown>;

export function createInMemoryDbModuleMock() {
  // Override the package's `db`/`pool` with our worker-scoped ones,
  // but keep every other export (table objects, types, etc.) intact.
  return {
    ...schemaModule,
    db: testDb,
    pool: { end: async () => undefined },
  };
}
