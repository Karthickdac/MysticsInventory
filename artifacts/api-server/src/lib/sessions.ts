import session, { type SessionOptions, MemoryStore } from "express-session";
import type { RequestHandler } from "express";

declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}

const COOKIE_NAME = "mystics.sid";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build the express-session middleware. Uses an in-process MemoryStore
 * which is fine for single-instance pm2 deployments (the app's
 * production target). On a multi-instance deploy this would need to
 * be swapped for connect-pg-simple or similar.
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
  const opts: SessionOptions = {
    name: COOKIE_NAME,
    secret,
    store: new MemoryStore(),
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
