import { and, eq, sql } from "drizzle-orm";
import {
  db,
  itemWarehouseStockTable,
  salesOrderLinesTable,
  salesOrdersTable,
  shipmentLinesTable,
  shipmentsTable,
  stockMovementsTable,
} from "@workspace/db";
import {
  applyBatchStockChange,
  insertBatchMovement,
  loadBatchMovementsForParents,
} from "./batches";
import { toNum, toStr } from "./numeric";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Core shipment cancellation: lock the shipment row, mark it cancelled,
 * reverse all `sale` stock movements, and decrement each order line's
 * quantityShipped.
 *
 * Does NOT validate order status and does NOT call
 * deriveAndUpdateOrderStatus — those are the caller's responsibility.
 *
 * Safe to call from an existing transaction. The FOR UPDATE lock on the
 * shipment row is idempotent within the same Postgres transaction.
 */
export async function cancelShipmentCore(
  tx: Tx,
  organizationId: number,
  shipmentId: number,
): Promise<
  | { kind: "ok"; salesOrderId: number; touchedItems: number[] }
  | { kind: "notfound" }
  | { kind: "already_cancelled" }
> {
  const rows = await tx
    .select()
    .from(shipmentsTable)
    .where(
      and(
        eq(shipmentsTable.id, shipmentId),
        eq(shipmentsTable.organizationId, organizationId),
      ),
    )
    .for("update")
    .limit(1);
  const shipment = rows[0];
  if (!shipment) return { kind: "notfound" };
  if (shipment.status === "cancelled") return { kind: "already_cancelled" };

  const shipLines = await tx
    .select({
      line: shipmentLinesTable,
      orderLineId: salesOrderLinesTable.id,
      orderLineQuantityShipped: salesOrderLinesTable.quantityShipped,
      itemId: salesOrderLinesTable.itemId,
    })
    .from(shipmentLinesTable)
    .innerJoin(
      salesOrderLinesTable,
      eq(salesOrderLinesTable.id, shipmentLinesTable.salesOrderLineId),
    )
    .where(
      and(
        eq(shipmentLinesTable.organizationId, organizationId),
        eq(shipmentLinesTable.shipmentId, shipmentId),
      ),
    );

  await tx
    .update(shipmentsTable)
    .set({ status: "cancelled", cancelledAt: new Date() })
    .where(
      and(
        eq(shipmentsTable.organizationId, organizationId),
        eq(shipmentsTable.id, shipmentId),
      ),
    );

  const saleMovements = await tx
    .select({
      id: stockMovementsTable.id,
      itemId: stockMovementsTable.itemId,
      warehouseId: stockMovementsTable.warehouseId,
      quantity: stockMovementsTable.quantity,
      notes: stockMovementsTable.notes,
    })
    .from(stockMovementsTable)
    .where(
      and(
        eq(stockMovementsTable.organizationId, organizationId),
        eq(stockMovementsTable.referenceType, "shipment"),
        eq(stockMovementsTable.referenceId, shipmentId),
        eq(stockMovementsTable.movementType, "sale"),
      ),
    );

  const allBatchMvts = await loadBatchMovementsForParents(
    organizationId,
    saleMovements.map((m) => m.id),
  );
  const batchByParent = new Map<number, typeof allBatchMvts>();
  for (const m of allBatchMvts) {
    const arr = batchByParent.get(m.stockMovementId) ?? [];
    arr.push(m);
    batchByParent.set(m.stockMovementId, arr);
  }

  const touchedItems = new Set<number>();
  const baseNote = `Cancelled shipment ${shipment.shipmentNumber}`;

  for (const m of saleMovements) {
    const original = toNum(m.quantity);
    const refund = -original;

    const updated = await tx
      .update(itemWarehouseStockTable)
      .set({
        quantity: sql`${itemWarehouseStockTable.quantity} + ${toStr(refund)}::numeric`,
      })
      .where(
        and(
          eq(itemWarehouseStockTable.organizationId, organizationId),
          eq(itemWarehouseStockTable.itemId, m.itemId),
          eq(itemWarehouseStockTable.warehouseId, m.warehouseId),
        ),
      )
      .returning({ id: itemWarehouseStockTable.id });
    if (updated.length === 0) {
      await tx.insert(itemWarehouseStockTable).values({
        organizationId,
        itemId: m.itemId,
        warehouseId: m.warehouseId,
        quantity: toStr(refund),
      });
    }
    const mvt = await tx
      .insert(stockMovementsTable)
      .values({
        organizationId,
        itemId: m.itemId,
        warehouseId: m.warehouseId,
        movementType: "shipment_cancelled",
        quantity: toStr(refund),
        referenceType: "shipment",
        referenceId: shipmentId,
        notes: m.notes ? `${baseNote} — ${m.notes}` : baseNote,
      })
      .returning({ id: stockMovementsTable.id });
    const cancelParentId = mvt[0]!.id;

    for (const bm of batchByParent.get(m.id) ?? []) {
      await applyBatchStockChange(
        tx,
        organizationId,
        bm.itemBatchId,
        bm.warehouseId,
        -bm.quantity,
      );
      await insertBatchMovement(
        tx,
        organizationId,
        cancelParentId,
        bm.itemBatchId,
        bm.warehouseId,
        -bm.quantity,
      );
    }
    touchedItems.add(m.itemId);
  }

  for (const sl of shipLines) {
    const qty = toNum(sl.line.quantity);
    await tx
      .update(salesOrderLinesTable)
      .set({
        quantityShipped: toStr(
          Math.max(0, toNum(sl.orderLineQuantityShipped) - qty),
        ),
      })
      .where(eq(salesOrderLinesTable.id, sl.orderLineId));
    touchedItems.add(sl.itemId);
  }

  return {
    kind: "ok",
    salesOrderId: shipment.salesOrderId,
    touchedItems: Array.from(touchedItems),
  };
}

/**
 * Cancel all active (non-cancelled) shipments for a sales order, reverse
 * their stock movements, then set the order to `targetStatus` with the
 * given `paymentStatus`. Called from Shopify `orders/cancelled` and
 * `refunds/create` webhooks.
 *
 * Idempotent: no-ops if the order is already in a terminal state
 * ("cancelled" or "refunded").
 *
 * Returns the item ids whose stock changed so the caller can push them to
 * Shopify.
 */
export async function cancelOrderShipments(
  organizationId: number,
  salesOrderId: number,
  paymentStatus: string | null,
  targetStatus: string = "cancelled",
): Promise<{ touchedItems: number[] }> {
  const allTouched = new Set<number>();

  await db.transaction(async (tx) => {
    const orderRows = await tx
      .select({ id: salesOrdersTable.id, status: salesOrdersTable.status })
      .from(salesOrdersTable)
      .where(
        and(
          eq(salesOrdersTable.id, salesOrderId),
          eq(salesOrdersTable.organizationId, organizationId),
        ),
      )
      .for("update")
      .limit(1);
    const order = orderRows[0];
    if (!order) return;
    // Already in a terminal state — only update paymentStatus if it changed.
    if (order.status === "cancelled" || order.status === "refunded") {
      await tx
        .update(salesOrdersTable)
        .set({ paymentStatus })
        .where(
          and(
            eq(salesOrdersTable.id, salesOrderId),
            eq(salesOrdersTable.organizationId, organizationId),
          ),
        );
      return;
    }

    const allShipments = await tx
      .select({ id: shipmentsTable.id, status: shipmentsTable.status })
      .from(shipmentsTable)
      .where(
        and(
          eq(shipmentsTable.organizationId, organizationId),
          eq(shipmentsTable.salesOrderId, salesOrderId),
        ),
      );
    const active = allShipments.filter((s) => s.status !== "cancelled");

    for (const s of active) {
      const result = await cancelShipmentCore(tx, organizationId, s.id);
      if (result.kind === "ok") {
        for (const itemId of result.touchedItems) {
          allTouched.add(itemId);
        }
      }
    }

    await tx
      .update(salesOrdersTable)
      .set({ status: targetStatus, paymentStatus })
      .where(
        and(
          eq(salesOrdersTable.id, salesOrderId),
          eq(salesOrdersTable.organizationId, organizationId),
        ),
      );
  });

  return { touchedItems: Array.from(allTouched) };
}
