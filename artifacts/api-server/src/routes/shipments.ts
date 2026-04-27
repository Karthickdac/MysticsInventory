import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  salesOrdersTable,
  salesOrderLinesTable,
  shipmentsTable,
  shipmentLinesTable,
  itemsTable,
  itemWarehouseStockTable,
  stockMovementsTable,
} from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import {
  serializeShipment,
  serializeShipmentLine,
} from "../lib/serializers";
import { nextOrderNumber } from "../lib/orderHelpers";
import { toNum, toStr } from "../lib/numeric";
import { pushStockToShopify } from "../lib/shopifyOutbound";

const router: IRouter = Router();
router.use(tenantMiddleware);

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const SHIPPABLE_ORDER_STATUSES = ["confirmed", "partially_shipped"] as const;
const CANCEL_SHIPMENT_ORDER_STATUSES = ["shipped", "partially_shipped"] as const;

async function deriveAndUpdateOrderStatus(tx: Tx, orderId: number) {
  const lines = await tx
    .select({
      quantity: salesOrderLinesTable.quantity,
      quantityShipped: salesOrderLinesTable.quantityShipped,
    })
    .from(salesOrderLinesTable)
    .where(eq(salesOrderLinesTable.salesOrderId, orderId));
  let totalOrdered = 0;
  let totalShipped = 0;
  for (const l of lines) {
    totalOrdered += toNum(l.quantity);
    totalShipped += toNum(l.quantityShipped);
  }
  let nextStatus: "confirmed" | "partially_shipped" | "shipped";
  if (totalShipped <= 0) nextStatus = "confirmed";
  else if (totalShipped < totalOrdered) nextStatus = "partially_shipped";
  else nextStatus = "shipped";
  await tx
    .update(salesOrdersTable)
    .set({ status: nextStatus })
    .where(eq(salesOrdersTable.id, orderId));
  return nextStatus;
}

async function loadShipmentsForOrder(orgId: number, orderId: number) {
  const shipments = await db
    .select()
    .from(shipmentsTable)
    .where(
      and(
        eq(shipmentsTable.organizationId, orgId),
        eq(shipmentsTable.salesOrderId, orderId),
      ),
    )
    .orderBy(desc(shipmentsTable.createdAt));
  if (shipments.length === 0) return [];
  const ids = shipments.map((s) => s.id);
  const lineRows = await db
    .select({
      line: shipmentLinesTable,
      itemName: itemsTable.name,
      sku: itemsTable.sku,
      salesOrderLineId: salesOrderLinesTable.id,
    })
    .from(shipmentLinesTable)
    .innerJoin(
      salesOrderLinesTable,
      eq(salesOrderLinesTable.id, shipmentLinesTable.salesOrderLineId),
    )
    .innerJoin(itemsTable, eq(itemsTable.id, salesOrderLinesTable.itemId))
    .where(inArray(shipmentLinesTable.shipmentId, ids));
  const linesByShipment = new Map<number, typeof lineRows>();
  for (const r of lineRows) {
    const arr = linesByShipment.get(r.line.shipmentId) ?? [];
    arr.push(r);
    linesByShipment.set(r.line.shipmentId, arr);
  }
  return shipments.map((s) => ({
    ...serializeShipment(s),
    lines: (linesByShipment.get(s.id) ?? []).map((r) =>
      serializeShipmentLine(r.line, r.itemName, r.sku, r.salesOrderLineId),
    ),
  }));
}

router.get("/sales-orders/:id/shipments", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orderId = Number(req.params.id);
    const owner = await db
      .select({ id: salesOrdersTable.id })
      .from(salesOrdersTable)
      .where(
        and(
          eq(salesOrdersTable.id, orderId),
          eq(salesOrdersTable.organizationId, t.organizationId),
        ),
      )
      .limit(1);
    if (!owner[0]) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const shipments = await loadShipmentsForOrder(t.organizationId, orderId);
    res.json(shipments);
  } catch (err) {
    next(err);
  }
});

router.post("/sales-orders/:id/shipments", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orderId = Number(req.params.id);
    const b = req.body ?? {};
    const inputLines = Array.isArray(b.lines) ? b.lines : [];
    if (inputLines.length === 0) {
      res.status(400).json({ error: "At least one shipment line is required" });
      return;
    }
    type Input = { salesOrderLineId: number; quantity: number };
    const parsed: Input[] = [];
    for (const l of inputLines) {
      const lineId = Number(l?.salesOrderLineId);
      const qty = toNum(l?.quantity);
      if (!Number.isFinite(lineId) || lineId <= 0) {
        res.status(400).json({ error: "Each line must include salesOrderLineId" });
        return;
      }
      if (!(qty > 0)) {
        res.status(400).json({ error: "Each line quantity must be greater than zero" });
        return;
      }
      parsed.push({ salesOrderLineId: lineId, quantity: qty });
    }
    const lineIds = parsed.map((p) => p.salesOrderLineId);
    if (new Set(lineIds).size !== lineIds.length) {
      res.status(400).json({ error: "Duplicate salesOrderLineId in shipment lines" });
      return;
    }

    const shipDate =
      typeof b.shipDate === "string" && b.shipDate.trim()
        ? String(b.shipDate)
        : new Date().toISOString().slice(0, 10);
    const notes =
      typeof b.notes === "string" && b.notes.trim() ? String(b.notes).trim() : null;

    const result = await db.transaction(async (tx) => {
      const orderRows = await tx
        .select()
        .from(salesOrdersTable)
        .where(
          and(
            eq(salesOrdersTable.id, orderId),
            eq(salesOrdersTable.organizationId, t.organizationId),
          ),
        )
        .for("update")
        .limit(1);
      const order = orderRows[0];
      if (!order) return { kind: "notfound" as const };
      if (
        !(SHIPPABLE_ORDER_STATUSES as readonly string[]).includes(order.status)
      ) {
        return {
          kind: "bad" as const,
          message: `Only confirmed or partially-shipped orders can record shipments (current: ${order.status}).`,
        };
      }

      const lineRows = await tx
        .select()
        .from(salesOrderLinesTable)
        .where(eq(salesOrderLinesTable.salesOrderId, orderId));
      const linesById = new Map(lineRows.map((l) => [l.id, l]));

      for (const p of parsed) {
        const line = linesById.get(p.salesOrderLineId);
        if (!line) {
          return {
            kind: "bad" as const,
            message: `Line ${p.salesOrderLineId} does not belong to this order`,
          };
        }
        const ordered = toNum(line.quantity);
        const alreadyShipped = toNum(line.quantityShipped);
        const remaining = ordered - alreadyShipped;
        if (p.quantity - remaining > 1e-6) {
          return {
            kind: "bad" as const,
            message: `Line ${p.salesOrderLineId}: cannot ship ${p.quantity} (remaining ${remaining}).`,
          };
        }
      }

      const inserted = await tx
        .insert(shipmentsTable)
        .values({
          organizationId: t.organizationId,
          salesOrderId: orderId,
          shipmentNumber: nextOrderNumber("SHIP"),
          shipDate,
          status: "shipped",
          notes,
        })
        .returning();
      const shipment = inserted[0]!;

      await tx.insert(shipmentLinesTable).values(
        parsed.map((p) => ({
          organizationId: t.organizationId,
          shipmentId: shipment.id,
          salesOrderLineId: p.salesOrderLineId,
          quantity: toStr(p.quantity),
        })),
      );

      const touchedItems = new Set<number>();
      for (const p of parsed) {
        const line = linesById.get(p.salesOrderLineId)!;
        const qty = p.quantity;
        const stockRows = await tx
          .select()
          .from(itemWarehouseStockTable)
          .where(
            and(
              eq(itemWarehouseStockTable.organizationId, t.organizationId),
              eq(itemWarehouseStockTable.itemId, line.itemId),
              eq(itemWarehouseStockTable.warehouseId, order.warehouseId),
            ),
          )
          .limit(1);
        if (stockRows[0]) {
          await tx
            .update(itemWarehouseStockTable)
            .set({ quantity: toStr(toNum(stockRows[0].quantity) - qty) })
            .where(eq(itemWarehouseStockTable.id, stockRows[0].id));
        } else {
          await tx.insert(itemWarehouseStockTable).values({
            organizationId: t.organizationId,
            itemId: line.itemId,
            warehouseId: order.warehouseId,
            quantity: toStr(-qty),
          });
        }
        await tx.insert(stockMovementsTable).values({
          organizationId: t.organizationId,
          itemId: line.itemId,
          warehouseId: order.warehouseId,
          movementType: "sale",
          quantity: toStr(-qty),
          referenceType: "shipment",
          referenceId: shipment.id,
          notes: `Shipment ${shipment.shipmentNumber} for order ${order.orderNumber}`,
        });
        await tx
          .update(salesOrderLinesTable)
          .set({
            quantityShipped: toStr(toNum(line.quantityShipped) + qty),
          })
          .where(eq(salesOrderLinesTable.id, line.id));
        touchedItems.add(line.itemId);
      }

      await deriveAndUpdateOrderStatus(tx, orderId);
      return {
        kind: "ok" as const,
        shipmentId: shipment.id,
        itemIds: Array.from(touchedItems),
      };
    });

    if (result.kind === "notfound") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (result.kind === "bad") {
      res.status(400).json({ error: result.message });
      return;
    }
    for (const itemId of result.itemIds) {
      pushStockToShopify(t.organizationId, itemId);
    }
    const shipments = await loadShipmentsForOrder(t.organizationId, orderId);
    const created = shipments.find((s) => s.id === result.shipmentId);
    res.status(201).json(created ?? null);
  } catch (err) {
    next(err);
  }
});

router.post("/shipments/:shipmentId/cancel", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const shipmentId = Number(req.params.shipmentId);

    const result = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(shipmentsTable)
        .where(
          and(
            eq(shipmentsTable.id, shipmentId),
            eq(shipmentsTable.organizationId, t.organizationId),
          ),
        )
        .for("update")
        .limit(1);
      const shipment = rows[0];
      if (!shipment) return { kind: "notfound" as const };
      if (shipment.status === "cancelled") {
        return {
          kind: "bad" as const,
          message: "Shipment is already cancelled",
        };
      }
      const orderRows = await tx
        .select()
        .from(salesOrdersTable)
        .where(eq(salesOrdersTable.id, shipment.salesOrderId))
        .for("update")
        .limit(1);
      const order = orderRows[0];
      if (!order) return { kind: "notfound" as const };
      if (
        !(CANCEL_SHIPMENT_ORDER_STATUSES as readonly string[]).includes(
          order.status,
        )
      ) {
        return {
          kind: "bad" as const,
          message: `Cannot cancel a shipment when the order is ${order.status}.`,
        };
      }

      const shipLines = await tx
        .select({
          line: shipmentLinesTable,
          itemId: salesOrderLinesTable.itemId,
          orderLineId: salesOrderLinesTable.id,
          orderLineQuantityShipped: salesOrderLinesTable.quantityShipped,
        })
        .from(shipmentLinesTable)
        .innerJoin(
          salesOrderLinesTable,
          eq(salesOrderLinesTable.id, shipmentLinesTable.salesOrderLineId),
        )
        .where(eq(shipmentLinesTable.shipmentId, shipmentId));

      await tx
        .update(shipmentsTable)
        .set({ status: "cancelled" })
        .where(eq(shipmentsTable.id, shipmentId));

      const touchedItems = new Set<number>();
      for (const sl of shipLines) {
        const qty = toNum(sl.line.quantity);
        const stockRows = await tx
          .select()
          .from(itemWarehouseStockTable)
          .where(
            and(
              eq(itemWarehouseStockTable.organizationId, t.organizationId),
              eq(itemWarehouseStockTable.itemId, sl.itemId),
              eq(itemWarehouseStockTable.warehouseId, order.warehouseId),
            ),
          )
          .limit(1);
        if (stockRows[0]) {
          await tx
            .update(itemWarehouseStockTable)
            .set({ quantity: toStr(toNum(stockRows[0].quantity) + qty) })
            .where(eq(itemWarehouseStockTable.id, stockRows[0].id));
        } else {
          await tx.insert(itemWarehouseStockTable).values({
            organizationId: t.organizationId,
            itemId: sl.itemId,
            warehouseId: order.warehouseId,
            quantity: toStr(qty),
          });
        }
        await tx.insert(stockMovementsTable).values({
          organizationId: t.organizationId,
          itemId: sl.itemId,
          warehouseId: order.warehouseId,
          movementType: "shipment_cancelled",
          quantity: toStr(qty),
          referenceType: "shipment",
          referenceId: shipmentId,
          notes: `Cancelled shipment ${shipment.shipmentNumber}`,
        });
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

      await deriveAndUpdateOrderStatus(tx, shipment.salesOrderId);
      return {
        kind: "ok" as const,
        salesOrderId: shipment.salesOrderId,
        itemIds: Array.from(touchedItems),
      };
    });

    if (result.kind === "notfound") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (result.kind === "bad") {
      res.status(400).json({ error: result.message });
      return;
    }
    for (const itemId of result.itemIds) {
      pushStockToShopify(t.organizationId, itemId);
    }
    const shipments = await loadShipmentsForOrder(
      t.organizationId,
      result.salesOrderId,
    );
    const updated = shipments.find((s) => s.id === shipmentId);
    res.json(updated ?? null);
  } catch (err) {
    next(err);
  }
});

export default router;
export { loadShipmentsForOrder, deriveAndUpdateOrderStatus };
