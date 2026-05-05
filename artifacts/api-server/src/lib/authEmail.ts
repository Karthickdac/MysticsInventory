import { sendEmail, isEmailConfigured } from "./email";
import { logger } from "./logger";

function appBaseUrl(): string {
  const explicit = process.env.APP_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const dev = process.env.REPLIT_DEV_DOMAIN?.trim();
  if (dev) return `https://${dev}`;
  return "http://localhost:5000";
}

function inventoryBase(): string {
  return `${appBaseUrl()}/inventory`;
}

/**
 * Send the email-verification link. In dev (no SMTP configured) we
 * just log the URL so the developer can click it manually instead of
 * crashing the signup flow.
 */
export async function sendVerificationEmail(opts: {
  to: string;
  name: string | null;
  token: string;
}): Promise<void> {
  const url = `${inventoryBase()}/verify-email?token=${encodeURIComponent(opts.token)}`;
  if (!isEmailConfigured()) {
    logger.warn(
      { to: opts.to, url },
      "[dev] SMTP not configured — verification link below (click to verify):",
    );
    return;
  }
  const greeting = opts.name ? `Hi ${opts.name},` : "Hi,";
  await sendEmail({
    to: opts.to,
    subject: "Verify your Mystics Inventory email",
    text: [
      greeting,
      "",
      "Please confirm your email address by visiting the link below:",
      url,
      "",
      "This link expires in 24 hours.",
      "",
      "If you did not sign up, you can safely ignore this message.",
      "",
      "— Mystics Inventory",
    ].join("\n"),
    html: `<p>${greeting}</p><p>Please confirm your email address by clicking the link below:</p><p><a href="${url}">${url}</a></p><p>This link expires in 24 hours.</p><p>If you did not sign up, you can safely ignore this message.</p><p>— Mystics Inventory</p>`,
  });
}

export async function sendPasswordResetEmail(opts: {
  to: string;
  name: string | null;
  token: string;
}): Promise<void> {
  const url = `${inventoryBase()}/reset-password?token=${encodeURIComponent(opts.token)}`;
  if (!isEmailConfigured()) {
    logger.warn(
      { to: opts.to, url },
      "[dev] SMTP not configured — password reset link below (click to reset):",
    );
    return;
  }
  const greeting = opts.name ? `Hi ${opts.name},` : "Hi,";
  await sendEmail({
    to: opts.to,
    subject: "Reset your Mystics Inventory password",
    text: [
      greeting,
      "",
      "We received a request to reset your password. Visit the link below to choose a new one:",
      url,
      "",
      "This link expires in 1 hour.",
      "",
      "If you didn't request this, you can safely ignore this message — your password will stay the same.",
      "",
      "— Mystics Inventory",
    ].join("\n"),
    html: `<p>${greeting}</p><p>We received a request to reset your password. Click the link below to choose a new one:</p><p><a href="${url}">${url}</a></p><p>This link expires in 1 hour.</p><p>If you didn't request this, you can safely ignore this message — your password will stay the same.</p><p>— Mystics Inventory</p>`,
  });
}
