import crypto from "node:crypto";

const SHOPIFY_API_VERSION = "2024-04";
const SHOPIFY_DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]\.myshopify\.com$/i;

const REQUIRED_SCOPES = [
  "read_products",
  "write_products",
  "read_inventory",
  "write_inventory",
  "read_orders",
  "read_customers",
  "read_locations",
];

export function parseShopifyScopes(stored: string | null | undefined): Set<string> {
  if (!stored) return new Set();
  return new Set(
    stored
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export function findMissingShopifyScopes(
  stored: string | null | undefined,
  required: readonly string[] = REQUIRED_SCOPES,
): string[] {
  const have = parseShopifyScopes(stored);
  return required.filter((s) => !have.has(s));
}

const WEBHOOK_TOPICS = [
  "orders/create",
  "orders/updated",
  "products/update",
  "inventory_levels/update",
  "app/uninstalled",
];

export function getShopifyAppUrl(): string {
  const explicit = process.env["SHOPIFY_APP_URL"];
  if (explicit) return explicit.replace(/\/$/, "");
  const replitDomain = process.env["REPLIT_DEV_DOMAIN"];
  if (replitDomain) return `https://${replitDomain}`;
  throw new Error(
    "SHOPIFY_APP_URL is not set and no Replit domain is available",
  );
}

export function getShopifyApiKey(): string {
  const v = process.env["SHOPIFY_API_KEY"];
  if (!v) throw new Error("SHOPIFY_API_KEY is not set");
  return v;
}

export function getShopifyApiSecret(): string {
  const v = process.env["SHOPIFY_API_SECRET"];
  if (!v) throw new Error("SHOPIFY_API_SECRET is not set");
  return v;
}

export function normalizeShopifyDomain(input: string): string | null {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
  return SHOPIFY_DOMAIN_RE.test(cleaned) ? cleaned : null;
}

export function buildInstallUrl(shopDomain: string, state: string): string {
  const params = new URLSearchParams({
    client_id: getShopifyApiKey(),
    scope: REQUIRED_SCOPES.join(","),
    redirect_uri: `${getShopifyAppUrl()}/api/shopify/oauth/callback`,
    state,
    "grant_options[]": "",
  });
  return `https://${shopDomain}/admin/oauth/authorize?${params.toString()}`;
}

/**
 * Verify the HMAC parameter Shopify attaches to OAuth callback URLs.
 * Per docs, sort all query params except `hmac` (and `signature`),
 * concatenate as `key=value&key=value`, then HMAC-SHA256 with the
 * app secret and compare to the `hmac` value.
 */
export function verifyOauthHmac(query: Record<string, string>): boolean {
  const { hmac, signature: _ignored, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("&");
  const digest = crypto
    .createHmac("sha256", getShopifyApiSecret())
    .update(message)
    .digest("hex");
  return safeEqualHex(digest, hmac);
}

/**
 * Verify the HMAC header Shopify attaches to webhook deliveries.
 * Header is base64 of HMAC-SHA256 over the raw request body.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  headerSignature: string | undefined,
): boolean {
  if (!headerSignature) return false;
  const bodyBuf =
    typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const digest = crypto
    .createHmac("sha256", getShopifyApiSecret())
    .update(bodyBuf)
    .digest("base64");
  return safeEqualB64(digest, headerSignature);
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function safeEqualB64(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export interface TokenExchangeResult {
  access_token: string;
  scope: string;
}

export async function exchangeCodeForToken(
  shopDomain: string,
  code: string,
): Promise<TokenExchangeResult> {
  const res = await fetch(
    `https://${shopDomain}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: getShopifyApiKey(),
        client_secret: getShopifyApiSecret(),
        code,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Shopify token exchange failed: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as TokenExchangeResult;
}

async function shopifyGet<T>(
  shopDomain: string,
  accessToken: string,
  path: string,
  query?: Record<string, string>,
): Promise<T> {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
  const url = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}${path}${qs}`;
  const res = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(
      `Shopify GET ${path} failed: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as T;
}

async function shopifyPost<T>(
  shopDomain: string,
  accessToken: string,
  path: string,
  body: unknown,
): Promise<T> {
  const url = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `Shopify POST ${path} failed: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as T;
}

interface LocationsResponse {
  locations: Array<{ id: number; name: string; primary?: boolean }>;
}

export async function getPrimaryLocationId(
  shopDomain: string,
  accessToken: string,
): Promise<string | null> {
  const data = await shopifyGet<LocationsResponse>(
    shopDomain,
    accessToken,
    "/locations.json",
  );
  if (!data.locations || data.locations.length === 0) return null;
  const primary = data.locations.find((l) => l.primary) ?? data.locations[0]!;
  return String(primary.id);
}

export interface ShopifyLocation {
  id: string;
  name: string;
  primary: boolean;
}

/**
 * Fetch all locations for a Shopify shop. Shopify caps /locations.json at
 * 250 per page; very few merchants hit that limit, but we paginate via
 * `page_info` link headers if needed for completeness.
 */
export async function fetchAllShopifyLocations(
  shopDomain: string,
  accessToken: string,
): Promise<ShopifyLocation[]> {
  const out: ShopifyLocation[] = [];
  let path: string | null = "/locations.json?limit=250";
  while (path) {
    const url = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}${path}`;
    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(
        `Shopify GET /locations.json failed: ${res.status} ${await res.text()}`,
      );
    }
    const data = (await res.json()) as LocationsResponse;
    for (const l of data.locations ?? []) {
      out.push({ id: String(l.id), name: l.name, primary: !!l.primary });
    }
    const link = res.headers.get("link") ?? "";
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    if (nextMatch) {
      const u = new URL(nextMatch[1]!);
      path = `${u.pathname.replace(/^\/admin\/api\/[^/]+/, "")}${u.search}`;
    } else {
      path = null;
    }
  }
  return out;
}

export async function registerWebhooks(
  shopDomain: string,
  accessToken: string,
): Promise<void> {
  const callbackBase = `${getShopifyAppUrl()}/api/webhooks/shopify`;
  // Delete any pre-existing subscriptions for this app first to avoid
  // duplicates (best-effort; we ignore errors).
  try {
    const existing = await shopifyGet<{
      webhooks: Array<{ id: number; topic: string }>;
    }>(shopDomain, accessToken, "/webhooks.json");
    for (const w of existing.webhooks ?? []) {
      try {
        await fetch(
          `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/webhooks/${w.id}.json`,
          {
            method: "DELETE",
            headers: { "X-Shopify-Access-Token": accessToken },
          },
        );
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  for (const topic of WEBHOOK_TOPICS) {
    await shopifyPost(shopDomain, accessToken, "/webhooks.json", {
      webhook: {
        topic,
        address: callbackBase,
        format: "json",
      },
    });
  }
}

export interface ShopifyVariantFull {
  id: number;
  product_id: number;
  sku: string | null;
  price: string;
  inventory_quantity: number | null;
  inventory_item_id: number | null;
  title: string | null;
  option1: string | null;
  option2: string | null;
  option3: string | null;
}

export interface ShopifyProductOption {
  name: string;
  values?: string[];
}

export interface ShopifyProductFull {
  id: number;
  title: string;
  body_html: string | null;
  product_type: string | null;
  variants: ShopifyVariantFull[];
  options: ShopifyProductOption[];
  image: { src: string } | null;
}

export async function fetchShopifyProducts(
  shopDomain: string,
  accessToken: string,
): Promise<ShopifyProductFull[]> {
  const data = await shopifyGet<{ products: ShopifyProductFull[] }>(
    shopDomain,
    accessToken,
    "/products.json",
    { limit: "250" },
  );
  return data.products ?? [];
}

export interface ShopifyOrder {
  id: number;
  name: string;
  email: string | null;
  created_at: string;
  total_price: string;
  subtotal_price: string;
  total_tax: string;
  currency: string;
  financial_status: string | null;
  fulfillment_status: string | null;
  customer: {
    id: number;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  location_id?: number | null;
  line_items: Array<{
    id: number;
    sku: string | null;
    title: string;
    quantity: number;
    price: string;
    origin_location?: { id: number } | null;
    tax_lines: Array<{ rate: number; price: string }>;
  }>;
}

export async function fetchShopifyOrders(
  shopDomain: string,
  accessToken: string,
  sinceId?: string | null,
): Promise<ShopifyOrder[]> {
  const params: Record<string, string> = { status: "any", limit: "100" };
  if (sinceId) params["since_id"] = sinceId;
  const data = await shopifyGet<{ orders: ShopifyOrder[] }>(
    shopDomain,
    accessToken,
    "/orders.json",
    params,
  );
  return data.orders ?? [];
}

/**
 * Set absolute inventory level for a variant at the org's location.
 * Used by outbound stock sync.
 */
export async function setInventoryLevel(
  shopDomain: string,
  accessToken: string,
  inventoryItemId: string,
  locationId: string,
  available: number,
): Promise<void> {
  await shopifyPost(shopDomain, accessToken, "/inventory_levels/set.json", {
    location_id: Number(locationId),
    inventory_item_id: Number(inventoryItemId),
    available,
  });
}

export { REQUIRED_SCOPES, WEBHOOK_TOPICS };
