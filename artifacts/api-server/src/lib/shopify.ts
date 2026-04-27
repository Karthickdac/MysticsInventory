interface ShopifyProduct {
  id: number;
  title: string;
  body_html: string | null;
  product_type: string | null;
  variants: Array<{
    id: number;
    sku: string | null;
    price: string;
    inventory_quantity: number | null;
  }>;
  image: { src: string } | null;
}

const SHOPIFY_DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]\.myshopify\.com$/i;

export function normalizeShopifyDomain(input: string): string | null {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
  return SHOPIFY_DOMAIN_RE.test(cleaned) ? cleaned : null;
}

export async function fetchShopifyProducts(
  shopDomain: string,
  accessToken: string,
): Promise<ShopifyProduct[]> {
  const cleaned = normalizeShopifyDomain(shopDomain);
  if (!cleaned) {
    throw new Error(
      "Invalid Shopify domain. Must be like your-store.myshopify.com",
    );
  }
  const url = `https://${cleaned}/admin/api/2024-04/products.json?limit=250`;
  const res = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Shopify request failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { products: ShopifyProduct[] };
  return json.products ?? [];
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
  line_items: Array<{
    id: number;
    sku: string | null;
    title: string;
    quantity: number;
    price: string;
    tax_lines: Array<{ rate: number; price: string }>;
  }>;
}

export async function fetchShopifyOrders(
  shopDomain: string,
  accessToken: string,
  sinceId?: string | null,
): Promise<ShopifyOrder[]> {
  const cleaned = normalizeShopifyDomain(shopDomain);
  if (!cleaned) {
    throw new Error(
      "Invalid Shopify domain. Must be like your-store.myshopify.com",
    );
  }
  const params = new URLSearchParams({
    status: "any",
    limit: "100",
  });
  if (sinceId) params.set("since_id", sinceId);
  const url = `https://${cleaned}/admin/api/2024-04/orders.json?${params}`;
  const res = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(
      `Shopify request failed: ${res.status} ${await res.text()}`,
    );
  }
  const json = (await res.json()) as { orders: ShopifyOrder[] };
  return json.orders ?? [];
}
