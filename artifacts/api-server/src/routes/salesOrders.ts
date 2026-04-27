import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  salesOrdersTable,
  salesOrderLinesTable,
  customersTable,
  warehousesTable,
  itemsTable,
  itemWarehouseStockTable,
  stockMovementsTable,
} from "@workspace/db";
import { tenantMiddleware, assertOwnership } from "../lib/tenant";
import {
  serializeSalesOrder,
  serializeOrderLine,
} from "../lib/serializers";
import { computeOrderTotals, nextOrderNumber } from "../lib/orderHelpers";
import { toNum, toStr } from "../lib/numeric";

const SALES_STATUSES = [
  "draft",
  "confirmed",
  "shipped",
  "delivered",
  "invoiced",
  "paid",
  "cancelled",
] as const;
type SalesStatus = (typeof SALES_STATUSES)[number];
function isSalesStatus(s: string): s is SalesStatus {
  return (SALES_STATUSES as readonly string[]).includes(s);
}

const router: IRouter = Router();
router.use(tenantMiddleware);

router.get("/sales-orders", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const conds = [eq(salesOrdersTable.organizationId, t.organizationId)];
    if (req.query.status) conds.push(eq(salesOrdersTable.status, String(req.query.status)));
    if (req.query.customerId)
      conds.push(eq(salesOrdersTable.customerId, Number(req.query.customerId)));
    const rows = await db
      .select({
        order: salesOrdersTable,
        customerName: customersTable.name,
        warehouseName: warehousesTable.name,
      })
      .from(salesOrdersTable)
      .innerJoin(customersTable, eq(customersTable.id, salesOrdersTable.customerId))
      .innerJoin(
        warehousesTable,
        eq(warehousesTable.id, salesOrdersTable.warehouseId),
      )
      .where(and(...conds))
      .orderBy(desc(salesOrdersTable.createdAt));
    res.json(
      rows.map((r) =>
        serializeSalesOrder(r.order, r.customerName, r.warehouseName),
      ),
    );
  } catch (err) {
    next(err);
  }
});

async function loadDetail(orgId: number, orderId: number) {
  const orderRows = await db
    .select({
      order: salesOrdersTable,
      customerName: customersTable.name,
      warehouseName: warehousesTable.name,
    })
    .from(salesOrdersTable)
    .innerJoin(customersTable, eq(customersTable.id, salesOrdersTable.customerId))
    .innerJoin(warehousesTable, eq(warehousesTable.id, salesOrdersTable.warehouseId))
    .where(
      and(eq(salesOrdersTable.id, orderId), eq(salesOrdersTable.organizationId, orgId)),
    )
    .limit(1);
  if (!orderRows[0]) return null;
  const lineRows = await db
    .select({
      line: salesOrderLinesTable,
      itemName: itemsTable.name,
      sku: itemsTable.sku,
    })
    .from(salesOrderLinesTable)
    .innerJoin(itemsTable, eq(itemsTable.id, salesOrderLinesTable.itemId))
    .where(eq(salesOrderLinesTable.salesOrderId, orderId));
  return {
    order: serializeSalesOrder(
      orderRows[0].order,
      orderRows[0].customerName,
      orderRows[0].warehouseName,
    ),
    lines: lineRows.map((r) => serializeOrderLine(r.line, r.itemName, r.sku)),
  };
}

router.post("/sales-orders", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const b = req.body ?? {};
    if (!b.customerId || !b.warehouseId || !b.orderDate || !Array.isArray(b.lines) || b.lines.length === 0) {
      res.status(400).json({ error: "customerId, warehouseId, orderDate and lines are required" });
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
      customerIds: [Number(b.customerId)],
      warehouseIds: [Number(b.warehouseId)],
      itemIds,
    });
    if (!own.ok) {
      res.status(400).json({ error: `Invalid ${own.missing}` });
      return;
    }
    const totals = computeOrderTotals(b.lines);
    const inserted = await db
      .insert(salesOrdersTable)
      .values({
        organizationId: t.organizationId,
        orderNumber: nextOrderNumber("SO"),
        customerId: b.customerId,
        warehouseId: b.warehouseId,
        status: "draft",
        orderDate: b.orderDate,
        expectedShipDate: b.expectedShipDate ?? null,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        notes: b.notes ?? null,
      })
      .returning();
    const order = inserted[0]!;
    if (totals.lines.length > 0) {
      await db.insert(salesOrderLinesTable).values(
        totals.lines.map((l) => ({
          salesOrderId: order.id,
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

router.get("/sales-orders/:id", async (req, res, next) => {
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

router.patch("/sales-orders/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const orderRows = await db
      .select()
      .from(salesOrdersTable)
      .where(
        and(
          eq(salesOrdersTable.id, id),
          eq(salesOrdersTable.organizationId, t.organizationId),
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
        error: "Only draft orders can be edited. Cancel and recreate to change a confirmed order.",
      });
      return;
    }
    const b = req.body ?? {};
    const customerId = b.customerId ? Number(b.customerId) : existing.customerId;
    const warehouseId = b.warehouseId ? Number(b.warehouseId) : existing.warehouseId;
    const itemIds = Array.isArray(b.lines)
      ? b.lines.map((l: { itemId: number }) => Number(l.itemId))
      : [];
    const own = await assertOwnership({
      organizationId: t.organizationId,
      customerIds: b.customerId ? [customerId] : undefined,
      warehouseIds: b.warehouseId ? [warehouseId] : undefined,
      itemIds: itemIds.length ? itemIds : undefined,
    });
    if (!own.ok) {
      res.status(400).json({ error: `Invalid ${own.missing}` });
      return;
    }

    const update: Partial<typeof salesOrdersTable.$inferInsert> = {
      customerId,
      warehouseId,
      orderDate: b.orderDate ? String(b.orderDate) : existing.orderDate,
      expectedShipDate:
        b.expectedShipDate === undefined
          ? existing.expectedShipDate
          : b.expectedShipDate
            ? String(b.expectedShipDate)
            : null,
      notes: b.notes === undefined ? existing.notes : b.notes,
    };

    if (Array.isArray(b.lines)) {
      const totals = computeOrderTotals(b.lines);
      update.subtotal = totals.subtotal;
      update.taxTotal = totals.taxTotal;
      update.total = totals.total;
      await db
        .delete(salesOrderLinesTable)
        .where(eq(salesOrderLinesTable.salesOrderId, id));
      if (totals.lines.length > 0) {
        await db.insert(salesOrderLinesTable).values(
          totals.lines.map((l) => ({
            salesOrderId: id,
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
      .update(salesOrdersTable)
      .set(update)
      .where(eq(salesOrdersTable.id, id));
    const detail = await loadDetail(t.organizationId, id);
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

router.delete("/sales-orders/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    await db
      .delete(salesOrdersTable)
      .where(
        and(eq(salesOrdersTable.id, id), eq(salesOrdersTable.organizationId, t.organizationId)),
      );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.patch("/sales-orders/:id/status", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const newStatus = String(req.body?.status ?? "");
    if (!newStatus) {
      res.status(400).json({ error: "status is required" });
      return;
    }
    if (!isSalesStatus(newStatus)) {
      res.status(400).json({
        error: `Invalid status. Allowed: ${SALES_STATUSES.join(", ")}`,
      });
      return;
    }
    const orderRows = await db
      .select()
      .from(salesOrdersTable)
      .where(
        and(eq(salesOrdersTable.id, id), eq(salesOrdersTable.organizationId, t.organizationId)),
      )
      .limit(1);
    const order = orderRows[0];
    if (!order) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const willShip = newStatus === "shipped" || newStatus === "delivered";

    if (!order.stockAppliedAt && willShip) {
      const result = await db.transaction(async (tx) => {
        const claimed = await tx
          .update(salesOrdersTable)
          .set({ status: newStatus, stockAppliedAt: new Date() })
          .where(
            and(
              eq(salesOrdersTable.id, id),
              eq(salesOrdersTable.organizationId, t.organizationId),
              sql`${salesOrdersTable.stockAppliedAt} IS NULL`,
            ),
          )
          .returning({ id: salesOrdersTable.id });
        if (claimed.length === 0) {
          return { conflict: true as const };
        }
        const lines = await tx
          .select()
          .from(salesOrderLinesTable)
          .where(eq(salesOrderLinesTable.salesOrderId, id));
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
            movementType: "sale",
            quantity: toStr(-qty),
            referenceType: "sales_order",
            referenceId: id,
            notes: `Sales order ${order.orderNumber}`,
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
      if (order.stockAppliedAt && (newStatus === "draft" || newStatus === "confirmed")) {
        res.status(400).json({
          error: "Cannot revert status after stock has been applied. Cancel the order or create a return adjustment instead.",
        });
        return;
      }
      await db
        .update(salesOrdersTable)
        .set({ status: newStatus })
        .where(eq(salesOrdersTable.id, id));
    }

    const detail = await loadDetail(t.organizationId, id);
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

export default router;
