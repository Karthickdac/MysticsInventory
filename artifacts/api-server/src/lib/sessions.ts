import session, {
  type SessionOptions,
  MemoryStore,
  type Store,
} from "express-session";
import type { RequestHandler } from "express";
import connectPgSimple from "connect-pg-simple";
import { pool } from "@workspace/db";

declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}

const COOKIE_NAME = "mystics.sid";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build the express-session middleware.
 *
 * Storage:
 *   - Production / any env with a DATABASE_URL: connect-pg-simple backed
 *     by the shared pg pool. Survives `pm2 reload`, multi-process scale,
 *     and process crashes. The `session` table is auto-created on boot.
 *   - Fallback (tests / no DATABASE_URL): in-process MemoryStore.
 *
 * Cookie policy:
 *   - In Replit's preview iframe, the app is loaded cross-site so
 *     Lax cookies are dropped. We use SameSite=None; Secure for any
 *     environment served over HTTPS (REPLIT_DEV_DOMAIN or production)
 *     so the session cookie survives the iframe context.
 *   - In local plain-HTTP dev we fall back to SameSite=Lax (browsers
 *     reject SameSite=None without Secure).
 */
export function buildSessionMiddleware(): RequestHandler {
  const secret = process.env.APP_ENCRYPTION_KEY;
  if (!secret || secret.length < 16) {
    throw new Error(
      "APP_ENCRYPTION_KEY is required for session signing. Set a long random secret.",
    );
  }
  const isProd = process.env.NODE_ENV === "production";
  const isHttps =
    isProd ||
    Boolean(process.env.REPLIT_DEV_DOMAIN) ||
    process.env.HTTPS === "1";

  let store: Store;
  if (process.env.DATABASE_URL) {
    // Create the session table ourselves rather than relying on
    // connect-pg-simple's `createTableIfMissing`. The latter reads
    // `table.sql` via `__dirname`, which esbuild rewrites to the
    // bundle's dist/ directory at build time — causing ENOENT in
    // production. The DDL below is copied verbatim from
    // connect-pg-simple/table.sql.
    pool
      .query(
        `CREATE TABLE IF NOT EXISTS "session" (
           "sid"    varchar      NOT NULL COLLATE "default",
           "sess"   json         NOT NULL,
           "expire" timestamp(6) NOT NULL
         );
         DO $$
         BEGIN
           IF NOT EXISTS (
             SELECT 1 FROM pg_constraint WHERE conname = 'session_pkey'
           ) THEN
             ALTER TABLE "session"
               ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
               NOT DEFERRABLE INITIALLY IMMEDIATE;
           END IF;
         END$$;
         CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");`,
      )
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[sessions] failed to ensure session table:", err);
      });

    const PgStore = connectPgSimple(session);
    store = new PgStore({
      pool,
      tableName: "session",
      createTableIfMissing: false,
      // Sweep expired rows once an hour (default is 15 minutes — fine,
      // but explicit here so it's obvious in code review).
      pruneSessionInterval: 60 * 60,
    });
  } else {
    store = new MemoryStore();
  }

  const opts: SessionOptions = {
    name: COOKIE_NAME,
    secret,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: isHttps ? "none" : "lax",
      secure: isHttps,
      maxAge: 30 * ONE_DAY_MS,
      path: "/",
    },
  };
  return session(opts);
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
