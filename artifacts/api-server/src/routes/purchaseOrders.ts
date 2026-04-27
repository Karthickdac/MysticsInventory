import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  purchaseOrdersTable,
  purchaseOrderLinesTable,
  suppliersTable,
  warehousesTable,
  itemsTable,
  itemWarehouseStockTable,
  stockMovementsTable,
} from "@workspace/db";
import { tenantMiddleware, assertOwnership } from "../lib/tenant";
import {
  serializePurchaseOrder,
  serializeOrderLine,
} from "../lib/serializers";
import { computeOrderTotals, nextOrderNumber } from "../lib/orderHelpers";
import { toNum, toStr } from "../lib/numeric";

const router: IRouter = Router();
router.use(tenantMiddleware);

router.get("/purchase-orders", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const conds = [eq(purchaseOrdersTable.organizationId, t.organizationId)];
    if (req.query.status) conds.push(eq(purchaseOrdersTable.status, String(req.query.status)));
    if (req.query.supplierId)
      conds.push(eq(purchaseOrdersTable.supplierId, Number(req.query.supplierId)));
    const rows = await db
      .select({
        order: purchaseOrdersTable,
        supplierName: suppliersTable.name,
        warehouseName: warehousesTable.name,
      })
      .from(purchaseOrdersTable)
      .innerJoin(suppliersTable, eq(suppliersTable.id, purchaseOrdersTable.supplierId))
      .innerJoin(warehousesTable, eq(warehousesTable.id, purchaseOrdersTable.warehouseId))
      .where(and(...conds))
      .orderBy(desc(purchaseOrdersTable.createdAt));
    res.json(
      rows.map((r) =>
        serializePurchaseOrder(r.order, r.supplierName, r.warehouseName),
      ),
    );
  } catch (err) {
    next(err);
  }
});

async function loadDetail(orgId: number, orderId: number) {
  const orderRows = await db
    .select({
      order: purchaseOrdersTable,
      supplierName: suppliersTable.name,
      warehouseName: warehousesTable.name,
    })
    .from(purchaseOrdersTable)
    .innerJoin(suppliersTable, eq(suppliersTable.id, purchaseOrdersTable.supplierId))
    .innerJoin(warehousesTable, eq(warehousesTable.id, purchaseOrdersTable.warehouseId))
    .where(
      and(
        eq(purchaseOrdersTable.id, orderId),
        eq(purchaseOrdersTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!orderRows[0]) return null;
  const lineRows = await db
    .select({
      line: purchaseOrderLinesTable,
      itemName: itemsTable.name,
      sku: itemsTable.sku,
    })
    .from(purchaseOrderLinesTable)
    .innerJoin(itemsTable, eq(itemsTable.id, purchaseOrderLinesTable.itemId))
    .where(eq(purchaseOrderLinesTable.purchaseOrderId, orderId));
  return {
    order: serializePurchaseOrder(
      orderRows[0].order,
      orderRows[0].supplierName,
      orderRows[0].warehouseName,
    ),
    lines: lineRows.map((r) => serializeOrderLine(r.line, r.itemName, r.sku)),
  };
}

router.post("/purchase-orders", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const b = req.body ?? {};
    if (!b.supplierId || !b.warehouseId || !b.orderDate || !Array.isArray(b.lines) || b.lines.length === 0) {
      res.status(400).json({ error: "supplierId, warehouseId, orderDate and lines are required" });
      return;
    }
    const itemIds = b.lines
      .map((l: { itemId: number }) => Number(l.itemId))
      .filter((n: number) => Number.isFinite(n) && n > 0);
    if (itemIds.length !== b.lines.length) {
      res.status(400).json({ error: "Every line must include itemId" });
      return;
    }
    const own = await assertOwnership({
      organizationId: t.organizationId,
      supplierIds: [Number(b.supplierId)],
      warehouseIds: [Number(b.warehouseId)],
      itemIds,
    });
    if (!own.ok) {
      res.status(400).json({ error: `Invalid ${own.missing}` });
      return;
    }
    const totals = computeOrderTotals(b.lines);
    const inserted = await db
      .insert(purchaseOrdersTable)
      .values({
        organizationId: t.organizationId,
        orderNumber: nextOrderNumber("PO"),
        supplierId: b.supplierId,
        warehouseId: b.warehouseId,
        status: "draft",
        orderDate: b.orderDate,
        expectedDeliveryDate: b.expectedDeliveryDate ?? null,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        notes: b.notes ?? null,
      })
      .returning();
    const order = inserted[0]!;
    if (totals.lines.length > 0) {
      await db.insert(purchaseOrderLinesTable).values(
        totals.lines.map((l) => ({
          purchaseOrderId: order.id,
          itemId: l.itemId,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxRate: l.taxRate,
          lineSubtotal: l.lineSubtotal,
          lineTax: l.lineTax,
          lineTotal: l.lineTotal,
        })),
      );
    }
    const detail = await loadDetail(t.organizationId, order.id);
    res.status(201).json(detail);
  } catch (err) {
    next(err);
  }
});

router.get("/purchase-orders/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const detail = await loadDetail(t.organizationId, Number(req.params.id));
    if (!detail) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

router.delete("/purchase-orders/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    await db
      .delete(purchaseOrdersTable)
      .where(
        and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.organizationId, t.organizationId)),
      );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.patch("/purchase-orders/:id/status", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const newStatus = String(req.body?.status ?? "");
    if (!newStatus) {
      res.status(400).json({ error: "status is required" });
      return;
    }
    const orderRows = await db
      .select()
      .from(purchaseOrdersTable)
      .where(
        and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.organizationId, t.organizationId)),
      )
      .limit(1);
    const order = orderRows[0];
    if (!order) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const willReceive = newStatus === "received";

    if (!order.stockAppliedAt && willReceive) {
      const lines = await db
        .select()
        .from(purchaseOrderLinesTable)
        .where(eq(purchaseOrderLinesTable.purchaseOrderId, id));
      for (const line of lines) {
        const qty = toNum(line.quantity);
        const stockRows = await db
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
          await db
            .update(itemWarehouseStockTable)
            .set({ quantity: toStr(toNum(stockRows[0].quantity) + qty) })
            .where(eq(itemWarehouseStockTable.id, stockRows[0].id));
        } else {
          await db.insert(itemWarehouseStockTable).values({
            organizationId: t.organizationId,
            itemId: line.itemId,
            warehouseId: order.warehouseId,
            quantity: toStr(qty),
          });
        }
        await db.insert(stockMovementsTable).values({
          organizationId: t.organizationId,
          itemId: line.itemId,
          warehouseId: order.warehouseId,
          movementType: "purchase",
          quantity: toStr(qty),
          referenceType: "purchase_order",
          referenceId: id,
          notes: `Purchase order ${order.orderNumber}`,
        });
      }
      await db
        .update(purchaseOrdersTable)
        .set({ status: newStatus, stockAppliedAt: new Date() })
        .where(eq(purchaseOrdersTable.id, id));
    } else {
      if (order.stockAppliedAt && (newStatus === "draft" || newStatus === "ordered")) {
        res.status(400).json({
          error: "Cannot revert status after stock has been applied. Cancel the order or create a return adjustment instead.",
        });
        return;
      }
      await db
        .update(purchaseOrdersTable)
        .set({ status: newStatus })
        .where(eq(purchaseOrdersTable.id, id));
    }

    const detail = await loadDetail(t.organizationId, id);
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

export default router;
