import crypto from "node:crypto";

function getSecret(): string {
  const s =
    process.env.INVOICE_SIGNING_SECRET?.trim() ||
    process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!s) {
    throw new Error(
      "Set INVOICE_SIGNING_SECRET (or RAZORPAY_KEY_SECRET) before generating invoice share links.",
    );
  }
  return s;
}

function sign(orgId: number, salesOrderId: number, exp: number): string {
  const payload = `${orgId}|${salesOrderId}|${exp}`;
  return crypto
    .createHmac("sha256", getSecret())
    .update(payload)
    .digest("hex");
}

export interface SignedInvoiceLink {
  url: string;
  expiresAt: string;
  token: string;
  exp: number;
}

export function signInvoiceUrl(
  baseUrl: string,
  orgId: number,
  salesOrderId: number,
  ttlSeconds: number = 60 * 60 * 24 * 30,
): SignedInvoiceLink {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = sign(orgId, salesOrderId, exp);
  const trimmed = baseUrl.replace(/\/$/, "");
  const url = `${trimmed}/api/public/invoices/${salesOrderId}.pdf?org=${orgId}&exp=${exp}&token=${token}`;
  return { url, expiresAt: new Date(exp * 1000).toISOString(), token, exp };
}

export interface InvoiceTokenClaims {
  organizationId: number;
  salesOrderId: number;
  exp: number;
}

export function verifyInvoiceToken(
  orgIdRaw: string | undefined,
  salesOrderIdRaw: string | undefined,
  expRaw: string | undefined,
  token: string | undefined,
): InvoiceTokenClaims | null {
  try {
    if (!orgIdRaw || !salesOrderIdRaw || !expRaw || !token) return null;
    const orgId = Number(orgIdRaw);
    const salesOrderId = Number(salesOrderIdRaw);
    const exp = Number(expRaw);
    if (
      !Number.isFinite(orgId) ||
      !Number.isFinite(salesOrderId) ||
      !Number.isFinite(exp)
    )
      return null;
    if (Date.now() / 1000 > exp) return null;
    if (!/^[0-9a-f]+$/i.test(token)) return null;
    const expected = sign(orgId, salesOrderId, exp);
    const a = Buffer.from(token, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
    return { organizationId: orgId, salesOrderId, exp };
  } catch {
    // Catch-all so missing-secret or any unexpected error becomes a clean 403
    // upstream rather than leaking config hints through the global handler.
    return null;
  }
}
