import { Router, type IRouter } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  purchaseOrdersTable,
  purchaseOrderLinesTable,
  goodsReceiptsTable,
  goodsReceiptLinesTable,
  itemsTable,
  itemWarehouseStockTable,
  stockMovementsTable,
} from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import {
  serializeGoodsReceipt,
  serializeGoodsReceiptLine,
} from "../lib/serializers";
import { nextOrderNumber } from "../lib/orderHelpers";
import { toNum, toStr } from "../lib/numeric";
import { pushStockToShopify } from "../lib/shopifyOutbound";

const router: IRouter = Router();
router.use(tenantMiddleware);

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const RECEIVABLE_ORDER_STATUSES = ["ordered", "partially_received"] as const;
const CANCEL_RECEIPT_ORDER_STATUSES = [
  "received",
  "partially_received",
] as const;

async function deriveAndUpdatePurchaseOrderStatus(tx: Tx, orderId: number) {
  const lines = await tx
    .select({
      quantity: purchaseOrderLinesTable.quantity,
      quantityReceived: purchaseOrderLinesTable.quantityReceived,
    })
    .from(purchaseOrderLinesTable)
    .where(eq(purchaseOrderLinesTable.purchaseOrderId, orderId));
  let totalOrdered = 0;
  let totalReceived = 0;
  for (const l of lines) {
    totalOrdered += toNum(l.quantity);
    totalReceived += toNum(l.quantityReceived);
  }
  let nextStatus: "ordered" | "partially_received" | "received";
  if (totalReceived <= 0) nextStatus = "ordered";
  else if (totalReceived < totalOrdered) nextStatus = "partially_received";
  else nextStatus = "received";
  await tx
    .update(purchaseOrdersTable)
    .set({ status: nextStatus })
    .where(eq(purchaseOrdersTable.id, orderId));
  return nextStatus;
}

async function loadGoodsReceiptsForOrder(orgId: number, orderId: number) {
  const receipts = await db
    .select()
    .from(goodsReceiptsTable)
    .where(
      and(
        eq(goodsReceiptsTable.organizationId, orgId),
        eq(goodsReceiptsTable.purchaseOrderId, orderId),
      ),
    )
    .orderBy(desc(goodsReceiptsTable.createdAt));
  if (receipts.length === 0) return [];
  const ids = receipts.map((r) => r.id);
  const lineRows = await db
    .select({
      line: goodsReceiptLinesTable,
      itemName: itemsTable.name,
      sku: itemsTable.sku,
      purchaseOrderLineId: purchaseOrderLinesTable.id,
    })
    .from(goodsReceiptLinesTable)
    .innerJoin(
      purchaseOrderLinesTable,
      eq(purchaseOrderLinesTable.id, goodsReceiptLinesTable.purchaseOrderLineId),
    )
    .innerJoin(itemsTable, eq(itemsTable.id, purchaseOrderLinesTable.itemId))
    .where(inArray(goodsReceiptLinesTable.goodsReceiptId, ids));
  const linesByReceipt = new Map<number, typeof lineRows>();
  for (const r of lineRows) {
    const arr = linesByReceipt.get(r.line.goodsReceiptId) ?? [];
    arr.push(r);
    linesByReceipt.set(r.line.goodsReceiptId, arr);
  }
  return receipts.map((r) => ({
    ...serializeGoodsReceipt(r),
    lines: (linesByReceipt.get(r.id) ?? []).map((row) =>
      serializeGoodsReceiptLine(
        row.line,
        row.itemName,
        row.sku,
        row.purchaseOrderLineId,
      ),
    ),
  }));
}

router.get("/purchase-orders/:id/goods-receipts", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orderId = Number(req.params.id);
    const owner = await db
      .select({ id: purchaseOrdersTable.id })
      .from(purchaseOrdersTable)
      .where(
        and(
          eq(purchaseOrdersTable.id, orderId),
          eq(purchaseOrdersTable.organizationId, t.organizationId),
        ),
      )
      .limit(1);
    if (!owner[0]) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const receipts = await loadGoodsReceiptsForOrder(
      t.organizationId,
      orderId,
    );
    res.json(receipts);
  } catch (err) {
    next(err);
  }
});

router.post("/purchase-orders/:id/goods-receipts", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orderId = Number(req.params.id);
    const b = req.body ?? {};
    const inputLines = Array.isArray(b.lines) ? b.lines : [];
    if (inputLines.length === 0) {
      res
        .status(400)
        .json({ error: "At least one receipt line is required" });
      return;
    }
    type Input = { purchaseOrderLineId: number; quantity: number };
    const parsed: Input[] = [];
    for (const l of inputLines) {
      const lineId = Number(l?.purchaseOrderLineId);
      const qty = toNum(l?.quantity);
      if (!Number.isFinite(lineId) || lineId <= 0) {
        res
          .status(400)
          .json({ error: "Each line must include purchaseOrderLineId" });
        return;
      }
      if (!(qty > 0)) {
        res.status(400).json({
          error: "Each line quantity must be greater than zero",
        });
        return;
      }
      parsed.push({ purchaseOrderLineId: lineId, quantity: qty });
    }
    const lineIds = parsed.map((p) => p.purchaseOrderLineId);
    if (new Set(lineIds).size !== lineIds.length) {
      res.status(400).json({
        error: "Duplicate purchaseOrderLineId in receipt lines",
      });
      return;
    }

    let receivedDate: string;
    if (typeof b.receivedDate === "string" && b.receivedDate.trim()) {
      const raw = b.receivedDate.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        res.status(400).json({
          error: "receivedDate must be an ISO date in YYYY-MM-DD format",
        });
        return;
      }
      const d = new Date(`${raw}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
        res.status(400).json({ error: "receivedDate is not a valid date" });
        return;
      }
      receivedDate = raw;
    } else {
      receivedDate = new Date().toISOString().slice(0, 10);
    }
    const notes =
      typeof b.notes === "string" && b.notes.trim()
        ? String(b.notes).trim()
        : null;

    const result = await db.transaction(async (tx) => {
      const orderRows = await tx
        .select()
        .from(purchaseOrdersTable)
        .where(
          and(
            eq(purchaseOrdersTable.id, orderId),
            eq(purchaseOrdersTable.organizationId, t.organizationId),
          ),
        )
        .for("update")
        .limit(1);
      const order = orderRows[0];
      if (!order) return { kind: "notfound" as const };
      if (
        !(RECEIVABLE_ORDER_STATUSES as readonly string[]).includes(order.status)
      ) {
        return {
          kind: "bad" as const,
          message: `Only ordered or partially-received purchase orders can record receipts (current: ${order.status}).`,
        };
      }

      const lineRows = await tx
        .select()
        .from(purchaseOrderLinesTable)
        .where(eq(purchaseOrderLinesTable.purchaseOrderId, orderId));
      const linesById = new Map(lineRows.map((l) => [l.id, l]));

      for (const p of parsed) {
        const line = linesById.get(p.purchaseOrderLineId);
        if (!line) {
          return {
            kind: "bad" as const,
            message: `Line ${p.purchaseOrderLineId} does not belong to this order`,
          };
        }
        const ordered = toNum(line.quantity);
        const alreadyReceived = toNum(line.quantityReceived);
        const remaining = ordered - alreadyReceived;
        if (p.quantity - remaining > 1e-6) {
          return {
            kind: "bad" as const,
            message: `Line ${p.purchaseOrderLineId}: cannot receive ${p.quantity} (remaining ${remaining}).`,
          };
        }
      }

      const inserted = await tx
        .insert(goodsReceiptsTable)
        .values({
          organizationId: t.organizationId,
          purchaseOrderId: orderId,
          receiptNumber: nextOrderNumber("GRN"),
          receivedDate,
          status: "received",
          notes,
        })
        .returning();
      const receipt = inserted[0]!;

      await tx.insert(goodsReceiptLinesTable).values(
        parsed.map((p) => ({
          organizationId: t.organizationId,
          goodsReceiptId: receipt.id,
          purchaseOrderLineId: p.purchaseOrderLineId,
          quantity: toStr(p.quantity),
        })),
      );

      const touchedItems = new Set<number>();
      for (const p of parsed) {
        const line = linesById.get(p.purchaseOrderLineId)!;
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
          referenceType: "goods_receipt",
          referenceId: receipt.id,
          notes: `Receipt ${receipt.receiptNumber} for order ${order.orderNumber}`,
        });
        await tx
          .update(purchaseOrderLinesTable)
          .set({
            quantityReceived: toStr(toNum(line.quantityReceived) + qty),
          })
          .where(eq(purchaseOrderLinesTable.id, line.id));
        touchedItems.add(line.itemId);
      }

      await deriveAndUpdatePurchaseOrderStatus(tx, orderId);
      return {
        kind: "ok" as const,
        receiptId: receipt.id,
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
    const receipts = await loadGoodsReceiptsForOrder(
      t.organizationId,
      orderId,
    );
    const created = receipts.find((r) => r.id === result.receiptId);
    res.status(201).json(created ?? null);
  } catch (err) {
    next(err);
  }
});

router.post(
  "/goods-receipts/:goodsReceiptId/cancel",
  async (req, res, next) => {
    try {
      const t = req.tenant!;
      const receiptId = Number(req.params.goodsReceiptId);

      const result = await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(goodsReceiptsTable)
          .where(
            and(
              eq(goodsReceiptsTable.id, receiptId),
              eq(goodsReceiptsTable.organizationId, t.organizationId),
            ),
          )
          .for("update")
          .limit(1);
        const receipt = rows[0];
        if (!receipt) return { kind: "notfound" as const };
        if (receipt.status === "cancelled") {
          return {
            kind: "bad" as const,
            message: "Receipt is already cancelled",
          };
        }
        const orderRows = await tx
          .select()
          .from(purchaseOrdersTable)
          .where(eq(purchaseOrdersTable.id, receipt.purchaseOrderId))
          .for("update")
          .limit(1);
        const order = orderRows[0];
        if (!order) return { kind: "notfound" as const };
        if (
          !(CANCEL_RECEIPT_ORDER_STATUSES as readonly string[]).includes(
            order.status,
          )
        ) {
          return {
            kind: "bad" as const,
            message: `Cannot cancel a receipt when the order is ${order.status}.`,
          };
        }

        const receiptLines = await tx
          .select({
            line: goodsReceiptLinesTable,
            itemId: purchaseOrderLinesTable.itemId,
            orderLineId: purchaseOrderLinesTable.id,
            orderLineQuantityReceived:
              purchaseOrderLinesTable.quantityReceived,
          })
          .from(goodsReceiptLinesTable)
          .innerJoin(
            purchaseOrderLinesTable,
            eq(
              purchaseOrderLinesTable.id,
              goodsReceiptLinesTable.purchaseOrderLineId,
            ),
          )
          .where(eq(goodsReceiptLinesTable.goodsReceiptId, receiptId));

        await tx
          .update(goodsReceiptsTable)
          .set({ status: "cancelled" })
          .where(eq(goodsReceiptsTable.id, receiptId));

        const touchedItems = new Set<number>();
        for (const rl of receiptLines) {
          const qty = toNum(rl.line.quantity);
          const stockRows = await tx
            .select()
            .from(itemWarehouseStockTable)
            .where(
              and(
                eq(itemWarehouseStockTable.organizationId, t.organizationId),
                eq(itemWarehouseStockTable.itemId, rl.itemId),
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
              itemId: rl.itemId,
              warehouseId: order.warehouseId,
              quantity: toStr(-qty),
            });
          }
          await tx.insert(stockMovementsTable).values({
            organizationId: t.organizationId,
            itemId: rl.itemId,
            warehouseId: order.warehouseId,
            movementType: "goods_receipt_cancelled",
            quantity: toStr(-qty),
            referenceType: "goods_receipt",
            referenceId: receiptId,
            notes: `Cancelled receipt ${receipt.receiptNumber}`,
          });
          await tx
            .update(purchaseOrderLinesTable)
            .set({
              quantityReceived: toStr(
                Math.max(0, toNum(rl.orderLineQuantityReceived) - qty),
              ),
            })
            .where(eq(purchaseOrderLinesTable.id, rl.orderLineId));
          touchedItems.add(rl.itemId);
        }

        await deriveAndUpdatePurchaseOrderStatus(tx, receipt.purchaseOrderId);
        return {
          kind: "ok" as const,
          purchaseOrderId: receipt.purchaseOrderId,
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
      const receipts = await loadGoodsReceiptsForOrder(
        t.organizationId,
        result.purchaseOrderId,
      );
      const updated = receipts.find((r) => r.id === receiptId);
      res.json(updated ?? null);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
export { loadGoodsReceiptsForOrder, deriveAndUpdatePurchaseOrderStatus };
