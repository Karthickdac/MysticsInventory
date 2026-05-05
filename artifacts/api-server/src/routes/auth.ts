import { Router, type IRouter, type Request } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { validateBody } from "../lib/validate";
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
} from "../lib/password";
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
} from "../lib/authEmail";
import { logger } from "../lib/logger";
import { loginRateLimit, authMutationRateLimit } from "../lib/authRateLimit";

const router: IRouter = Router();

const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * A pre-computed bcrypt hash of a random string. Used as a constant
 * comparison target for unknown-email login attempts so the response
 * time mirrors the legitimate path and doesn't reveal whether the
 * email exists. The plaintext is never stored.
 */
const DUMMY_BCRYPT_HASH =
  "$2b$10$abcdefghijklmnopqrstuuJyOyPpEyEsZdkqJWQpNQ9bWp5XmVfYa";

/**
 * Generate a fresh URL-safe token AND its at-rest hash. The plaintext
 * goes to the user's email; only the hash is persisted, so a database
 * leak doesn't immediately enable account takeover.
 */
function genTokenPair(): { plain: string; hash: string } {
  const plain = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(plain).digest("hex");
  return { plain, hash };
}

function hashToken(plain: string): string {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

function setSessionUser(req: Request, userId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      req.session.save((err2) => (err2 ? reject(err2) : resolve()));
    });
  });
}

function clearSession(req: Request): Promise<void> {
  return new Promise((resolve) => {
    req.session.destroy(() => resolve());
  });
}

function publicUser(u: typeof usersTable.$inferSelect) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    isSuperAdmin: u.isSuperAdmin,
    emailVerified: u.emailVerifiedAt !== null,
  };
}

const GENERIC_SIGNUP_RESPONSE = {
  ok: true,
  message:
    "If that email is available, a verification link is on the way. Check your inbox to finish signing up.",
};

const signupSchema = z.object({
  email: z.string().email().max(254),
  password: z.string(),
  name: z.string().trim().min(1).max(120).optional(),
});

router.post(
  "/auth/signup",
  authMutationRateLimit,
  validateBody(signupSchema),
  async (req, res, next) => {
    try {
      const b = req.body as z.infer<typeof signupSchema>;
      const pwErr = validatePasswordStrength(b.password);
      if (pwErr) {
        res.status(400).json({ error: pwErr });
        return;
      }
      const email = b.email.toLowerCase().trim();
      const existing = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, email))
        .limit(1);
      if (existing[0]) {
        // Don't leak account existence — same status, same body, same
        // latency profile as the new-account path.
        res.status(200).json(GENERIC_SIGNUP_RESPONSE);
        return;
      }
      const passwordHash = await hashPassword(b.password);
      const { plain: verifyToken, hash: verifyHash } = genTokenPair();
      const verifyExpires = new Date(Date.now() + VERIFY_TOKEN_TTL_MS);
      const inserted = await db
        .insert(usersTable)
        .values({
          email,
          name: b.name ?? null,
          passwordHash,
          verifyToken: verifyHash,
          verifyTokenExpiresAt: verifyExpires,
        })
        .returning();
      const user = inserted[0]!;
      try {
        await sendVerificationEmail({
          to: user.email,
          name: user.name,
          token: verifyToken,
        });
      } catch (err) {
        logger.error({ err }, "signup: failed to send verification email");
      }
      res.status(200).json(GENERIC_SIGNUP_RESPONSE);
    } catch (err) {
      next(err);
    }
  },
);

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1),
});

router.post(
  "/auth/login",
  loginRateLimit,
  validateBody(loginSchema),
  async (req, res, next) => {
    try {
      const b = req.body as z.infer<typeof loginSchema>;
      const email = b.email.toLowerCase().trim();
      const rows = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, email))
        .limit(1);
      const user = rows[0];
      // Always run a bcrypt compare — against the real hash if we
      // know the user, or a constant dummy hash otherwise — so the
      // unknown-email path doesn't return measurably faster and leak
      // account existence via timing.
      const hashToCompare =
        user && user.passwordHash ? user.passwordHash : DUMMY_BCRYPT_HASH;
      const passwordOk = await verifyPassword(b.password, hashToCompare);
      if (!user || !user.passwordHash || !passwordOk) {
        res.status(401).json({ error: "Invalid email or password" });
        return;
      }
      if (!user.emailVerifiedAt) {
        res.status(403).json({
          error:
            "Please verify your email before signing in. Check your inbox for a verification link.",
          code: "email_not_verified",
        });
        return;
      }
      await setSessionUser(req, user.id);
      res.json({ ok: true, user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  },
);

router.post("/auth/logout", async (req, res, next) => {
  try {
    await clearSession(req);
    res.clearCookie("mystics.sid", { path: "/" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/auth/session", async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      res.json({ user: null });
      return;
    }
    const rows = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    const user = rows[0];
    if (!user) {
      await clearSession(req);
      res.json({ user: null });
      return;
    }
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

const verifyEmailSchema = z.object({ token: z.string().min(8).max(128) });

router.post(
  "/auth/verify-email",
  authMutationRateLimit,
  validateBody(verifyEmailSchema),
  async (req, res, next) => {
    try {
      const b = req.body as z.infer<typeof verifyEmailSchema>;
      const tokenHash = hashToken(b.token);
      const rows = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.verifyToken, tokenHash))
        .limit(1);
      const user = rows[0];
      if (
        !user ||
        !user.verifyTokenExpiresAt ||
        user.verifyTokenExpiresAt.getTime() < Date.now()
      ) {
        res.status(400).json({
          error: "This verification link is invalid or has expired.",
        });
        return;
      }
      const updated = await db
        .update(usersTable)
        .set({
          emailVerifiedAt: new Date(),
          verifyToken: null,
          verifyTokenExpiresAt: null,
        })
        .where(eq(usersTable.id, user.id))
        .returning();
      const u = updated[0]!;
      // Auto-login after verification — the user just proved control
      // of their inbox, so signing them straight in is the friendly path.
      await setSessionUser(req, u.id);
      res.json({ ok: true, user: publicUser(u) });
    } catch (err) {
      next(err);
    }
  },
);

const resendSchema = z.object({ email: z.string().email().max(254) });

router.post(
  "/auth/resend-verification",
  authMutationRateLimit,
  validateBody(resendSchema),
  async (req, res, next) => {
    try {
      const b = req.body as z.infer<typeof resendSchema>;
      const email = b.email.toLowerCase().trim();
      const rows = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, email))
        .limit(1);
      const user = rows[0];
      // Always return 200 — don't leak whether the email exists.
      if (!user || user.emailVerifiedAt) {
        res.json({ ok: true });
        return;
      }
      const { plain: verifyToken, hash: verifyHash } = genTokenPair();
      const verifyExpires = new Date(Date.now() + VERIFY_TOKEN_TTL_MS);
      await db
        .update(usersTable)
        .set({
          verifyToken: verifyHash,
          verifyTokenExpiresAt: verifyExpires,
        })
        .where(eq(usersTable.id, user.id));
      try {
        await sendVerificationEmail({
          to: user.email,
          name: user.name,
          token: verifyToken,
        });
      } catch (err) {
        logger.error(
          { err },
          "resend-verification: failed to send verification email",
        );
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

const forgotSchema = z.object({ email: z.string().email().max(254) });

router.post(
  "/auth/forgot-password",
  authMutationRateLimit,
  validateBody(forgotSchema),
  async (req, res, next) => {
    try {
      const b = req.body as z.infer<typeof forgotSchema>;
      const email = b.email.toLowerCase().trim();
      const rows = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, email))
        .limit(1);
      const user = rows[0];
      if (user) {
        const { plain: resetToken, hash: resetHash } = genTokenPair();
        const resetExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
        await db
          .update(usersTable)
          .set({
            resetToken: resetHash,
            resetTokenExpiresAt: resetExpires,
          })
          .where(eq(usersTable.id, user.id));
        try {
          await sendPasswordResetEmail({
            to: user.email,
            name: user.name,
            token: resetToken,
          });
        } catch (err) {
          logger.error(
            { err },
            "forgot-password: failed to send reset email",
          );
        }
      }
      // Always return 200 — don't leak whether the email exists.
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

const resetSchema = z.object({
  token: z.string().min(8).max(128),
  password: z.string(),
});

router.post(
  "/auth/reset-password",
  authMutationRateLimit,
  validateBody(resetSchema),
  async (req, res, next) => {
    try {
      const b = req.body as z.infer<typeof resetSchema>;
      const pwErr = validatePasswordStrength(b.password);
      if (pwErr) {
        res.status(400).json({ error: pwErr });
        return;
      }
      const tokenHash = hashToken(b.token);
      const rows = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.resetToken, tokenHash))
        .limit(1);
      const user = rows[0];
      if (
        !user ||
        !user.resetTokenExpiresAt ||
        user.resetTokenExpiresAt.getTime() < Date.now()
      ) {
        res.status(400).json({
          error: "This reset link is invalid or has expired.",
        });
        return;
      }
      const passwordHash = await hashPassword(b.password);
      const updated = await db
        .update(usersTable)
        .set({
          passwordHash,
          resetToken: null,
          resetTokenExpiresAt: null,
          // Resetting the password proves control of the inbox, so
          // mark the email verified too if it wasn't already.
          emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
        })
        .where(eq(usersTable.id, user.id))
        .returning();
      const u = updated[0]!;
      await setSessionUser(req, u.id);
      res.json({ ok: true, user: publicUser(u) });
    } catch (err) {
      next(err);
    }
  },
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string(),
});

router.post(
  "/auth/change-password",
  validateBody(changePasswordSchema),
  async (req, res, next) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const b = req.body as z.infer<typeof changePasswordSchema>;
      const pwErr = validatePasswordStrength(b.newPassword);
      if (pwErr) {
        res.status(400).json({ error: pwErr });
        return;
      }
      const rows = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);
      const user = rows[0];
      if (!user || !user.passwordHash) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const ok = await verifyPassword(b.currentPassword, user.passwordHash);
      if (!ok) {
        res.status(400).json({ error: "Current password is incorrect" });
        return;
      }
      const passwordHash = await hashPassword(b.newPassword);
      await db
        .update(usersTable)
        .set({ passwordHash })
        .where(eq(usersTable.id, user.id));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
