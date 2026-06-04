import { and, eq, isNotNull } from "drizzle-orm";
import {
  db,
  customersTable,
  itemsTable,
  itemWarehouseStockTable,
  salesOrdersTable,
  salesOrderLinesTable,
  stockMovementsTable,
  warehousesTable,
} from "@workspace/db";
import { nextOrderNumber } from "./orderHelpers";
import { generateUniqueBarcode } from "./barcodeGen";
import { toNum, toStr } from "./numeric";
import { mapShopifyPaymentStatus, type ShopifyOrder } from "./shopify";

export type ImportOutcome = "imported" | "duplicate";

const MAX_ORDER_NUMBER_RETRIES = 6;

/**
 * True when `err` is a Postgres unique-violation (23505) on the
 * per-org order-number index. `nextOrderNumber` uses a random 4-digit
 * suffix, so bulk historical imports (hundreds of orders sharing the
 * same YYMMDD) hit birthday-paradox collisions; we simply retry with a
 * freshly generated number. Collisions on the shopify-order-id index
 * are NOT retried — those mean "already imported" and are handled via
 * onConflictDoNothing returning "duplicate".
 */
function isOrderNumberCollision(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return (
    !!e &&
    e.code === "23505" &&
    e.constraint === "sales_orders_org_number_idx"
  );
}

/**
 * Insert a single Shopify order into our system. Idempotent on
 * (organization_id, shopify_order_id). Decrements stock for each
 * line item from its resolved warehouse:
 *   1. line_items[i].origin_location.id  → warehouse mapped to that
 *      Shopify location, OR
 *   2. order.location_id (top-level)     → warehouse mapped to that, OR
 *   3. defaultWarehouseId                → fallback (e.g. if Shopify
 *      didn't tell us a location, or the warehouse isn't mapped yet).
 *
 * Wrapped in a single transaction so partial failures roll back
 * cleanly — otherwise a half-imported order would be locked in
 * permanently by the (organization_id, shopify_order_id) uniqueness
 * and never get its lines/stock movements on retry.
 *
 * Returns "duplicate" if the order is already present.
 */
export async function importShopifyOrder(
  organizationId: number,
  defaultWarehouseId: number,
  o: ShopifyOrder,
): Promise<ImportOutcome> {
  // Pre-load the org's location→warehouse map. Cheap (one row per
  // mapped warehouse) and lets us resolve per-line warehouses
  // without an extra query inside the loop.
  const mappedRows = await db
    .select({
      id: warehousesTable.id,
      shopifyLocationId: warehousesTable.shopifyLocationId,
    })
    .from(warehousesTable)
    .where(
      and(
        eq(warehousesTable.organizationId, organizationId),
        isNotNull(warehousesTable.shopifyLocationId),
      ),
    );
  const locationToWarehouse = new Map<string, number>();
  for (const r of mappedRows) {
    if (r.shopifyLocationId) locationToWarehouse.set(r.shopifyLocationId, r.id);
  }
  const orderLevelLocId =
    o.location_id != null ? String(o.location_id) : null;
  const resolveWarehouseFor = (
    li: ShopifyOrder["line_items"][number],
  ): number => {
    const liLoc = li.origin_location?.id != null
      ? String(li.origin_location.id)
      : null;
    if (liLoc) {
      const w = locationToWarehouse.get(liLoc);
      if (w) return w;
    }
    if (orderLevelLocId) {
      const w = locationToWarehouse.get(orderLevelLocId);
      if (w) return w;
    }
    return defaultWarehouseId;
  };

  for (let attempt = 0; ; attempt++) {
    try {
      return await runImportTxn();
    } catch (err) {
      if (attempt < MAX_ORDER_NUMBER_RETRIES && isOrderNumberCollision(err)) {
        continue;
      }
      throw err;
    }
  }

  function runImportTxn(): Promise<ImportOutcome> {
    return db.transaction(async (tx) => {
    const existingOrder = await tx
      .select({ id: salesOrdersTable.id })
      .from(salesOrdersTable)
      .where(
        and(
          eq(salesOrdersTable.organizationId, organizationId),
          eq(salesOrdersTable.shopifyOrderId, String(o.id)),
        ),
      )
      .limit(1);
    if (existingOrder[0]) return "duplicate";

    // Resolve / create customer
    let customerId: number;
    const email = o.customer?.email ?? o.email;
    if (email) {
      const existingCust = await tx
        .select()
        .from(customersTable)
        .where(
          and(
            eq(customersTable.organizationId, organizationId),
            eq(customersTable.email, email),
          ),
        )
        .limit(1);
      if (existingCust[0]) {
        customerId = existingCust[0].id;
      } else {
        const fullName =
          [o.customer?.first_name, o.customer?.last_name]
            .filter(Boolean)
            .join(" ")
            .trim() || email;
        const created = await tx
          .insert(customersTable)
          .values({
            organizationId,
            name: fullName,
            email,
            phone: o.customer?.phone ?? null,
          })
          .returning();
        customerId = created[0]!.id;
      }
    } else {
      const placeholderName = `Shopify Guest ${o.name}`;
      const created = await tx
        .insert(customersTable)
        .values({ organizationId, name: placeholderName })
        .returning();
      customerId = created[0]!.id;
    }

    // Resolve / create items per line, build line records
    const lineRecords: Array<{
      itemId: number;
      warehouseId: number;
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
        await tx
          .select()
          .from(itemsTable)
          .where(
            and(
              eq(itemsTable.organizationId, organizationId),
              eq(itemsTable.sku, sku),
            ),
          )
          .limit(1)
      )[0];
      if (!item) {
        // Auto-generate inside the same txn so a freshly minted item
        // from a Shopify line item lands in the Barcodes screen with a
        // real Code 128 value (matches POST /items behaviour).
        const autoBarcode = await generateUniqueBarcode(organizationId, tx);
        const created = await tx
          .insert(itemsTable)
          .values({
            organizationId,
            sku,
            name: li.title,
            unit: "pcs",
            barcode: autoBarcode,
            barcodeSource: "auto",
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
      const taxAmount = li.tax_lines.reduce((s, tl) => s + toNum(tl.price), 0);
      const taxRate = lineSubtotal > 0 ? (taxAmount / lineSubtotal) * 100 : 0;
      lineRecords.push({
        itemId: item.id,
        warehouseId: resolveWarehouseFor(li),
        description: li.title,
        quantity: toStr(qty),
        unitPrice: toStr(unitPrice),
        taxRate: toStr(taxRate),
        lineSubtotal: toStr(lineSubtotal),
        lineTax: toStr(taxAmount),
        lineTotal: toStr(lineSubtotal + taxAmount),
      });
    }

    const subtotal = lineRecords.reduce((s, l) => s + toNum(l.lineSubtotal), 0);
    const taxTotal = lineRecords.reduce((s, l) => s + toNum(l.lineTax), 0);
    const total = subtotal + taxTotal;
    const orderNumber = nextOrderNumber("SO");
    const status =
      o.financial_status === "paid"
        ? "paid"
        : o.fulfillment_status === "fulfilled"
          ? "shipped"
          : "confirmed";

    // Order header carries one warehouseId column. Use the first line's
    // resolved warehouse, falling back to the default; the per-line
    // stock decrements below use each line's own warehouseId, so the
    // header value is purely informational.
    const headerWarehouseId =
      lineRecords[0]?.warehouseId ?? defaultWarehouseId;

    const insertedOrder = await tx
      .insert(salesOrdersTable)
      .values({
        organizationId,
        orderNumber,
        customerId,
        warehouseId: headerWarehouseId,
        status,
        orderDate: o.created_at.slice(0, 10),
        subtotal: toStr(subtotal),
        taxTotal: toStr(taxTotal),
        total: toStr(total),
        notes: `Imported from Shopify order ${o.name}`,
        shopifyOrderId: String(o.id),
        externalReference: `shopify:${o.id}`,
        paymentStatus: mapShopifyPaymentStatus(o.financial_status),
      })
      .onConflictDoNothing({
        target: [salesOrdersTable.organizationId, salesOrdersTable.shopifyOrderId],
      })
      .returning({ id: salesOrdersTable.id });
    if (insertedOrder.length === 0) return "duplicate";
    const orderId = insertedOrder[0]!.id;

    if (lineRecords.length > 0) {
      // salesOrderLinesTable doesn't carry warehouse_id today; strip it
      // from the persisted line payload (it's already used for the
      // per-line stock decrements below).
      await tx.insert(salesOrderLinesTable).values(
        lineRecords.map(({ warehouseId: _wh, ...rest }) => ({
          salesOrderId: orderId,
          ...rest,
        })),
      );

      // Decrement stock + record stock movements per-line, against the
      // line's own resolved warehouse. (Don't push back to Shopify here
      // — the order originated in Shopify so its stock is already
      // reflected upstream for that location.)
      for (const l of lineRecords) {
        const qty = toNum(l.quantity);
        if (qty <= 0) continue;
        const stockRows = await tx
          .select()
          .from(itemWarehouseStockTable)
          .where(
            and(
              eq(itemWarehouseStockTable.organizationId, organizationId),
              eq(itemWarehouseStockTable.itemId, l.itemId),
              eq(itemWarehouseStockTable.warehouseId, l.warehouseId),
            ),
          )
          .limit(1);
        const current = stockRows[0] ? toNum(stockRows[0].quantity) : 0;
        const newQty = current - qty;
        if (stockRows[0]) {
          await tx
            .update(itemWarehouseStockTable)
            .set({ quantity: toStr(newQty) })
            .where(
              and(
                eq(itemWarehouseStockTable.id, stockRows[0].id),
                eq(itemWarehouseStockTable.organizationId, organizationId),
              ),
            );
        } else {
          await tx.insert(itemWarehouseStockTable).values({
            organizationId,
            itemId: l.itemId,
            warehouseId: l.warehouseId,
            quantity: toStr(newQty),
          });
        }
        await tx.insert(stockMovementsTable).values({
          organizationId,
          itemId: l.itemId,
          warehouseId: l.warehouseId,
          movementType: "shopify_order",
          quantity: toStr(-qty),
          referenceType: "shopify_order",
          referenceId: orderId,
          notes: `Shopify order ${o.name}`,
        });
      }
    }

    return "imported";
    });
  }
}
