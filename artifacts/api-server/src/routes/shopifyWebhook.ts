import { Router, type IRouter, type Request } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  itemsTable,
  itemWarehouseStockTable,
  stockMovementsTable,
  organizationsTable,
  salesOrdersTable,
  shopifyWebhookEventsTable,
  warehousesTable,
} from "@workspace/db";
import { getDefaultWarehouseId } from "../lib/tenant";
import {
  fetchShopifyProduct,
  mapShopifyPaymentStatus,
  verifyWebhookSignature,
  type ShopifyOrder,
  type ShopifyRefund,
} from "../lib/shopify";
import { importShopifyOrder } from "../lib/shopifyOrderImport";
import { cancelOrderShipments } from "../lib/cancelShipment";
import { pushStockToShopify } from "../lib/shopifyOutbound";
import { toNum, toStr } from "../lib/numeric";

const router: IRouter = Router();

/**
 * Single Shopify webhook ingress. Topic is dispatched on the
 * `X-Shopify-Topic` header. Mounted before clerkMiddleware so
 * Shopify's unauthenticated POSTs reach us.
 *
 * HMAC verification uses the raw request body (captured by app.ts
 * via the express.json `verify` callback), keyed on SHOPIFY_API_SECRET.
 *
 * Each delivery has a `X-Shopify-Webhook-Id` we dedupe on per org so
 * Shopify retries don't double-apply.
 */
router.post("/webhooks/shopify", async (req, res, next) => {
  try {
    const signature = req.header("x-shopify-hmac-sha256") ?? "";
    const raw = (req as Request & { rawBody?: string }).rawBody ?? "";
    if (!verifyWebhookSignature(raw, signature)) {
      req.log?.warn(
        { topic: req.header("x-shopify-topic") },
        "Shopify webhook signature verification failed",
      );
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    const topic = req.header("x-shopify-topic") ?? "";
    const shopDomain = (req.header("x-shopify-shop-domain") ?? "").toLowerCase();
    const webhookId = req.header("x-shopify-webhook-id") ?? "";

    if (!shopDomain) {
      res.status(400).json({ error: "Missing shop domain header" });
      return;
    }

    // Resolve organization by shop domain
    const orgRows = await db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.shopifyShopDomain, shopDomain))
      .limit(1);
    const org = orgRows[0];
    if (!org) {
      // Unknown shop — accept (so Shopify stops retrying) but no-op.
      req.log?.info({ topic, shopDomain }, "Webhook for unknown shop; ignoring");
      res.json({ ok: true, ignored: "unknown_shop" });
      return;
    }

    // Dedupe per org by Shopify's webhook id. Only a unique-constraint
    // violation (Postgres SQLSTATE 23505) means "already processed";
    // any other DB error must propagate so Shopify retries (otherwise
    // we'd silently drop events on transient DB issues).
    if (webhookId) {
      try {
        await db.insert(shopifyWebhookEventsTable).values({
          organizationId: org.id,
          shopifyEventId: webhookId,
          topic,
        });
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code === "23505") {
          res.json({ ok: true, duplicate: true });
          return;
        }
        throw err;
      }
    }

    const body = req.body as Record<string, unknown>;

    switch (topic) {
      case "orders/create":
      case "orders/updated": {
        const o = body as unknown as ShopifyOrder;
        // Pass the org's default warehouse as a fallback; per-line
        // warehouse routing happens inside importShopifyOrder using the
        // line's origin_location and the warehouse↔Shopify-location map.
        const fallbackWarehouseId = await getDefaultWarehouseId(org.id);
        const outcome = await importShopifyOrder(org.id, fallbackWarehouseId, o);

        // For orders already in our system ("duplicate"), sync the payment
        // status and fulfillment status from Shopify without re-importing.
        if (outcome === "duplicate") {
          const existingRows = await db
            .select({ id: salesOrdersTable.id, status: salesOrdersTable.status })
            .from(salesOrdersTable)
            .where(
              and(
                eq(salesOrdersTable.organizationId, org.id),
                eq(salesOrdersTable.shopifyOrderId, String(o.id)),
              ),
            )
            .limit(1);
          const existing = existingRows[0];
          if (existing) {
            const newPaymentStatus = mapShopifyPaymentStatus(o.financial_status);

            if (
              o.financial_status === "refunded" &&
              existing.status !== "refunded" &&
              existing.status !== "cancelled"
            ) {
              // Full Shopify refund — cancel all active shipments, reverse
              // stock movements, and set the order status to "refunded".
              const { touchedItems } = await cancelOrderShipments(
                org.id,
                existing.id,
                newPaymentStatus,
                "refunded",
              );
              for (const itemId of touchedItems) {
                pushStockToShopify(org.id, itemId);
              }
            } else {
              // Normal sync — advance fulfillment status if not already past
              // it, and always update paymentStatus.
              const updates: Record<string, unknown> = {
                paymentStatus: newPaymentStatus,
              };
              const TERMINAL = new Set([
                "shipped", "delivered", "invoiced", "paid", "returned",
                "refunded", "cancelled",
              ]);
              if (!TERMINAL.has(existing.status)) {
                if (o.fulfillment_status === "fulfilled") {
                  updates["status"] = "shipped";
                } else if (
                  o.fulfillment_status === "partial" &&
                  existing.status !== "partially_shipped"
                ) {
                  updates["status"] = "partially_shipped";
                }
              }
              await db
                .update(salesOrdersTable)
                .set(updates as { paymentStatus?: string | null; status?: string })
                .where(
                  and(
                    eq(salesOrdersTable.organizationId, org.id),
                    eq(salesOrdersTable.id, existing.id),
                  ),
                );
            }
          }
        }

        // Track most-recent processed Shopify order id so manual sync
        // doesn't re-fetch already-handled orders.
        const lastId = org.shopifyLastOrderId
          ? Number(org.shopifyLastOrderId)
          : 0;
        const newLast = Math.max(lastId, o.id);
        await db
          .update(organizationsTable)
          .set({
            shopifyLastWebhookAt: new Date(),
            shopifyLastOrderId: newLast > 0 ? String(newLast) : null,
          })
          .where(eq(organizationsTable.id, org.id));
        break;
      }

      case "orders/fulfilled": {
        const o = body as unknown as ShopifyOrder;
        const rows = await db
          .select({ id: salesOrdersTable.id, status: salesOrdersTable.status })
          .from(salesOrdersTable)
          .where(
            and(
              eq(salesOrdersTable.organizationId, org.id),
              eq(salesOrdersTable.shopifyOrderId, String(o.id)),
            ),
          )
          .limit(1);
        const order = rows[0];
        if (order) {
          const PAST_SHIPPED = new Set([
            "delivered", "invoiced", "paid", "returned", "refunded", "cancelled",
          ]);
          if (!PAST_SHIPPED.has(order.status)) {
            await db
              .update(salesOrdersTable)
              .set({
                status: "shipped",
                paymentStatus: mapShopifyPaymentStatus(o.financial_status),
              })
              .where(
                and(
                  eq(salesOrdersTable.organizationId, org.id),
                  eq(salesOrdersTable.id, order.id),
                ),
              );
          } else {
            await db
              .update(salesOrdersTable)
              .set({ paymentStatus: mapShopifyPaymentStatus(o.financial_status) })
              .where(
                and(
                  eq(salesOrdersTable.organizationId, org.id),
                  eq(salesOrdersTable.id, order.id),
                ),
              );
          }
        }
        await db
          .update(organizationsTable)
          .set({ shopifyLastWebhookAt: new Date() })
          .where(eq(organizationsTable.id, org.id));
        break;
      }

      case "orders/cancelled": {
        const o = body as unknown as ShopifyOrder;
        const rows = await db
          .select({ id: salesOrdersTable.id, status: salesOrdersTable.status })
          .from(salesOrdersTable)
          .where(
            and(
              eq(salesOrdersTable.organizationId, org.id),
              eq(salesOrdersTable.shopifyOrderId, String(o.id)),
            ),
          )
          .limit(1);
        const order = rows[0];
        if (order && order.status !== "cancelled") {
          const newPaymentStatus = mapShopifyPaymentStatus(o.financial_status);
          // Cancel all active shipments (reverses stock) and set order to
          // cancelled. For draft/confirmed orders with no shipments this is
          // a no-op on the shipment side and just sets the status directly.
          const { touchedItems } = await cancelOrderShipments(
            org.id,
            order.id,
            newPaymentStatus,
          );
          for (const itemId of touchedItems) {
            pushStockToShopify(org.id, itemId);
          }
        }
        await db
          .update(organizationsTable)
          .set({ shopifyLastWebhookAt: new Date() })
          .where(eq(organizationsTable.id, org.id));
        break;
      }

      case "refunds/create": {
        // Shopify fires this for every refund — partial or full. We update
        // paymentStatus immediately so the UI reflects the refund quickly.
        //
        // We deliberately do NOT reverse stock here because:
        //  - Partial refunds may have restock_type="no_restock" for some items
        //  - We don't store Shopify line-item IDs, so per-line restocking is
        //    not yet possible
        //
        // Full-refund stock reversal (cancel all shipments, set order status
        // to "refunded") is handled by the `orders/updated` webhook which fires
        // immediately after and carries the authoritative financial_status.
        const r = body as unknown as ShopifyRefund;
        const refundOrderRows = await db
          .select({ id: salesOrdersTable.id })
          .from(salesOrdersTable)
          .where(
            and(
              eq(salesOrdersTable.organizationId, org.id),
              eq(salesOrdersTable.shopifyOrderId, String(r.order_id)),
            ),
          )
          .limit(1);
        const refundOrder = refundOrderRows[0];
        // paymentStatus is intentionally not set here: the authoritative
        // financial_status comes from the `orders/updated` webhook that
        // Shopify fires immediately after. Setting it unconditionally would
        // display "refunded" for partial refunds before orders/updated
        // corrects it to "partially_paid".
        await db
          .update(organizationsTable)
          .set({ shopifyLastWebhookAt: new Date() })
          .where(eq(organizationsTable.id, org.id));
        break;
      }

      case "inventory_levels/update": {
        // Shopify sends: { inventory_item_id, location_id, available, ... }
        // Route the change to the warehouse mapped to this Shopify
        // location. If no warehouse is mapped, log + skip — we don't
        // want to silently mash all locations into the default
        // warehouse, that would corrupt per-warehouse stock.
        const invItemId = String(body["inventory_item_id"] ?? "");
        const locationId = String(body["location_id"] ?? "");
        const available = Number(body["available"] ?? 0);
        if (!invItemId || !locationId) break;

        const whRows = await db
          .select({ id: warehousesTable.id })
          .from(warehousesTable)
          .where(
            and(
              eq(warehousesTable.organizationId, org.id),
              eq(warehousesTable.shopifyLocationId, locationId),
            ),
          )
          .limit(1);
        const warehouseId = whRows[0]?.id;
        if (!warehouseId) {
          req.log?.info(
            { topic, shopDomain, locationId },
            "inventory_levels/update for unmapped Shopify location; skipping",
          );
          break;
        }

        const itemRows = await db
          .select()
          .from(itemsTable)
          .where(
            and(
              eq(itemsTable.organizationId, org.id),
              eq(itemsTable.shopifyInventoryItemId, invItemId),
            ),
          )
          .limit(1);
        const item = itemRows[0];
        if (!item) break;
        const stockRows = await db
          .select()
          .from(itemWarehouseStockTable)
          .where(
            and(
              eq(itemWarehouseStockTable.organizationId, org.id),
              eq(itemWarehouseStockTable.itemId, item.id),
              eq(itemWarehouseStockTable.warehouseId, warehouseId),
            ),
          )
          .limit(1);
        const current = stockRows[0] ? toNum(stockRows[0].quantity) : 0;
        const delta = available - current;
        if (stockRows[0]) {
          await db
            .update(itemWarehouseStockTable)
            .set({ quantity: toStr(available) })
            .where(
              and(
                eq(itemWarehouseStockTable.id, stockRows[0].id),
                eq(itemWarehouseStockTable.organizationId, org.id),
              ),
            );
        } else {
          await db.insert(itemWarehouseStockTable).values({
            organizationId: org.id,
            itemId: item.id,
            warehouseId,
            quantity: toStr(available),
          });
        }
        if (delta !== 0) {
          await db.insert(stockMovementsTable).values({
            organizationId: org.id,
            itemId: item.id,
            warehouseId,
            movementType: "shopify_webhook",
            quantity: toStr(delta),
            referenceType: "shopify",
            notes: "Shopify inventory_levels/update",
          });
        }
        await db
          .update(organizationsTable)
          .set({ shopifyLastWebhookAt: new Date() })
          .where(eq(organizationsTable.id, org.id));
        break;
      }

      case "products/update": {
        // Fetch only the changed product (efficient: one API call vs all-products).
        const productId = String(body["id"] ?? "");
        if (!productId || !org.shopifyAccessToken || !org.shopifyShopDomain) {
          break;
        }
        try {
          const fresh = await fetchShopifyProduct(
            org.shopifyShopDomain,
            org.shopifyAccessToken,
            productId,
          );
          if (fresh) {
            const variant = fresh.variants[0];
            if (variant) {
              const variantIdStr = String(variant.id);
              // Prefer to match by stable shopifyVariantId so SKU renames
              // in Shopify still land on the right inventory row.
              let matchRows = await db
                .select({ id: itemsTable.id })
                .from(itemsTable)
                .where(
                  and(
                    eq(itemsTable.organizationId, org.id),
                    eq(itemsTable.shopifyVariantId, variantIdStr),
                  ),
                )
                .limit(1); // org-scope-allow: matched by shopifyVariantId (globally unique Shopify id)
              if (!matchRows[0]) {
                // Fall back to SKU match for items that were imported
                // before shopifyVariantId was recorded.
                const sku =
                  (variant.sku && variant.sku.trim()) || `SHOPIFY-${fresh.id}`;
                matchRows = await db
                  .select({ id: itemsTable.id })
                  .from(itemsTable)
                  .where(
                    and(
                      eq(itemsTable.organizationId, org.id),
                      eq(itemsTable.sku, sku),
                    ),
                  )
                  .limit(1);
              }
              const itemId = matchRows[0]?.id;
              if (itemId) {
                // Map Shopify status → inventory active/inactive.
                // active → unarchive; draft/archived → archive.
                const shopifyStatus = fresh.status ?? "active";
                const archivedAtValue =
                  shopifyStatus === "active" ? null : new Date();

                await db
                  .update(itemsTable)
                  .set({
                    name: fresh.title,
                    description: fresh.body_html,
                    category: fresh.product_type,
                    salePrice: variant.price ?? "0",
                    barcode: variant.barcode ?? null,
                    archivedAt: archivedAtValue,
                    shopifyProductId: String(fresh.id),
                    shopifyVariantId: variantIdStr,
                    shopifyInventoryItemId: variant.inventory_item_id
                      ? String(variant.inventory_item_id)
                      : null,
                    imageUrl: fresh.image?.src ?? null,
                  })
                  .where(
                    and(
                      eq(itemsTable.organizationId, org.id),
                      eq(itemsTable.id, itemId),
                    ),
                  );
              }
            }
          }
        } catch (err) {
          req.log?.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "products/update refresh failed",
          );
        }
        await db
          .update(organizationsTable)
          .set({ shopifyLastWebhookAt: new Date() })
          .where(eq(organizationsTable.id, org.id));
        break;
      }

      case "app/uninstalled": {
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
            shopifyLastOrderId: null,
          })
          .where(eq(organizationsTable.id, org.id));
        await db
          .update(itemsTable)
          .set({
            shopifyProductId: null,
            shopifyVariantId: null,
            shopifyInventoryItemId: null,
          })
          .where(eq(itemsTable.organizationId, org.id));
        // Drop warehouse mappings so a fresh install (possibly against a
        // different store) doesn't inherit stale Shopify location ids.
        await db
          .update(warehousesTable)
          .set({ shopifyLocationId: null, shopifyLocationName: null })
          .where(eq(warehousesTable.organizationId, org.id));
        break;
      }

      default:
        req.log?.info({ topic, shopDomain }, "Unhandled Shopify webhook topic");
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
