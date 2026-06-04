import crypto from "node:crypto";
import { Router, type IRouter } from "express";
import { and, eq, lt, isNotNull, inArray, sql } from "drizzle-orm";
import {
  db,
  organizationsTable,
  itemsTable,
  itemWarehouseStockTable,
  salesOrdersTable,
  stockMovementsTable,
  shopifyOauthStatesTable,
  warehousesTable,
} from "@workspace/db";
import { tenantMiddleware, getDefaultWarehouseId } from "../lib/tenant";
import {
  buildInstallUrl,
  fetchShopifyProducts,
  fetchShopifyOrders,
  fetchShopifyOrdersPage,
  fetchShopifyOrdersCount,
  fetchAllShopifyLocations,
  findMissingShopifyScopes,
  normalizeShopifyDomain,
  getPrimaryLocationId,
  registerWebhooks,
  type ShopifyOrder,
} from "../lib/shopify";
import { importShopifyOrder } from "../lib/shopifyOrderImport";
import {
  createImportJob,
  getImportJob,
  incrementImportJob,
  finishImportJob,
} from "../lib/shopifyImportJobs";
import { generateUniqueBarcode } from "../lib/barcodeGen";
import { toNum, toStr } from "../lib/numeric";
import { pushProductFieldsToShopify, pushStockToShopify } from "../lib/shopifyOutbound";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

router.post("/shopify/connect-custom", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const b = req.body ?? {};
    if (!b.shopDomain || typeof b.shopDomain !== "string") {
      res.status(400).json({ error: "shopDomain is required" });
      return;
    }
    if (!b.accessToken || typeof b.accessToken !== "string") {
      res.status(400).json({ error: "accessToken is required" });
      return;
    }
    const shopDomain = normalizeShopifyDomain(b.shopDomain);
    if (!shopDomain) {
      res
        .status(400)
        .json({ error: "Shop domain must look like your-store.myshopify.com" });
      return;
    }
    const accessToken = b.accessToken.trim();

    // Validate the token by calling the Shopify API
    const testRes = await fetch(
      `https://${shopDomain}/admin/api/2024-04/shop.json`,
      { headers: { "X-Shopify-Access-Token": accessToken } },
    );
    if (!testRes.ok) {
      res.status(400).json({
        error:
          testRes.status === 401
            ? "Invalid access token — make sure you copied the Admin API access token from your Shopify custom app."
            : `Shopify returned ${testRes.status}. Check the store domain and token.`,
      });
      return;
    }

    // Get the primary location for inventory sync
    const locationId = await getPrimaryLocationId(shopDomain, accessToken);

    await db
      .update(organizationsTable)
      .set({
        shopifyShopDomain: shopDomain,
        shopifyAccessToken: accessToken,
        shopifyScopes: null, // Custom apps don't return scopes via OAuth
        shopifyLocationId: locationId,
      })
      .where(eq(organizationsTable.id, t.organizationId));

    // Register webhooks (best effort)
    try {
      await registerWebhooks(shopDomain, accessToken);
      await db
        .update(organizationsTable)
        .set({ shopifyWebhookRegisteredAt: new Date() })
        .where(eq(organizationsTable.id, t.organizationId));
    } catch (err) {
      req.log?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to register webhooks for custom app (non-fatal)",
      );
    }

    // Return the connection status same shape as GET /shopify/connection
    const orgRows = await db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, t.organizationId))
      .limit(1);
    const o = orgRows[0]!;
    const counts = await db
      .select({
        total: sql<number>`COUNT(*)::int`,
        mapped: sql<number>`COUNT(*) FILTER (WHERE ${warehousesTable.shopifyLocationId} IS NOT NULL)::int`,
      })
      .from(warehousesTable)
      .where(eq(warehousesTable.organizationId, t.organizationId));

    res.json({
      connected: !!o.shopifyAccessToken,
      shopDomain: o.shopifyShopDomain,
      lastSyncedAt: null,
      productCount: null,
      scopes: o.shopifyScopes,
      locationId: o.shopifyLocationId,
      lastWebhookAt: null,
      webhooksRegisteredAt: o.shopifyWebhookRegisteredAt
        ? o.shopifyWebhookRegisteredAt.toISOString()
        : null,
      mappedWarehouseCount: Number(counts[0]?.mapped ?? 0),
      totalWarehouseCount: Number(counts[0]?.total ?? 0),
    });
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

    // Upsert one Shopify variant as a (leaf) inventory row and sync its
    // on-hand stock at the configured warehouse. Used for both flat
    // single-variant products and as the per-variant pass for multi-
    // variant products (with `parentItemId` set in the latter case).
    async function upsertVariantRow(
      p: typeof products[number],
      v: typeof products[number]["variants"][number],
      sku: string,
      parentItemId: number | null,
      variantOptions: Record<string, string> | null,
    ): Promise<void> {
      const salePrice = v.price ?? "0";
      const qty = v.inventory_quantity ?? 0;
      // Match by Shopify variant id first (stable across SKU renames),
      // then fall back to SKU for the first sync.
      let existing = await db
        .select()
        .from(itemsTable)
        .where(
          and(
            eq(itemsTable.organizationId, t.organizationId),
            eq(itemsTable.shopifyVariantId, String(v.id)),
          ),
        )
        .limit(1);
      if (!existing[0]) {
        existing = await db
          .select()
          .from(itemsTable)
          .where(
            and(
              eq(itemsTable.organizationId, t.organizationId),
              eq(itemsTable.sku, sku),
            ),
          )
          .limit(1);
      }

      let itemId: number;
      if (existing[0]) {
        await db
          .update(itemsTable)
          .set({
            // For variant rows we keep the parent's title as a prefix.
            name: parentItemId
              ? `${p.title} — ${v.title ?? Object.values(variantOptions ?? {}).join(" / ")}`
              : p.title,
            description: p.body_html,
            category: p.product_type,
            salePrice,
            shopifyProductId: String(p.id),
            shopifyVariantId: String(v.id),
            shopifyInventoryItemId: v.inventory_item_id
              ? String(v.inventory_item_id)
              : null,
            imageUrl: p.image?.src ?? existing[0].imageUrl,
            parentItemId: parentItemId ?? existing[0].parentItemId,
            variantOptions: variantOptions ?? existing[0].variantOptions,
          })
          .where(
            and(
              eq(itemsTable.organizationId, t.organizationId),
              eq(itemsTable.id, existing[0].id),
            ),
          );
        itemId = existing[0].id;
        updated += 1;
      } else {
        // Shopify-imported items participate in the same per-org
        // auto-barcode scheme as locally-created items so the
        // Barcodes management screen shows them with a real value.
        const autoBarcode = await generateUniqueBarcode(t.organizationId);
        const created = await db
          .insert(itemsTable)
          .values({
            organizationId: t.organizationId,
            sku,
            name: parentItemId
              ? `${p.title} — ${v.title ?? Object.values(variantOptions ?? {}).join(" / ")}`
              : p.title,
            description: p.body_html,
            category: p.product_type,
            unit: "pcs",
            barcode: autoBarcode,
            barcodeSource: "auto",
            salePrice,
            purchasePrice: "0",
            taxRate: "0",
            reorderLevel: "0",
            shopifyProductId: String(p.id),
            shopifyVariantId: String(v.id),
            shopifyInventoryItemId: v.inventory_item_id
              ? String(v.inventory_item_id)
              : null,
            imageUrl: p.image?.src ?? null,
            parentItemId: parentItemId ?? null,
            variantOptions: variantOptions ?? null,
            hasVariants: false,
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
            eq(itemWarehouseStockTable.organizationId, t.organizationId),
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
          .where(
            and(
              eq(itemWarehouseStockTable.id, stockRows[0].id),
              eq(itemWarehouseStockTable.organizationId, t.organizationId),
            ),
          );
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

    for (const p of products) {
      if (!p.variants.length) continue;

      // Multi-variant Shopify products → create a parent item with
      // `hasVariants = true` and one child per variant. We key the
      // parent on a synthetic `SHOPIFY-PRODUCT-{id}` SKU so the parent
      // is stable across syncs even if Shopify variant ids change.
      if (p.variants.length > 1) {
        const axes = (p.options ?? [])
          .map((o) => (typeof o.name === "string" ? o.name.trim() : ""))
          .filter((n) => n.length > 0)
          .slice(0, 3);
        if (axes.length === 0) {
          // Shopify always returns at least one option ("Title"); guard
          // against malformed payloads by falling back to the variant
          // title as a single axis label.
          axes.push("Title");
        }
        const parentSku = `SHOPIFY-PRODUCT-${p.id}`;
        const parentExisting = await db
          .select()
          .from(itemsTable)
          .where(
            and(
              eq(itemsTable.organizationId, t.organizationId),
              eq(itemsTable.sku, parentSku),
            ),
          )
          .limit(1);
        let parentId: number;
        if (parentExisting[0]) {
          await db
            .update(itemsTable)
            .set({
              name: p.title,
              description: p.body_html,
              category: p.product_type,
              imageUrl: p.image?.src ?? parentExisting[0].imageUrl,
              shopifyProductId: String(p.id),
              hasVariants: true,
              variantOptions: { axes },
            })
            .where(
              and(
                eq(itemsTable.organizationId, t.organizationId),
                eq(itemsTable.id, parentExisting[0].id),
              ),
            );
          parentId = parentExisting[0].id;
          updated += 1;
        } else {
          // Variant parents get an auto-barcode too so labels can be
          // printed for the parent row in the catalog (matches POST /items).
          const autoBarcode = await generateUniqueBarcode(t.organizationId);
          const created = await db
            .insert(itemsTable)
            .values({
              organizationId: t.organizationId,
              sku: parentSku,
              name: p.title,
              description: p.body_html,
              category: p.product_type,
              unit: "pcs",
              barcode: autoBarcode,
              barcodeSource: "auto",
              salePrice: "0",
              purchasePrice: "0",
              taxRate: "0",
              reorderLevel: "0",
              imageUrl: p.image?.src ?? null,
              shopifyProductId: String(p.id),
              hasVariants: true,
              variantOptions: { axes },
            })
            .returning();
          parentId = created[0]!.id;
          imported += 1;
        }

        for (const v of p.variants) {
          const variantSku =
            (v.sku && v.sku.trim()) || `SHOPIFY-${p.id}-${v.id}`;
          const opts: Record<string, string> = {};
          const optionVals = [v.option1, v.option2, v.option3];
          axes.forEach((axisName, idx) => {
            const val = optionVals[idx];
            if (typeof val === "string" && val.trim()) {
              opts[axisName] = val.trim();
            } else {
              opts[axisName] = v.title ?? "Default";
            }
          });
          await upsertVariantRow(p, v, variantSku, parentId, opts);
        }
      } else {
        // Single-variant Shopify product → flat row, current behaviour.
        const v = p.variants[0]!;
        const sku = (v.sku && v.sku.trim()) || `SHOPIFY-${p.id}`;
        await upsertVariantRow(p, v, sku, null, null);
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

/**
 * Force-push all linked products (those with a shopifyProductId) from
 * inventory to Shopify. Fire-and-forget per item so the response is
 * immediate; each push coalesces via pushProductFieldsToShopify's
 * in-flight tracker.
 */
router.post("/shopify/push-products", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orgRows = await db
      .select({
        shopDomain: organizationsTable.shopifyShopDomain,
        accessToken: organizationsTable.shopifyAccessToken,
      })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, t.organizationId))
      .limit(1);
    const org = orgRows[0];
    if (!org?.shopDomain || !org?.accessToken) {
      res.status(400).json({ error: "Shopify not connected" });
      return;
    }

    const linkedItems = await db
      .select({ id: itemsTable.id })
      .from(itemsTable)
      .where(
        and(
          eq(itemsTable.organizationId, t.organizationId),
          isNotNull(itemsTable.shopifyProductId),
          isNotNull(itemsTable.shopifyVariantId),
        ),
      );

    for (const item of linkedItems) {
      pushProductFieldsToShopify(t.organizationId, item.id);
      pushStockToShopify(t.organizationId, item.id);
    }

    res.json({ itemCount: linkedItems.length });
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

/**
 * Run a historical import in the background, updating the job record as
 * it pages through Shopify. Never throws — failures are recorded on the
 * job so the polling client can surface them.
 */
async function runHistoricalImport(
  jobId: string,
  organizationId: number,
  warehouseId: number,
  shopDomain: string,
  accessToken: string,
  opts: {
    createdAtMin?: string;
    createdAtMax?: string;
    orderIds?: string[];
  },
): Promise<void> {
  const processOrder = async (o: ShopifyOrder) => {
    try {
      const outcome = await importShopifyOrder(organizationId, warehouseId, o);
      await incrementImportJob(jobId, {
        processed: 1,
        imported: outcome === "imported" ? 1 : 0,
        skipped: outcome === "duplicate" ? 1 : 0,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await incrementImportJob(jobId, {
        processed: 1,
        failed: 1,
        failedOrder: { id: String(o.id), reason },
      });
    }
  };

  try {
    if (opts.orderIds && opts.orderIds.length > 0) {
      // Import a specific set of ids (the reconciliation "import missing"
      // path). Shopify's `ids` filter accepts up to 250 per call.
      for (let i = 0; i < opts.orderIds.length; i += 250) {
        const chunk = opts.orderIds.slice(i, i + 250);
        let pageInfo: string | null = null;
        do {
          const page = await fetchShopifyOrdersPage(shopDomain, accessToken, {
            ids: pageInfo ? undefined : chunk,
            pageInfo,
          });
          for (const o of page.orders) await processOrder(o);
          pageInfo = page.nextPageInfo;
        } while (pageInfo);
      }
    } else {
      let pageInfo: string | null = null;
      do {
        const page = await fetchShopifyOrdersPage(shopDomain, accessToken, {
          createdAtMin: pageInfo ? undefined : opts.createdAtMin,
          createdAtMax: pageInfo ? undefined : opts.createdAtMax,
          pageInfo,
        });
        for (const o of page.orders) await processOrder(o);
        pageInfo = page.nextPageInfo;
      } while (pageInfo);
    }

    await db
      .update(organizationsTable)
      .set({ shopifyLastSyncedAt: new Date() })
      .where(eq(organizationsTable.id, organizationId));
    const finalJob = await getImportJob(organizationId, jobId);
    await finishImportJob(
      jobId,
      (finalJob?.failed ?? 0) > 0 ? "completed_with_errors" : "completed",
    );
  } catch (err) {
    await finishImportJob(
      jobId,
      "failed",
      err instanceof Error ? err.message : String(err),
    );
  }
}

router.post("/shopify/import-orders", async (req, res, next) => {
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

    const b = req.body ?? {};
    const rawIds: unknown = b.orderIds;
    const orderIds = Array.isArray(rawIds)
      ? rawIds.map((x) => String(x)).filter((s) => s.length > 0)
      : undefined;
    const fromDate = typeof b.fromDate === "string" ? b.fromDate : null;
    const toDate = typeof b.toDate === "string" ? b.toDate : null;

    let createdAtMin: string | undefined;
    let createdAtMax: string | undefined;
    let total: number | null = null;

    if (orderIds && orderIds.length > 0) {
      total = orderIds.length;
    } else {
      if (!fromDate || !toDate || !DATE_RE.test(fromDate) || !DATE_RE.test(toDate)) {
        res.status(400).json({
          error: "Provide fromDate and toDate (YYYY-MM-DD), or orderIds",
        });
        return;
      }
      if (fromDate > toDate) {
        res.status(400).json({ error: "fromDate must be on or before toDate" });
        return;
      }
      createdAtMin = `${fromDate}T00:00:00Z`;
      createdAtMax = `${toDate}T23:59:59Z`;
      try {
        total = await fetchShopifyOrdersCount(
          org.shopifyShopDomain,
          org.shopifyAccessToken,
          { createdAtMin, createdAtMax },
        );
      } catch {
        // Non-fatal: progress will show processed count without a total.
        total = null;
      }
    }

    const warehouseId = await getDefaultWarehouseId(t.organizationId);
    const job = await createImportJob({
      organizationId: t.organizationId,
      fromDate: orderIds ? null : fromDate,
      toDate: orderIds ? null : toDate,
      total,
    });

    // Fire-and-forget: the client polls GET /shopify/import-orders/:jobId.
    void runHistoricalImport(
      job.id,
      t.organizationId,
      warehouseId,
      org.shopifyShopDomain,
      org.shopifyAccessToken,
      { createdAtMin, createdAtMax, orderIds },
    );

    res.status(202).json({ jobId: job.id });
  } catch (err) {
    next(err);
  }
});

router.get("/shopify/import-orders/:jobId", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const job = await getImportJob(t.organizationId, req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Import job not found" });
      return;
    }
    res.json({
      jobId: job.id,
      status: job.status,
      total: job.total,
      processed: job.processed,
      imported: job.imported,
      skipped: job.skipped,
      failed: job.failed,
      failedOrders: job.failedOrders,
      fromDate: job.fromDate,
      toDate: job.toDate,
      error: job.error,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/shopify/reconcile", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orgRows = await db
      .select({
        shopDomain: organizationsTable.shopifyShopDomain,
        accessToken: organizationsTable.shopifyAccessToken,
      })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, t.organizationId))
      .limit(1);
    const org = orgRows[0];
    if (!org?.shopDomain || !org?.accessToken) {
      res.status(400).json({ error: "Shopify not connected" });
      return;
    }

    const from = typeof req.query.from === "string" ? req.query.from : "";
    const to = typeof req.query.to === "string" ? req.query.to : "";
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
      res.status(400).json({ error: "from and to (YYYY-MM-DD) are required" });
      return;
    }
    if (from > to) {
      res.status(400).json({ error: "from must be on or before to" });
      return;
    }
    const createdAtMin = `${from}T00:00:00Z`;
    const createdAtMax = `${to}T23:59:59Z`;

    // Page through Shopify, collecting just id + total_price for the range.
    const shopifyIds: string[] = [];
    let shopifyTotal = 0;
    let pageInfo: string | null = null;
    do {
      const page = await fetchShopifyOrdersPage(org.shopDomain, org.accessToken, {
        createdAtMin: pageInfo ? undefined : createdAtMin,
        createdAtMax: pageInfo ? undefined : createdAtMax,
        fields: pageInfo ? undefined : "id,total_price",
        pageInfo,
      });
      for (const o of page.orders) {
        shopifyIds.push(String(o.id));
        shopifyTotal += toNum(o.total_price);
      }
      pageInfo = page.nextPageInfo;
    } while (pageInfo);

    // Pull matching inventory rows (org-scoped) keyed by shopifyOrderId.
    const idCounts = new Map<string, number>();
    let inventoryTotal = 0;
    if (shopifyIds.length > 0) {
      for (let i = 0; i < shopifyIds.length; i += 500) {
        const chunk = shopifyIds.slice(i, i + 500);
        const rows = await db
          .select({
            shopifyOrderId: salesOrdersTable.shopifyOrderId,
            total: salesOrdersTable.total,
          })
          .from(salesOrdersTable)
          .where(
            and(
              eq(salesOrdersTable.organizationId, t.organizationId),
              inArray(salesOrdersTable.shopifyOrderId, chunk),
            ),
          );
        for (const r of rows) {
          if (!r.shopifyOrderId) continue;
          idCounts.set(
            r.shopifyOrderId,
            (idCounts.get(r.shopifyOrderId) ?? 0) + 1,
          );
          inventoryTotal += toNum(r.total);
        }
      }
    }

    const missingInInventory = shopifyIds.filter((id) => !idCounts.has(id));
    const duplicates = [...idCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([id]) => id);

    res.json({
      from,
      to,
      shopifyCount: shopifyIds.length,
      inventoryCount: idCounts.size,
      shopifyTotal: toStr(shopifyTotal),
      inventoryTotal: toStr(inventoryTotal),
      missingInInventory,
      duplicates,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
