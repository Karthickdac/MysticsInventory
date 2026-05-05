import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";

/**
 * Rate limiter for sensitive auth endpoints. Keyed by client IP. The
 * limits below are intentionally generous for the legitimate-user
 * worst case (typo + retry on a phone) while still bounding the rate
 * at which an attacker can guess passwords or harvest accounts.
 *
 * Disabled in NODE_ENV=test so route tests aren't flaky.
 */
function buildLimiter(opts: {
  windowMs: number;
  max: number;
  message: string;
}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === "test",
    handler: (_req, res) => {
      res.status(429).json({ error: opts.message, code: "rate_limited" });
    },
  });
}

// Login: 10 attempts / 15 min / IP.
export const loginRateLimit = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many sign-in attempts. Please wait a few minutes and try again.",
});

// Signup / forgot / resend / reset / verify: 20 / hour / IP. Less
// hot than login but still bounded for enumeration & email-bomb abuse.
export const authMutationRateLimit = buildLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: "Too many requests from this network. Please try again later.",
});
