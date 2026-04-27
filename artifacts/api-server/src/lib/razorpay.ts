import Razorpay from "razorpay";
import crypto from "node:crypto";

let cached: Razorpay | null = null;

export function getRazorpay(): Razorpay {
  if (cached) return cached;
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) {
    throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET must be set");
  }
  cached = new Razorpay({ key_id, key_secret });
  return cached;
}

export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(signature, "utf8"),
  );
}

export function verifySubscriptionSignature(opts: {
  razorpayPaymentId: string;
  razorpaySubscriptionId: string;
  razorpaySignature: string;
}): boolean {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return false;
  if (
    !opts.razorpayPaymentId ||
    !opts.razorpaySubscriptionId ||
    !opts.razorpaySignature
  ) {
    return false;
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${opts.razorpayPaymentId}|${opts.razorpaySubscriptionId}`)
    .digest("hex");
  if (expected.length !== opts.razorpaySignature.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(opts.razorpaySignature, "utf8"),
  );
}
