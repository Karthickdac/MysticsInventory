import { and, eq, isNotNull } from "drizzle-orm";
import {
  db,
  itemsTable,
  itemWarehouseStockTable,
  organizationsTable,
  warehousesTable,
} from "@workspace/db";
import { logger } from "./logger";
import { setInventoryLevel } from "./shopify";

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
    .select({ inventoryItemId: itemsTable.shopifyInventoryItemId })
    .from(itemsTable)
    .where(and(eq(itemsTable.id, itemId), eq(itemsTable.organizationId, orgId)))
    .limit(1);
  const item = itemRows[0];
  if (!item || !item.inventoryItemId) return;

  // Get every (warehouse, stock) pair for this item where the warehouse
  // is mapped to a Shopify location. We left-join so warehouses with no
  // stock row push 0 (otherwise unmapping a SKU from a warehouse would
  // never reach Shopify).
  const rows = await db
    .select({
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

  for (const r of rows) {
    if (!r.shopifyLocationId) continue;
    const qty = Math.round(Number(r.quantity ?? "0"));
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
