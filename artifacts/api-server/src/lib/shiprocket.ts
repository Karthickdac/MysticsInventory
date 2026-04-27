import { eq } from "drizzle-orm";
import { db, organizationsTable } from "@workspace/db";
import { logger } from "./logger";
import { decryptString } from "./encryption";

const SHIPROCKET_BASE = "https://apiv2.shiprocket.in/v1/external";

// Shiprocket tokens last ~10 days. We treat anything within 1 hour of
// expiry as already expired so a long-running request doesn't 401
// halfway through — the route layer maps the resulting "expired"
// signal to a friendly "please reconnect" prompt.
const TOKEN_EXPIRY_BUFFER_MS = 60 * 60 * 1000;

export class ShiprocketNotConnectedError extends Error {
  constructor() {
    super("Shiprocket is not connected");
    this.name = "ShiprocketNotConnectedError";
  }
}

/**
 * Thrown whenever the cached Shiprocket token is missing, expired,
 * undecryptable, or rejected by Shiprocket (401/403). The route
 * layer maps this to HTTP 401 + "please reconnect".
 *
 * NOTE: We do not — and cannot — silently re-login on the user's
 * behalf because Shiprocket's API has no refresh-token mechanism;
 * the only way to mint a new token is to call /auth/login with the
 * raw email + password, which we deliberately do NOT persist. The
 * admin must complete a short reconnect flow in the UI when the
 * token expires (~every 10 days).
 */
export class ShiprocketTokenExpiredError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "Shiprocket session has expired — please reconnect the integration",
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
 * responsible for persisting the encrypted token + expiry. The raw
 * password is NEVER persisted — it is used here exactly once at
 * connect time and then dropped.
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
  tokenEncrypted: string | null;
  tokenExpiresAt: Date | null;
}

async function loadOrgCreds(orgId: number): Promise<OrgCredsRow | null> {
  const rows = await db
    .select({
      email: organizationsTable.shiprocketEmail,
      tokenEncrypted: organizationsTable.shiprocketTokenEncrypted,
      tokenExpiresAt: organizationsTable.shiprocketTokenExpiresAt,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Resolve the active token for an org. Throws:
 *  - ShiprocketNotConnectedError if there is no integration on file
 *  - ShiprocketTokenExpiredError if the token is missing, near
 *    expiry, or undecryptable (key rotated, ciphertext corrupted)
 *
 * Does NOT attempt any silent re-login: Shiprocket has no
 * refresh-token API and we deliberately do not store the raw
 * password. The admin must reconnect through the UI.
 */
async function getOrgToken(orgId: number): Promise<string> {
  const creds = await loadOrgCreds(orgId);
  if (!creds || !creds.email) {
    throw new ShiprocketNotConnectedError();
  }
  if (!creds.tokenEncrypted || !creds.tokenExpiresAt) {
    throw new ShiprocketTokenExpiredError();
  }
  if (
    creds.tokenExpiresAt.getTime() - Date.now() <= TOKEN_EXPIRY_BUFFER_MS
  ) {
    throw new ShiprocketTokenExpiredError();
  }
  try {
    return decryptString(creds.tokenEncrypted);
  } catch (err) {
    logger.warn(
      { orgId, err },
      "shiprocket: cached token failed to decrypt — forcing reconnect",
    );
    throw new ShiprocketTokenExpiredError();
  }
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
 * Authenticated request to Shiprocket. On 401/403 we surface a
 * ShiprocketTokenExpiredError so the route layer can return a
 * "please reconnect" response — there is no silent re-login because
 * we do not store the password.
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

  const token = await getOrgToken(orgId);
  const { res, body } = await doFetch(url, method, token, opts.body);

  if (res.status === 401 || res.status === 403) {
    // Token was within its expiry window per our records but
    // Shiprocket rejected it — most likely revoked server-side.
    // Clear the stale cached token so subsequent calls fail fast at
    // getOrgToken instead of round-tripping to Shiprocket again.
    logger.info(
      { orgId, path, status: res.status },
      "shiprocket: auth rejected — clearing cached token, requiring reconnect",
    );
    await db
      .update(organizationsTable)
      .set({
        shiprocketTokenEncrypted: null,
        shiprocketTokenExpiresAt: null,
      })
      .where(eq(organizationsTable.id, orgId));
    throw new ShiprocketTokenExpiredError();
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
