import { eq } from "drizzle-orm";
import { db, organizationsTable } from "@workspace/db";
import { logger } from "./logger";
import { decryptString, encryptString } from "./encryption";

const SHIPROCKET_BASE = "https://apiv2.shiprocket.in/v1/external";

// Shiprocket tokens last ~10 days. We treat anything within 1 hour of
// expiry as already expired so a long-running request doesn't 401
// halfway through — and so the proactive re-login path runs before a
// real Shiprocket call would fail.
const TOKEN_REFRESH_BUFFER_MS = 60 * 60 * 1000;

export class ShiprocketNotConnectedError extends Error {
  constructor() {
    super("Shiprocket is not connected");
    this.name = "ShiprocketNotConnectedError";
  }
}

/**
 * Thrown when Shiprocket auth is unrecoverable from our side: no
 * stored credentials, the user changed their Shiprocket password
 * externally, the app encryption key was rotated, etc. The route
 * layer maps this to HTTP 401 + "please reconnect".
 *
 * NOTE: Routine token expiry is NOT this error — it's handled
 * silently via the encrypted-password re-login path below.
 */
export class ShiprocketTokenExpiredError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "Shiprocket session has expired and could not be refreshed — please reconnect the integration",
    );
    this.name = "ShiprocketTokenExpiredError";
  }
}

export class ShiprocketAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShiprocketAuthError";
  }
}

export class ShiprocketApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ShiprocketApiError";
    this.status = status;
    this.body = body;
  }
}

interface LoginResponse {
  token: string;
  // Shiprocket also returns first_name, email, etc. — ignored.
  expires_in?: number; // seconds, sometimes; not always present
}

/**
 * Mint a fresh Shiprocket token from email + password. Caller is
 * responsible for persisting it.
 */
export async function shiprocketLogin(
  email: string,
  password: string,
): Promise<{ token: string; expiresAt: Date }> {
  const res = await fetch(`${SHIPROCKET_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message =
      (body && typeof body === "object" && "message" in body
        ? String((body as { message: unknown }).message)
        : null) ??
      `Shiprocket login failed (${res.status})`;
    throw new ShiprocketAuthError(message);
  }
  const data = body as LoginResponse | null;
  if (!data?.token) {
    throw new ShiprocketAuthError("Shiprocket did not return a token");
  }
  // Shiprocket docs say tokens expire in 10 days. Trust that as the
  // floor; if they ever return expires_in, prefer it.
  const tenDaysMs = 10 * 24 * 60 * 60 * 1000;
  const ttlMs =
    typeof data.expires_in === "number" && data.expires_in > 0
      ? data.expires_in * 1000
      : tenDaysMs;
  return { token: data.token, expiresAt: new Date(Date.now() + ttlMs) };
}

interface OrgCredsRow {
  email: string | null;
  passwordEncrypted: string | null;
  tokenEncrypted: string | null;
  tokenExpiresAt: Date | null;
}

async function loadOrgCreds(orgId: number): Promise<OrgCredsRow | null> {
  const rows = await db
    .select({
      email: organizationsTable.shiprocketEmail,
      passwordEncrypted: organizationsTable.shiprocketPasswordEncrypted,
      tokenEncrypted: organizationsTable.shiprocketTokenEncrypted,
      tokenExpiresAt: organizationsTable.shiprocketTokenExpiresAt,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Use the encrypted password on file to mint a fresh Shiprocket
 * token, and persist the new encrypted token + expiry. Throws
 * ShiprocketTokenExpiredError if no password is on file or the
 * password no longer works (user changed it on Shiprocket's side, or
 * our encryption key was rotated).
 */
async function refreshOrgToken(
  orgId: number,
  creds: OrgCredsRow,
): Promise<string> {
  if (!creds.email || !creds.passwordEncrypted) {
    throw new ShiprocketTokenExpiredError(
      "Shiprocket credentials are not on file — please reconnect the integration",
    );
  }
  let password: string;
  try {
    password = decryptString(creds.passwordEncrypted);
  } catch (err) {
    logger.error(
      { orgId, err },
      "shiprocket: failed to decrypt stored password — forcing reconnect",
    );
    throw new ShiprocketTokenExpiredError();
  }
  let minted: { token: string; expiresAt: Date };
  try {
    minted = await shiprocketLogin(creds.email, password);
  } catch (err) {
    if (err instanceof ShiprocketAuthError) {
      logger.warn(
        { orgId, msg: err.message },
        "shiprocket: stored credentials no longer work — forcing reconnect",
      );
      throw new ShiprocketTokenExpiredError(
        "Shiprocket rejected the stored credentials — please reconnect with your current password",
      );
    }
    throw err;
  }
  const tokenEncrypted = encryptString(minted.token);
  await db
    .update(organizationsTable)
    .set({
      shiprocketTokenEncrypted: tokenEncrypted,
      shiprocketTokenExpiresAt: minted.expiresAt,
    })
    .where(eq(organizationsTable.id, orgId));
  logger.info(
    { orgId, expiresAt: minted.expiresAt.toISOString() },
    "shiprocket: re-logged in and refreshed token",
  );
  return minted.token;
}

/**
 * Resolve the active token for an org, refreshing it via the saved
 * password if the cached token is missing or near expiry.
 */
async function getOrgToken(orgId: number): Promise<string> {
  const creds = await loadOrgCreds(orgId);
  if (!creds || (!creds.tokenEncrypted && !creds.passwordEncrypted)) {
    throw new ShiprocketNotConnectedError();
  }
  const tokenStillFresh =
    !!creds.tokenEncrypted &&
    !!creds.tokenExpiresAt &&
    creds.tokenExpiresAt.getTime() - Date.now() > TOKEN_REFRESH_BUFFER_MS;
  if (tokenStillFresh && creds.tokenEncrypted) {
    try {
      return decryptString(creds.tokenEncrypted);
    } catch (err) {
      logger.warn(
        { orgId, err },
        "shiprocket: cached token failed to decrypt — falling through to re-login",
      );
    }
  }
  // Either no token, expired/near-expired, or decryption failed:
  // mint a fresh one using the stored password.
  return refreshOrgToken(orgId, creds);
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

async function doFetch(
  url: string,
  method: string,
  token: string,
  body?: unknown,
) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { res, body: parsed };
}

/**
 * Authenticated request to Shiprocket. On 401/403 we re-login once
 * using the saved encrypted password and retry the same call before
 * giving up.
 */
async function shiprocketRequest<T>(
  orgId: number,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  const qs = opts.query
    ? `?${new URLSearchParams(
        Object.fromEntries(
          Object.entries(opts.query)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)]),
        ),
      ).toString()}`
    : "";
  const url = `${SHIPROCKET_BASE}${path}${qs}`;

  let token = await getOrgToken(orgId);
  let { res, body } = await doFetch(url, method, token, opts.body);

  if (res.status === 401 || res.status === 403) {
    // Token still appeared valid to us but Shiprocket rejected it —
    // possibly revoked server-side. Try one re-login + retry.
    logger.info(
      { orgId, path, status: res.status },
      "shiprocket: auth rejected, attempting silent re-login",
    );
    const creds = await loadOrgCreds(orgId);
    if (!creds) {
      throw new ShiprocketNotConnectedError();
    }
    token = await refreshOrgToken(orgId, creds);
    ({ res, body } = await doFetch(url, method, token, opts.body));
    if (res.status === 401 || res.status === 403) {
      logger.warn(
        { orgId, path },
        "shiprocket: still 401/403 after re-login — forcing reconnect",
      );
      throw new ShiprocketTokenExpiredError();
    }
  }

  if (!res.ok) {
    const message =
      (body && typeof body === "object" && "message" in body
        ? String((body as { message: unknown }).message)
        : null) ?? `Shiprocket ${method} ${path} failed (${res.status})`;
    throw new ShiprocketApiError(res.status, message, body);
  }
  return body as T;
}

// ──────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────

export interface ShiprocketCreateOrderInput {
  orderId: string; // unique idempotency key on Shiprocket's side
  orderDate: string; // YYYY-MM-DD
  pickupLocation: string; // pickup-location nickname configured in Shiprocket
  channelId?: string;
  customer: {
    name: string;
    email?: string | null;
    phone: string;
    addressLine1: string;
    addressLine2?: string | null;
    city: string;
    state: string;
    pincode: string;
    country: string;
  };
  items: Array<{
    name: string;
    sku: string;
    units: number;
    sellingPrice: number;
    hsn?: string | null;
    taxPercent?: number | null;
  }>;
  paymentMethod: "Prepaid" | "COD";
  subTotal: number;
  weightKg: number;
  lengthCm: number;
  breadthCm: number;
  heightCm: number;
}

export interface ShiprocketCreateOrderResult {
  order_id: number;
  shipment_id: number;
  status?: string;
  status_code?: number;
  awb_code?: string | null;
  courier_company_id?: number | null;
  courier_name?: string | null;
}

export async function createShiprocketOrder(
  orgId: number,
  input: ShiprocketCreateOrderInput,
): Promise<ShiprocketCreateOrderResult> {
  const payload = {
    order_id: input.orderId,
    order_date: input.orderDate,
    pickup_location: input.pickupLocation,
    channel_id: input.channelId,
    billing_customer_name: input.customer.name,
    billing_last_name: "",
    billing_address: input.customer.addressLine1,
    billing_address_2: input.customer.addressLine2 ?? "",
    billing_city: input.customer.city,
    billing_pincode: input.customer.pincode,
    billing_state: input.customer.state,
    billing_country: input.customer.country,
    billing_email: input.customer.email ?? "",
    billing_phone: input.customer.phone,
    shipping_is_billing: true,
    order_items: input.items.map((it) => ({
      name: it.name,
      sku: it.sku,
      units: it.units,
      selling_price: it.sellingPrice,
      hsn: it.hsn ?? "",
      tax: it.taxPercent ?? 0,
    })),
    payment_method: input.paymentMethod,
    sub_total: input.subTotal,
    length: input.lengthCm,
    breadth: input.breadthCm,
    height: input.heightCm,
    weight: input.weightKg,
  };
  return shiprocketRequest<ShiprocketCreateOrderResult>(
    orgId,
    "/orders/create/adhoc",
    { method: "POST", body: payload },
  );
}

export interface ShiprocketAwbResult {
  awb_assign_status: number;
  response?: {
    data?: {
      awb_code?: string;
      courier_name?: string;
      courier_company_id?: number;
    };
    message?: string;
  };
  message?: string;
}

export async function assignShiprocketAwb(
  orgId: number,
  shipmentId: string,
  courierId?: number,
): Promise<ShiprocketAwbResult> {
  const body: Record<string, unknown> = { shipment_id: Number(shipmentId) };
  if (courierId) body["courier_id"] = courierId;
  return shiprocketRequest<ShiprocketAwbResult>(
    orgId,
    "/courier/assign/awb",
    { method: "POST", body },
  );
}

export interface ShiprocketLabelResult {
  label_created?: number;
  label_url?: string;
  response?: { label_url?: string };
  message?: string;
}

export async function generateShiprocketLabel(
  orgId: number,
  shipmentId: string,
): Promise<ShiprocketLabelResult> {
  return shiprocketRequest<ShiprocketLabelResult>(
    orgId,
    "/courier/generate/label",
    { method: "POST", body: { shipment_id: [Number(shipmentId)] } },
  );
}

export interface ShiprocketTrackingResult {
  tracking_data?: {
    track_status?: number;
    shipment_status?: number;
    shipment_track?: Array<{
      current_status?: string;
      courier_name?: string;
      awb_code?: string;
    }>;
    track_url?: string;
    etd?: string;
  };
}

export async function getShiprocketTracking(
  orgId: number,
  awb: string,
): Promise<ShiprocketTrackingResult> {
  return shiprocketRequest<ShiprocketTrackingResult>(
    orgId,
    `/courier/track/awb/${encodeURIComponent(awb)}`,
  );
}

// ──────────────────────────────────────────────────────────────────────
// Courier serviceability — list available couriers + rates for a route
// ──────────────────────────────────────────────────────────────────────

export interface ShiprocketCourierOption {
  courierId: number;
  courierName: string;
  rate: number;
  estimatedDeliveryDays: number | null;
  codAvailable: boolean;
  rating: number | null;
}

interface RawCourier {
  courier_company_id?: number;
  courier_name?: string;
  freight_charge?: number;
  rate?: number;
  estimated_delivery_days?: string | number;
  etd_hours?: number;
  cod?: number;
  rating?: number;
}

interface ServiceabilityResponse {
  data?: {
    available_courier_companies?: RawCourier[];
  };
}

export async function listShiprocketCouriers(
  orgId: number,
  params: {
    pickupPincode: string;
    deliveryPincode: string;
    weightKg: number;
    cod: boolean;
  },
): Promise<ShiprocketCourierOption[]> {
  const res = await shiprocketRequest<ServiceabilityResponse>(
    orgId,
    "/courier/serviceability/",
    {
      method: "GET",
      query: {
        pickup_postcode: params.pickupPincode,
        delivery_postcode: params.deliveryPincode,
        weight: params.weightKg,
        cod: params.cod ? 1 : 0,
      },
    },
  );
  const list = res.data?.available_courier_companies ?? [];
  return list
    .filter((c): c is RawCourier & { courier_company_id: number } =>
      typeof c.courier_company_id === "number",
    )
    .map((c) => ({
      courierId: c.courier_company_id,
      courierName: c.courier_name ?? `Courier ${c.courier_company_id}`,
      rate: typeof c.rate === "number" ? c.rate : Number(c.freight_charge ?? 0),
      estimatedDeliveryDays:
        typeof c.estimated_delivery_days === "number"
          ? c.estimated_delivery_days
          : typeof c.estimated_delivery_days === "string" &&
            c.estimated_delivery_days.trim() !== ""
          ? Number(c.estimated_delivery_days)
          : null,
      codAvailable: c.cod === 1,
      rating: typeof c.rating === "number" ? c.rating : null,
    }))
    .sort((a, b) => a.rate - b.rate);
}

/**
 * Map Shiprocket's free-text shipment status to one of our normalized
 * tracking buckets so the UI can render a stable badge.
 */
export function normalizeShiprocketStatus(raw: string | null | undefined): string {
  if (!raw) return "unknown";
  const s = raw.toLowerCase();
  if (s.includes("delivered")) return "delivered";
  if (s.includes("rto") || s.includes("returned")) return "rto";
  if (s.includes("out for delivery")) return "out_for_delivery";
  if (
    s.includes("in transit") ||
    s.includes("in-transit") ||
    s.includes("dispatched") ||
    s.includes("shipped") ||
    s.includes("picked")
  ) {
    return "in_transit";
  }
  if (s.includes("pickup") || s.includes("manifested") || s.includes("awb assigned")) {
    return "pickup_scheduled";
  }
  if (s.includes("cancel")) return "cancelled";
  return "unknown";
}

export function buildShiprocketTrackingUrl(awb: string): string {
  return `https://shiprocket.co/tracking/${encodeURIComponent(awb)}`;
}
