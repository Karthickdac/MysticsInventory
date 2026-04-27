import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  organizationsTable,
  itemsTable,
  itemWarehouseStockTable,
  stockMovementsTable,
  customersTable,
  salesOrdersTable,
  salesOrderLinesTable,
} from "@workspace/db";
import { tenantMiddleware, getDefaultWarehouseId } from "../lib/tenant";
import {
  fetchShopifyProducts,
  fetchShopifyOrders,
  normalizeShopifyDomain,
} from "../lib/shopify";
import { nextOrderNumber } from "../lib/orderHelpers";
import { toNum, toStr } from "../lib/numeric";

const router: IRouter = Router();
router.use(tenantMiddleware);

router.get("/shopify/connection", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const rows = await db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, t.organizationId))
      .limit(1);
    const o = rows[0]!;
    res.json({
      connected: !!o.shopifyAccessToken,
      shopDomain: o.shopifyShopDomain,
      lastSyncedAt: o.shopifyLastSyncedAt ? o.shopifyLastSyncedAt.toISOString() : null,
      productCount: o.shopifyProductCount ? Number(o.shopifyProductCount) : null,
    });
  } catch (err) {
    next(err);
  }
});

router.put("/shopify/connection", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const b = req.body ?? {};
    if (!b.shopDomain || !b.accessToken) {
      res.status(400).json({ error: "shopDomain and accessToken are required" });
      return;
    }
    const normalized = normalizeShopifyDomain(String(b.shopDomain));
    if (!normalized) {
      res.status(400).json({
        error: "Shop domain must look like your-store.myshopify.com",
      });
      return;
    }
    const updated = await db
      .update(organizationsTable)
      .set({
        shopifyShopDomain: normalized,
        shopifyAccessToken: b.accessToken,
      })
      .where(eq(organizationsTable.id, t.organizationId))
      .returning();
    const o = updated[0]!;
    res.json({
      connected: true,
      shopDomain: o.shopifyShopDomain,
      lastSyncedAt: o.shopifyLastSyncedAt ? o.shopifyLastSyncedAt.toISOString() : null,
      productCount: o.shopifyProductCount ? Number(o.shopifyProductCount) : null,
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
        shopifyLastSyncedAt: null,
        shopifyProductCount: null,
      })
      .where(eq(organizationsTable.id, t.organizationId));
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
      const externalRef = `shopify:${o.id}`;
      const existingOrder = await db
        .select({ id: salesOrdersTable.id })
        .from(salesOrdersTable)
        .where(
          and(
            eq(salesOrdersTable.organizationId, t.organizationId),
            eq(salesOrdersTable.shopifyOrderId, String(o.id)),
          ),
        )
        .limit(1);
      if (existingOrder[0]) {
        skipped += 1;
        if (o.id > lastOrderId) lastOrderId = o.id;
        continue;
      }

      const skipDueToRace = (insertResult: { id: number }[]) => {
        if (insertResult.length === 0) {
          skipped += 1;
          if (o.id > lastOrderId) lastOrderId = o.id;
          return true;
        }
        return false;
      };

      let customerId: number | null = null;
      const email = o.customer?.email ?? o.email;
      if (email) {
        const existingCust = await db
          .select()
          .from(customersTable)
          .where(
            and(
              eq(customersTable.organizationId, t.organizationId),
              eq(customersTable.email, email),
            ),
          )
          .limit(1);
        if (existingCust[0]) {
          customerId = existingCust[0].id;
        } else {
          const fullName = [
            o.customer?.first_name,
            o.customer?.last_name,
          ]
            .filter(Boolean)
            .join(" ")
            .trim() || email;
          const created = await db
            .insert(customersTable)
            .values({
              organizationId: t.organizationId,
              name: fullName,
              email,
              phone: o.customer?.phone ?? null,
            })
            .returning();
          customerId = created[0]!.id;
        }
      } else {
        const placeholderName = `Shopify Guest ${o.name}`;
        const created = await db
          .insert(customersTable)
          .values({
            organizationId: t.organizationId,
            name: placeholderName,
          })
          .returning();
        customerId = created[0]!.id;
      }

      const lineRecords: Array<{
        itemId: number;
        description: string | null;
        quantity: string;
        unitPrice: string;
        taxRate: string;
        lineSubtotal: string;
        lineTax: string;
        lineTotal: string;
      }> = [];

      for (const li of o.line_items) {
        const sku = (li.sku && li.sku.trim()) || `SHOPIFY-LI-${li.id}`;
        let item = (
          await db
            .select()
            .from(itemsTable)
            .where(
              and(
                eq(itemsTable.organizationId, t.organizationId),
                eq(itemsTable.sku, sku),
              ),
            )
            .limit(1)
        )[0];
        if (!item) {
          const created = await db
            .insert(itemsTable)
            .values({
              organizationId: t.organizationId,
              sku,
              name: li.title,
              unit: "pcs",
              salePrice: li.price,
              purchasePrice: "0",
              taxRate: "0",
              reorderLevel: "0",
            })
            .returning();
          item = created[0]!;
        }
        const qty = li.quantity;
        const unitPrice = toNum(li.price);
        const lineSubtotal = unitPrice * qty;
        const taxAmount = li.tax_lines.reduce(
          (sum, tl) => sum + toNum(tl.price),
          0,
        );
        const taxRate =
          lineSubtotal > 0 ? (taxAmount / lineSubtotal) * 100 : 0;
        lineRecords.push({
          itemId: item.id,
          description: li.title,
          quantity: toStr(qty),
          unitPrice: toStr(unitPrice),
          taxRate: toStr(taxRate),
          lineSubtotal: toStr(lineSubtotal),
          lineTax: toStr(taxAmount),
          lineTotal: toStr(lineSubtotal + taxAmount),
        });
      }

      const subtotal = lineRecords.reduce(
        (s, l) => s + toNum(l.lineSubtotal),
        0,
      );
      const taxTotal = lineRecords.reduce(
        (s, l) => s + toNum(l.lineTax),
        0,
      );
      const total = subtotal + taxTotal;
      const orderNumber = nextOrderNumber("SO");
      const status =
        o.financial_status === "paid"
          ? "paid"
          : o.fulfillment_status === "fulfilled"
            ? "shipped"
            : "confirmed";

      const insertedOrder = await db
        .insert(salesOrdersTable)
        .values({
          organizationId: t.organizationId,
          orderNumber,
          customerId: customerId!,
          warehouseId,
          status,
          orderDate: o.created_at.slice(0, 10),
          subtotal: toStr(subtotal),
          taxTotal: toStr(taxTotal),
          total: toStr(total),
          notes: `Imported from Shopify order ${o.name}`,
          shopifyOrderId: String(o.id),
          externalReference: externalRef,
        })
        .onConflictDoNothing({
          target: [
            salesOrdersTable.organizationId,
            salesOrdersTable.shopifyOrderId,
          ],
        })
        .returning({ id: salesOrdersTable.id });
      if (skipDueToRace(insertedOrder)) continue;
      const orderId = insertedOrder[0]!.id;
      if (lineRecords.length > 0) {
        await db.insert(salesOrderLinesTable).values(
          lineRecords.map((l) => ({
            salesOrderId: orderId,
            ...l,
          })),
        );
      }
      imported += 1;
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
