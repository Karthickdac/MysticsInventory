import crypto from "node:crypto";
import { Router, type IRouter } from "express";
import { and, eq, lt, isNotNull, sql } from "drizzle-orm";
import {
  db,
  organizationsTable,
  itemsTable,
  itemWarehouseStockTable,
  stockMovementsTable,
  shopifyOauthStatesTable,
  warehousesTable,
} from "@workspace/db";
import { tenantMiddleware, getDefaultWarehouseId } from "../lib/tenant";
import {
  buildInstallUrl,
  fetchShopifyProducts,
  fetchShopifyOrders,
  fetchAllShopifyLocations,
  findMissingShopifyScopes,
  normalizeShopifyDomain,
} from "../lib/shopify";
import { importShopifyOrder } from "../lib/shopifyOrderImport";
import { toNum, toStr } from "../lib/numeric";

const router: IRouter = Router();

// Everything in this router requires the tenant context. The public
// OAuth callback lives in routes/shopifyOauthCallback.ts so it can
// be mounted before clerkMiddleware (and before any other router's
// router.use(tenantMiddleware), which would otherwise short-circuit
// the unauth'd request with 401).
router.use(tenantMiddleware);

router.post("/shopify/oauth/install", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const b = req.body ?? {};
    if (!b.shopDomain || typeof b.shopDomain !== "string") {
      res.status(400).json({ error: "shopDomain is required" });
      return;
    }
    const shopDomain = normalizeShopifyDomain(b.shopDomain);
    if (!shopDomain) {
      res.status(400).json({
        error: "Shop domain must look like your-store.myshopify.com",
      });
      return;
    }

    // GC any expired states for this org (older than 10 minutes)
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    await db
      .delete(shopifyOauthStatesTable)
      .where(
        and(
          eq(shopifyOauthStatesTable.organizationId, t.organizationId),
          lt(shopifyOauthStatesTable.createdAt, tenMinAgo),
        ),
      );

    const state = crypto.randomBytes(24).toString("hex");
    await db.insert(shopifyOauthStatesTable).values({
      organizationId: t.organizationId,
      state,
      shopDomain,
    });

    const installUrl = buildInstallUrl(shopDomain, state);
    res.json({ installUrl });
  } catch (err) {
    next(err);
  }
});

router.get("/shopify/connection", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const rows = await db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, t.organizationId))
      .limit(1);
    const o = rows[0]!;

    const counts = await db
      .select({
        total: sql<number>`COUNT(*)::int`,
        mapped: sql<number>`COUNT(*) FILTER (WHERE ${warehousesTable.shopifyLocationId} IS NOT NULL)::int`,
      })
      .from(warehousesTable)
      .where(eq(warehousesTable.organizationId, t.organizationId));
    const totalWarehouseCount = Number(counts[0]?.total ?? 0);
    const mappedWarehouseCount = Number(counts[0]?.mapped ?? 0);

    res.json({
      connected: !!o.shopifyAccessToken,
      shopDomain: o.shopifyShopDomain,
      lastSyncedAt: o.shopifyLastSyncedAt
        ? o.shopifyLastSyncedAt.toISOString()
        : null,
      productCount: o.shopifyProductCount ? Number(o.shopifyProductCount) : null,
      scopes: o.shopifyScopes,
      locationId: o.shopifyLocationId,
      lastWebhookAt: o.shopifyLastWebhookAt
        ? o.shopifyLastWebhookAt.toISOString()
        : null,
      webhooksRegisteredAt: o.shopifyWebhookRegisteredAt
        ? o.shopifyWebhookRegisteredAt.toISOString()
        : null,
      mappedWarehouseCount,
      totalWarehouseCount,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/shopify/locations", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const rows = await db
      .select({
        shopDomain: organizationsTable.shopifyShopDomain,
        accessToken: organizationsTable.shopifyAccessToken,
        scopes: organizationsTable.shopifyScopes,
      })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, t.organizationId))
      .limit(1);
    const o = rows[0];
    if (!o?.shopDomain || !o?.accessToken) {
      res.status(400).json({ error: "Shopify is not connected" });
      return;
    }
    const missing = findMissingShopifyScopes(o.scopes);
    if (missing.length > 0) {
      res.status(409).json({
        error: "shopify_reinstall_required",
        message:
          "Your Shopify connection is missing required permissions. Please reconnect to grant updated access.",
        missingScopes: missing,
      });
      return;
    }

    // Cross-reference each Shopify location with the warehouse (if any)
    // already mapped to it, so the UI can show "(mapped to Main Warehouse)"
    // inline without a second round-trip.
    const [shopifyLocations, mappedRows] = await Promise.all([
      fetchAllShopifyLocations(o.shopDomain, o.accessToken),
      db
        .select({
          warehouseId: warehousesTable.id,
          warehouseName: warehousesTable.name,
          shopifyLocationId: warehousesTable.shopifyLocationId,
        })
        .from(warehousesTable)
        .where(
          and(
            eq(warehousesTable.organizationId, t.organizationId),
            isNotNull(warehousesTable.shopifyLocationId),
          ),
        ),
    ]);

    const mappedByLoc = new Map(
      mappedRows
        .filter((r) => r.shopifyLocationId)
        .map((r) => [r.shopifyLocationId!, r]),
    );

    res.json({
      locations: shopifyLocations.map((l) => {
        const m = mappedByLoc.get(l.id);
        return {
          id: l.id,
          name: l.name,
          primary: l.primary,
          mappedWarehouseId: m?.warehouseId ?? null,
          mappedWarehouseName: m?.warehouseName ?? null,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/shopify/connection", async (req, res, next) => {
  try {
    const t = req.tenant!;
    await db
      .update(organizationsTable)
      .set({
        shopifyShopDomain: null,
        shopifyAccessToken: null,
        shopifyScopes: null,
        shopifyLocationId: null,
        shopifyWebhookRegisteredAt: null,
        shopifyLastWebhookAt: null,
        shopifyLastSyncedAt: null,
        shopifyProductCount: null,
      })
      .where(eq(organizationsTable.id, t.organizationId));
    // Wipe per-item shopify mappings so a future install starts fresh
    await db
      .update(itemsTable)
      .set({
        shopifyProductId: null,
        shopifyVariantId: null,
        shopifyInventoryItemId: null,
      })
      .where(eq(itemsTable.organizationId, t.organizationId));
    // Clear warehouse → Shopify location mappings too. Stale mappings
    // would otherwise carry over to a future reconnect (possibly to a
    // different store) and silently push to the wrong locations.
    await db
      .update(warehousesTable)
      .set({ shopifyLocationId: null, shopifyLocationName: null })
      .where(eq(warehousesTable.organizationId, t.organizationId));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.post("/shopify/sync", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orgRows = await db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, t.organizationId))
      .limit(1);
    const org = orgRows[0]!;
    if (!org.shopifyShopDomain || !org.shopifyAccessToken) {
      res.status(400).json({ error: "Shopify not connected" });
      return;
    }

    const warehouseId = await getDefaultWarehouseId(t.organizationId);
    const products = await fetchShopifyProducts(
      org.shopifyShopDomain,
      org.shopifyAccessToken,
    );

    let imported = 0;
    let updated = 0;

    for (const p of products) {
      const variant = p.variants[0];
      if (!variant) continue;
      const sku = (variant.sku && variant.sku.trim()) || `SHOPIFY-${p.id}`;
      const salePrice = variant.price ?? "0";
      const qty = variant.inventory_quantity ?? 0;

      const existing = await db
        .select()
        .from(itemsTable)
        .where(
          and(
            eq(itemsTable.organizationId, t.organizationId),
            eq(itemsTable.sku, sku),
          ),
        )
        .limit(1);

      let itemId: number;
      if (existing[0]) {
        await db
          .update(itemsTable)
          .set({
            name: p.title,
            description: p.body_html,
            category: p.product_type,
            salePrice,
            shopifyProductId: String(p.id),
            shopifyVariantId: String(variant.id),
            shopifyInventoryItemId: variant.inventory_item_id
              ? String(variant.inventory_item_id)
              : null,
            imageUrl: p.image?.src ?? existing[0].imageUrl,
          })
          .where(eq(itemsTable.id, existing[0].id));
        itemId = existing[0].id;
        updated += 1;
      } else {
        const created = await db
          .insert(itemsTable)
          .values({
            organizationId: t.organizationId,
            sku,
            name: p.title,
            description: p.body_html,
            category: p.product_type,
            unit: "pcs",
            salePrice,
            purchasePrice: "0",
            taxRate: "0",
            reorderLevel: "0",
            shopifyProductId: String(p.id),
            shopifyVariantId: String(variant.id),
            shopifyInventoryItemId: variant.inventory_item_id
              ? String(variant.inventory_item_id)
              : null,
            imageUrl: p.image?.src ?? null,
          })
          .returning();
        itemId = created[0]!.id;
        imported += 1;
      }

      const stockRows = await db
        .select()
        .from(itemWarehouseStockTable)
        .where(
          and(
            eq(itemWarehouseStockTable.itemId, itemId),
            eq(itemWarehouseStockTable.warehouseId, warehouseId),
          ),
        )
        .limit(1);
      const newQty = toStr(qty);
      if (stockRows[0]) {
        const delta = qty - toNum(stockRows[0].quantity);
        await db
          .update(itemWarehouseStockTable)
          .set({ quantity: newQty })
          .where(eq(itemWarehouseStockTable.id, stockRows[0].id));
        if (delta !== 0) {
          await db.insert(stockMovementsTable).values({
            organizationId: t.organizationId,
            itemId,
            warehouseId,
            movementType: "shopify_sync",
            quantity: toStr(delta),
            referenceType: "shopify",
            notes: "Shopify inventory sync",
          });
        }
      } else {
        await db.insert(itemWarehouseStockTable).values({
          organizationId: t.organizationId,
          itemId,
          warehouseId,
          quantity: newQty,
        });
        if (qty !== 0) {
          await db.insert(stockMovementsTable).values({
            organizationId: t.organizationId,
            itemId,
            warehouseId,
            movementType: "shopify_sync",
            quantity: newQty,
            referenceType: "shopify",
            notes: "Initial Shopify import",
          });
        }
      }
    }

    const syncedAt = new Date();
    await db
      .update(organizationsTable)
      .set({
        shopifyLastSyncedAt: syncedAt,
        shopifyProductCount: String(imported + updated),
      })
      .where(eq(organizationsTable.id, t.organizationId));

    res.json({
      productsImported: imported,
      productsUpdated: updated,
      warehouseId,
      syncedAt: syncedAt.toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/shopify/sync-orders", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orgRows = await db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, t.organizationId))
      .limit(1);
    const org = orgRows[0]!;
    if (!org.shopifyShopDomain || !org.shopifyAccessToken) {
      res.status(400).json({ error: "Shopify not connected" });
      return;
    }

    const warehouseId = await getDefaultWarehouseId(t.organizationId);
    const orders = await fetchShopifyOrders(
      org.shopifyShopDomain,
      org.shopifyAccessToken,
      org.shopifyLastOrderId,
    );

    let imported = 0;
    let skipped = 0;
    let lastOrderId = org.shopifyLastOrderId
      ? Number(org.shopifyLastOrderId)
      : 0;

    for (const o of orders) {
      const outcome = await importShopifyOrder(
        t.organizationId,
        warehouseId,
        o,
      );
      if (outcome === "imported") imported += 1;
      else skipped += 1;
      if (o.id > lastOrderId) lastOrderId = o.id;
    }

    const syncedAt = new Date();
    await db
      .update(organizationsTable)
      .set({
        shopifyLastSyncedAt: syncedAt,
        shopifyLastOrderId: lastOrderId > 0 ? String(lastOrderId) : null,
      })
      .where(eq(organizationsTable.id, t.organizationId));

    res.json({
      ordersImported: imported,
      ordersSkipped: skipped,
      warehouseId,
      syncedAt: syncedAt.toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
