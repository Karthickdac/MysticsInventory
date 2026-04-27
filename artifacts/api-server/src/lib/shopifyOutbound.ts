import { and, eq, sql } from "drizzle-orm";
import {
  db,
  itemsTable,
  itemWarehouseStockTable,
  organizationsTable,
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
 * Fire-and-forget push of an item's current total stock back to Shopify.
 * No-op if:
 *   - the org isn't connected to Shopify, OR
 *   - the org has no resolved Shopify location, OR
 *   - the item has no inventory_item_id mapping yet.
 *
 * Total stock is summed across ALL warehouses for the item — Shopify
 * sees one number per location.
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
      locationId: organizationsTable.shopifyLocationId,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId))
    .limit(1);
  const org = orgRows[0];
  if (!org || !org.shopDomain || !org.accessToken || !org.locationId) return;

  const itemRows = await db
    .select({ inventoryItemId: itemsTable.shopifyInventoryItemId })
    .from(itemsTable)
    .where(and(eq(itemsTable.id, itemId), eq(itemsTable.organizationId, orgId)))
    .limit(1);
  const item = itemRows[0];
  if (!item || !item.inventoryItemId) return;

  const totalRows = await db
    .select({ total: sql<string>`COALESCE(SUM(${itemWarehouseStockTable.quantity}), 0)` })
    .from(itemWarehouseStockTable)
    .where(eq(itemWarehouseStockTable.itemId, itemId));
  const total = Math.round(Number(totalRows[0]?.total ?? "0"));

  await setInventoryLevel(
    org.shopDomain,
    org.accessToken,
    item.inventoryItemId,
    org.locationId,
    total,
  );
}
