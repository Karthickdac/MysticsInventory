import Razorpay from "razorpay";
import crypto from "node:crypto";

let cached: Razorpay | null = null;

export class RazorpayNotConfiguredError extends Error {
  constructor() {
    super(
      "Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to enable online payments.",
    );
    this.name = "RazorpayNotConfiguredError";
  }
}

export function getRazorpay(): Razorpay {
  if (cached) return cached;
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) {
    throw new RazorpayNotConfiguredError();
  }
  cached = new Razorpay({ key_id, key_secret });
  return cached;
}

export interface PaymentLinkContact {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface CreatePaymentLinkOpts {
  amountInRupees: number;
  currency?: string;
  description: string;
  customer: PaymentLinkContact;
  organizationId: number;
  salesOrderId: number;
  orderNumber: string;
  callbackUrl?: string;
  expireBy?: Date | null;
  reminderEnable?: boolean;
}

export interface RazorpayPaymentLink {
  id: string;
  short_url: string;
  status: string;
  amount: number;
  currency: string;
  description?: string;
  expire_by?: number | null;
  notes?: Record<string, string> | null;
}

function toPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

export async function createPaymentLink(
  opts: CreatePaymentLinkOpts,
): Promise<RazorpayPaymentLink> {
  const customer: Record<string, string> = {};
  if (opts.customer.name) customer.name = opts.customer.name;
  if (opts.customer.email) customer.email = opts.customer.email;
  if (opts.customer.phone) customer.contact = opts.customer.phone;

  const payload: Record<string, unknown> = {
    amount: toPaise(opts.amountInRupees),
    currency: opts.currency ?? "INR",
    accept_partial: false,
    description: opts.description.slice(0, 2048),
    customer,
    notify: {
      sms: !!opts.customer.phone,
      email: !!opts.customer.email,
    },
    reminder_enable: opts.reminderEnable ?? true,
    notes: {
      organizationId: String(opts.organizationId),
      salesOrderId: String(opts.salesOrderId),
      orderNumber: opts.orderNumber,
    },
  };
  if (opts.callbackUrl) {
    payload.callback_url = opts.callbackUrl;
    payload.callback_method = "get";
  }
  if (opts.expireBy) {
    payload.expire_by = Math.floor(opts.expireBy.getTime() / 1000);
  }
  return createPaymentLinkApi(payload);
}

// The Razorpay SDK exposes the resource as either `paymentLink` (camel)
// or `payment_link` (snake) depending on version. Resolve at runtime so
// either spelling works without forcing a specific SDK version.
interface PaymentLinkClient {
  create(p: Record<string, unknown>): Promise<RazorpayPaymentLink>;
  fetch(id: string): Promise<RazorpayPaymentLink>;
  cancel(id: string): Promise<RazorpayPaymentLink>;
}

function getPaymentLinkClient(rzp: Razorpay): PaymentLinkClient {
  const anyClient = rzp as unknown as Record<string, unknown>;
  const candidate =
    (anyClient["paymentLink"] as PaymentLinkClient | undefined) ??
    (anyClient["payment_link"] as PaymentLinkClient | undefined);
  if (
    !candidate ||
    typeof candidate.create !== "function" ||
    typeof candidate.fetch !== "function" ||
    typeof candidate.cancel !== "function"
  ) {
    throw new Error(
      "Installed Razorpay SDK does not expose payment-link APIs. Upgrade the razorpay package.",
    );
  }
  return candidate;
}

export async function createPaymentLinkApi(
  payload: Record<string, unknown>,
): Promise<RazorpayPaymentLink> {
  return getPaymentLinkClient(getRazorpay()).create(payload);
}

export async function fetchPaymentLink(
  linkId: string,
): Promise<RazorpayPaymentLink> {
  return getPaymentLinkClient(getRazorpay()).fetch(linkId);
}

export async function cancelPaymentLink(
  linkId: string,
): Promise<RazorpayPaymentLink> {
  return getPaymentLinkClient(getRazorpay()).cancel(linkId);
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
