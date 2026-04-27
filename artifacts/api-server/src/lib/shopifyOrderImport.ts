import { and, eq } from "drizzle-orm";
import {
  db,
  customersTable,
  itemsTable,
  itemWarehouseStockTable,
  salesOrdersTable,
  salesOrderLinesTable,
  stockMovementsTable,
} from "@workspace/db";
import { nextOrderNumber } from "./orderHelpers";
import { toNum, toStr } from "./numeric";
import type { ShopifyOrder } from "./shopify";

export type ImportOutcome = "imported" | "duplicate";

/**
 * Insert a single Shopify order into our system. Idempotent on
 * (organization_id, shopify_order_id). Decrements stock for each
 * line item from the given warehouse.
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
  warehouseId: number,
  o: ShopifyOrder,
): Promise<ImportOutcome> {
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
        const created = await tx
          .insert(itemsTable)
          .values({
            organizationId,
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
      const taxAmount = li.tax_lines.reduce((s, tl) => s + toNum(tl.price), 0);
      const taxRate = lineSubtotal > 0 ? (taxAmount / lineSubtotal) * 100 : 0;
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

    const insertedOrder = await tx
      .insert(salesOrdersTable)
      .values({
        organizationId,
        orderNumber,
        customerId,
        warehouseId,
        status,
        orderDate: o.created_at.slice(0, 10),
        subtotal: toStr(subtotal),
        taxTotal: toStr(taxTotal),
        total: toStr(total),
        notes: `Imported from Shopify order ${o.name}`,
        shopifyOrderId: String(o.id),
        externalReference: `shopify:${o.id}`,
      })
      .onConflictDoNothing({
        target: [salesOrdersTable.organizationId, salesOrdersTable.shopifyOrderId],
      })
      .returning({ id: salesOrdersTable.id });
    if (insertedOrder.length === 0) return "duplicate";
    const orderId = insertedOrder[0]!.id;

    if (lineRecords.length > 0) {
      await tx.insert(salesOrderLinesTable).values(
        lineRecords.map((l) => ({ salesOrderId: orderId, ...l })),
      );

      // Decrement stock + record stock movements (don't push back to
      // Shopify here — the order originated in Shopify so its stock is
      // already reflected upstream).
      for (const l of lineRecords) {
        const qty = toNum(l.quantity);
        if (qty <= 0) continue;
        const stockRows = await tx
          .select()
          .from(itemWarehouseStockTable)
          .where(
            and(
              eq(itemWarehouseStockTable.itemId, l.itemId),
              eq(itemWarehouseStockTable.warehouseId, warehouseId),
            ),
          )
          .limit(1);
        const current = stockRows[0] ? toNum(stockRows[0].quantity) : 0;
        const newQty = current - qty;
        if (stockRows[0]) {
          await tx
            .update(itemWarehouseStockTable)
            .set({ quantity: toStr(newQty) })
            .where(eq(itemWarehouseStockTable.id, stockRows[0].id));
        } else {
          await tx.insert(itemWarehouseStockTable).values({
            organizationId,
            itemId: l.itemId,
            warehouseId,
            quantity: toStr(newQty),
          });
        }
        await tx.insert(stockMovementsTable).values({
          organizationId,
          itemId: l.itemId,
          warehouseId,
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
