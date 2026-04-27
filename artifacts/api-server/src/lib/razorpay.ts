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

export function verifySubscriptionSignature(opts: {
  razorpayPaymentId: string;
  razorpaySubscriptionId: string;
  razorpaySignature: string;
}): boolean {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${opts.razorpayPaymentId}|${opts.razorpaySubscriptionId}`)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(opts.razorpaySignature, "utf8"),
  );
}
