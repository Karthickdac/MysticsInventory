import { and, eq, isNotNull } from "drizzle-orm";
import {
  db,
  itemsTable,
  itemWarehouseStockTable,
  organizationsTable,
  salesOrdersTable,
  warehousesTable,
} from "@workspace/db";
import { logger } from "./logger";
import { createShopifyFulfillment, setInventoryLevel, updateShopifyProduct } from "./shopify";
import { computeBundleStockByWarehouse } from "./bundles";

/**
 * Per-(orgId,itemId) push state. Ensures at most one HTTP call to
 * Shopify is in flight per item at a time, and that any pushes
 * requested while one is running collapse into a single "follow-up"
 * push that re-reads the current total. This prevents stale
 * overwrites when stock changes faster than Shopify round-trips.
 *
 * In-process only — fine for single-instance deploys; if we scale
 * horizontally we'd want a Redis-backed lock or a job queue.
 */
type PushState = {
  inFlight: Promise<void>;
  pending: boolean;
};
const pushStates = new Map<string, PushState>();

const keyOf = (orgId: number, itemId: number): string => `${orgId}:${itemId}`;

// ─── Product-fields push (name, sku, barcode, price, status, category) ───────

/**
 * Per-(orgId,itemId) push state for product-field syncs. Independent of
 * the stock push state so the two don't coalesce each other.
 */
type ProductPushState = {
  inFlight: Promise<void>;
  pending: boolean;
};
const productPushStates = new Map<string, ProductPushState>();

const productKeyOf = (orgId: number, itemId: number): string =>
  `product:${orgId}:${itemId}`;

/**
 * Fire-and-forget push of an item's product fields (name, sku, barcode,
 * price, status, category) to the linked Shopify product/variant.
 *
 * No-op if:
 *   - the org isn't connected to Shopify, OR
 *   - the item has no shopifyProductId / shopifyVariantId mapping.
 *
 * Uses the same coalescing pattern as pushStockToShopify so a burst of
 * rapid edits results in at most one in-flight + one follow-up call.
 */
export function pushProductFieldsToShopify(orgId: number, itemId: number): void {
  const key = productKeyOf(orgId, itemId);
  const existing = productPushStates.get(key);
  if (existing) {
    existing.pending = true;
    return;
  }
  startProductPush(key, orgId, itemId);
}

function startProductPush(key: string, orgId: number, itemId: number): void {
  const state: ProductPushState = {
    pending: false,
    inFlight: Promise.resolve(),
  };
  state.inFlight = (async () => {
    try {
      await pushProductFieldsToShopifyAsync(orgId, itemId);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), orgId, itemId },
        "Shopify outbound product fields push failed",
      );
    } finally {
      const followUp = state.pending;
      productPushStates.delete(key);
      if (followUp) startProductPush(key, orgId, itemId);
    }
  })();
  productPushStates.set(key, state);
}

async function pushProductFieldsToShopifyAsync(
  orgId: number,
  itemId: number,
): Promise<void> {
  const orgRows = await db
    .select({
      shopDomain: organizationsTable.shopifyShopDomain,
      accessToken: organizationsTable.shopifyAccessToken,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId))
    .limit(1);
  const org = orgRows[0];
  if (!org || !org.shopDomain || !org.accessToken) return;

  const itemRows = await db
    .select({
      name: itemsTable.name,
      sku: itemsTable.sku,
      barcode: itemsTable.barcode,
      salePrice: itemsTable.salePrice,
      category: itemsTable.category,
      archivedAt: itemsTable.archivedAt,
      shopifyProductId: itemsTable.shopifyProductId,
      shopifyVariantId: itemsTable.shopifyVariantId,
    })
    .from(itemsTable)
    .where(and(eq(itemsTable.id, itemId), eq(itemsTable.organizationId, orgId)))
    .limit(1);
  const item = itemRows[0];
  if (!item || !item.shopifyProductId || !item.shopifyVariantId) return;

  const status: "active" | "draft" = item.archivedAt ? "draft" : "active";

  await updateShopifyProduct(org.shopDomain, org.accessToken, item.shopifyProductId, {
    variantId: item.shopifyVariantId,
    title: item.name,
    sku: item.sku,
    barcode: item.barcode,
    price: item.salePrice ?? "0",
    category: item.category,
    status,
  });
}

// ─── Fulfillment push ─────────────────────────────────────────────────────────

/**
 * Fire-and-forget: create a Shopify fulfillment for the linked order when a
 * shipment is recorded in inventory. No-op if the order has no shopifyOrderId
 * or the org isn't connected to Shopify. Errors are logged + swallowed so they
 * never block the inventory operation.
 */
export function pushFulfillmentToShopify(orgId: number, salesOrderId: number): void {
  pushFulfillmentToShopifyAsync(orgId, salesOrderId).catch((err) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), orgId, salesOrderId },
      "Shopify outbound fulfillment push failed",
    );
  });
}

async function pushFulfillmentToShopifyAsync(
  orgId: number,
  salesOrderId: number,
): Promise<void> {
  const orgRows = await db
    .select({
      shopDomain: organizationsTable.shopifyShopDomain,
      accessToken: organizationsTable.shopifyAccessToken,
      orgLocationId: organizationsTable.shopifyLocationId,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId))
    .limit(1);
  const org = orgRows[0];
  if (!org || !org.shopDomain || !org.accessToken) return;

  const orderRows = await db
    .select({
      shopifyOrderId: salesOrdersTable.shopifyOrderId,
      warehouseId: salesOrdersTable.warehouseId,
      status: salesOrdersTable.status,
    })
    .from(salesOrdersTable)
    .where(
      and(
        eq(salesOrdersTable.id, salesOrderId),
        eq(salesOrdersTable.organizationId, orgId),
      ),
    )
    .limit(1);
  const order = orderRows[0];
  if (!order?.shopifyOrderId) return;
  // Only push a Shopify fulfillment when the order is fully shipped.
  // Partial shipments are skipped to avoid over-fulfilling line items
  // in Shopify before all quantities have been shipped from inventory.
  if (order.status !== "shipped") return;

  const whRows = await db
    .select({ shopifyLocationId: warehousesTable.shopifyLocationId })
    .from(warehousesTable)
    .where(
      and(
        eq(warehousesTable.id, order.warehouseId),
        eq(warehousesTable.organizationId, orgId),
      ),
    )
    .limit(1);
  const locationId = whRows[0]?.shopifyLocationId ?? org.orgLocationId;

  await createShopifyFulfillment(
    org.shopDomain,
    org.accessToken,
    order.shopifyOrderId,
    locationId,
  );
}

// ─── Stock push ───────────────────────────────────────────────────────────────

/**
 * Fire-and-forget push of an item's stock back to Shopify, per-warehouse.
 * No-op if:
 *   - the org isn't connected to Shopify, OR
 *   - the item has no inventory_item_id mapping yet.
 *
 * For each warehouse with a `shopify_location_id` mapping, push that
 * warehouse's specific quantity to its mapped Shopify location.
 * Warehouses without a mapping are skipped.
 */
export function pushStockToShopify(orgId: number, itemId: number): void {
  const key = keyOf(orgId, itemId);
  const existing = pushStates.get(key);
  if (existing) {
    // A push is already running. Mark a follow-up so that when it
    // completes we re-read state and push again — the most recent
    // value always wins.
    existing.pending = true;
    return;
  }
  startPush(key, orgId, itemId);
}

function startPush(key: string, orgId: number, itemId: number): void {
  const state: PushState = {
    pending: false,
    inFlight: Promise.resolve(),
  };
  state.inFlight = (async () => {
    try {
      await pushStockToShopifyAsync(orgId, itemId);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), orgId, itemId },
        "Shopify outbound stock push failed",
      );
    } finally {
      const followUp = state.pending;
      pushStates.delete(key);
      if (followUp) startPush(key, orgId, itemId);
    }
  })();
  pushStates.set(key, state);
}

async function pushStockToShopifyAsync(
  orgId: number,
  itemId: number,
): Promise<void> {
  const orgRows = await db
    .select({
      shopDomain: organizationsTable.shopifyShopDomain,
      accessToken: organizationsTable.shopifyAccessToken,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId))
    .limit(1);
  const org = orgRows[0];
  if (!org || !org.shopDomain || !org.accessToken) return;

  const itemRows = await db
    .select({
      inventoryItemId: itemsTable.shopifyInventoryItemId,
      isBundle: itemsTable.isBundle,
    })
    .from(itemsTable)
    .where(and(eq(itemsTable.id, itemId), eq(itemsTable.organizationId, orgId)))
    .limit(1);
  const item = itemRows[0];
  if (!item || !item.inventoryItemId) return;

  // For bundles, push derived per-warehouse stock (computed from
  // current components). For physical items, push the row's quantity.
  // We left-join warehouses so warehouses with no stock row push 0
  // (otherwise unmapping a SKU from a warehouse would never reach
  // Shopify).
  let rows: Array<{
    shopifyLocationId: string;
    warehouseId: number;
    quantity: number;
  }>;
  if (item.isBundle) {
    const derived = await computeBundleStockByWarehouse(orgId, itemId);
    const derivedById = new Map(derived.map((d) => [d.warehouseId, d.quantity]));
    const whRows = await db
      .select({
        warehouseId: warehousesTable.id,
        shopifyLocationId: warehousesTable.shopifyLocationId,
      })
      .from(warehousesTable)
      .where(
        and(
          eq(warehousesTable.organizationId, orgId),
          isNotNull(warehousesTable.shopifyLocationId),
        ),
      );
    rows = whRows.flatMap((w) =>
      w.shopifyLocationId
        ? [
            {
              warehouseId: w.warehouseId,
              shopifyLocationId: w.shopifyLocationId,
              quantity: derivedById.get(w.warehouseId) ?? 0,
            },
          ]
        : [],
    );
  } else {
    const stockRows = await db
      .select({
        warehouseId: warehousesTable.id,
        shopifyLocationId: warehousesTable.shopifyLocationId,
        quantity: itemWarehouseStockTable.quantity,
      })
      .from(warehousesTable)
      .leftJoin(
        itemWarehouseStockTable,
        and(
          eq(itemWarehouseStockTable.warehouseId, warehousesTable.id),
          eq(itemWarehouseStockTable.itemId, itemId),
        ),
      )
      .where(
        and(
          eq(warehousesTable.organizationId, orgId),
          isNotNull(warehousesTable.shopifyLocationId),
        ),
      );
    rows = stockRows.flatMap((r) =>
      r.shopifyLocationId
        ? [
            {
              warehouseId: r.warehouseId,
              shopifyLocationId: r.shopifyLocationId,
              quantity: Number(r.quantity ?? "0"),
            },
          ]
        : [],
    );
  }

  for (const r of rows) {
    const qty = Math.round(r.quantity);
    try {
      await setInventoryLevel(
        org.shopDomain,
        org.accessToken,
        item.inventoryItemId,
        r.shopifyLocationId,
        qty,
      );
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          orgId,
          itemId,
          locationId: r.shopifyLocationId,
        },
        "Shopify per-location push failed",
      );
    }
  }
}
