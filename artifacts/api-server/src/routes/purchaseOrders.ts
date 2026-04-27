import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
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

const PURCHASE_STATUSES = [
  "draft",
  "ordered",
  "partially_received",
  "received",
  "billed",
  "paid",
  "cancelled",
  "returned",
] as const;
type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];
function isPurchaseStatus(s: string): s is PurchaseStatus {
  return (PURCHASE_STATUSES as readonly string[]).includes(s);
}

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

router.patch("/purchase-orders/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const orderRows = await db
      .select()
      .from(purchaseOrdersTable)
      .where(
        and(
          eq(purchaseOrdersTable.id, id),
          eq(purchaseOrdersTable.organizationId, t.organizationId),
        ),
      )
      .limit(1);
    const existing = orderRows[0];
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (existing.status !== "draft") {
      res.status(400).json({
        error: "Only draft purchase orders can be edited.",
      });
      return;
    }
    const b = req.body ?? {};
    const supplierId = b.supplierId ? Number(b.supplierId) : existing.supplierId;
    const warehouseId = b.warehouseId ? Number(b.warehouseId) : existing.warehouseId;
    const itemIds = Array.isArray(b.lines)
      ? b.lines.map((l: { itemId: number }) => Number(l.itemId))
      : [];
    const own = await assertOwnership({
      organizationId: t.organizationId,
      supplierIds: b.supplierId ? [supplierId] : undefined,
      warehouseIds: b.warehouseId ? [warehouseId] : undefined,
      itemIds: itemIds.length ? itemIds : undefined,
    });
    if (!own.ok) {
      res.status(400).json({ error: `Invalid ${own.missing}` });
      return;
    }

    const update: Partial<typeof purchaseOrdersTable.$inferInsert> = {
      supplierId,
      warehouseId,
      orderDate: b.orderDate ? String(b.orderDate) : existing.orderDate,
      expectedDeliveryDate:
        b.expectedDeliveryDate === undefined
          ? existing.expectedDeliveryDate
          : b.expectedDeliveryDate
            ? String(b.expectedDeliveryDate)
            : null,
      notes: b.notes === undefined ? existing.notes : b.notes,
    };

    if (Array.isArray(b.lines)) {
      const totals = computeOrderTotals(b.lines);
      update.subtotal = totals.subtotal;
      update.taxTotal = totals.taxTotal;
      update.total = totals.total;
      await db
        .delete(purchaseOrderLinesTable)
        .where(eq(purchaseOrderLinesTable.purchaseOrderId, id));
      if (totals.lines.length > 0) {
        await db.insert(purchaseOrderLinesTable).values(
          totals.lines.map((l) => ({
            purchaseOrderId: id,
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
    }

    await db
      .update(purchaseOrdersTable)
      .set(update)
      .where(eq(purchaseOrdersTable.id, id));
    const detail = await loadDetail(t.organizationId, id);
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
    if (newStatus === "returned") {
      res.status(400).json({
        error: "Use POST /purchase-orders/:id/return to mark an order as returned.",
      });
      return;
    }
    if (!isPurchaseStatus(newStatus)) {
      res.status(400).json({
        error: `Invalid status. Allowed: ${PURCHASE_STATUSES.join(", ")}`,
      });
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
    if (order.status === "returned") {
      res.status(400).json({
        error: "Returned orders are final and cannot change status.",
      });
      return;
    }
    const willReceive = newStatus === "received";

    if (!order.stockAppliedAt && willReceive) {
      const result = await db.transaction(async (tx) => {
        const claimed = await tx
          .update(purchaseOrdersTable)
          .set({ status: newStatus, stockAppliedAt: new Date() })
          .where(
            and(
              eq(purchaseOrdersTable.id, id),
              eq(purchaseOrdersTable.organizationId, t.organizationId),
              sql`${purchaseOrdersTable.stockAppliedAt} IS NULL`,
            ),
          )
          .returning({ id: purchaseOrdersTable.id });
        if (claimed.length === 0) {
          return { conflict: true as const };
        }
        const lines = await tx
          .select()
          .from(purchaseOrderLinesTable)
          .where(eq(purchaseOrderLinesTable.purchaseOrderId, id));
        for (const line of lines) {
          const qty = toNum(line.quantity);
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
              .set({ quantity: toStr(toNum(stockRows[0].quantity) + qty) })
              .where(eq(itemWarehouseStockTable.id, stockRows[0].id));
          } else {
            await tx.insert(itemWarehouseStockTable).values({
              organizationId: t.organizationId,
              itemId: line.itemId,
              warehouseId: order.warehouseId,
              quantity: toStr(qty),
            });
          }
          await tx.insert(stockMovementsTable).values({
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
        return { conflict: false as const };
      });
      if (result.conflict) {
        res.status(409).json({
          error: "Stock has already been applied for this order by another request.",
        });
        return;
      }
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

const RETURNABLE_PURCHASE_STATUSES = [
  "received",
  "billed",
  "paid",
];

router.post("/purchase-orders/:id/return", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const notes =
      typeof req.body?.notes === "string" && req.body.notes.trim()
        ? String(req.body.notes).trim()
        : null;

    const orderRows = await db
      .select()
      .from(purchaseOrdersTable)
      .where(
        and(
          eq(purchaseOrdersTable.id, id),
          eq(purchaseOrdersTable.organizationId, t.organizationId),
        ),
      )
      .limit(1);
    const order = orderRows[0];
    if (!order) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!RETURNABLE_PURCHASE_STATUSES.includes(order.status)) {
      res.status(400).json({
        error: `Only ${RETURNABLE_PURCHASE_STATUSES.join(", ")} purchase orders can be returned`,
      });
      return;
    }
    if (!order.stockAppliedAt) {
      res.status(400).json({
        error: "Order has no applied stock to return",
      });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const claimed = await tx
        .update(purchaseOrdersTable)
        .set({ status: "returned" })
        .where(
          and(
            eq(purchaseOrdersTable.id, id),
            eq(purchaseOrdersTable.organizationId, t.organizationId),
            sql`${purchaseOrdersTable.status} IN ('received','billed','paid')`,
            sql`${purchaseOrdersTable.stockAppliedAt} IS NOT NULL`,
          ),
        )
        .returning({ id: purchaseOrdersTable.id });
      if (claimed.length === 0) {
        return { conflict: true as const };
      }

      const lines = await tx
        .select()
        .from(purchaseOrderLinesTable)
        .where(eq(purchaseOrderLinesTable.purchaseOrderId, id));

      for (const line of lines) {
        const qty = toNum(line.quantity);
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
          movementType: "purchase_return",
          quantity: toStr(-qty),
          referenceType: "purchase_order",
          referenceId: id,
          notes:
            notes ??
            `Purchase return for order ${order.orderNumber}`,
        });
      }
      return { conflict: false as const };
    });

    if (result.conflict) {
      res.status(409).json({
        error: "Order has already been returned by another request.",
      });
      return;
    }

    const detail = await loadDetail(t.organizationId, id);
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

export default router;
