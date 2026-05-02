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
import { tenantMiddleware, findBundleItems } from "../lib/tenant";
import {
  serializeGoodsReceipt,
  serializeGoodsReceiptLine,
} from "../lib/serializers";
import { nextOrderNumber } from "../lib/orderHelpers";
import { toNum, toStr } from "../lib/numeric";
import { pushStockToShopify } from "../lib/shopifyOutbound";
import {
  applyBatchStockChange,
  insertBatchMovement,
  loadBatchMovementsForParents,
  parseBatchInArray,
  upsertBatchInTx,
  type ParsedBatchIn,
} from "../lib/batches";

const router: IRouter = Router();
router.use(tenantMiddleware);

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const RECEIVABLE_ORDER_STATUSES = ["ordered", "partially_received"] as const;
const CANCEL_RECEIPT_ORDER_STATUSES = [
  "received",
  "partially_received",
] as const;

async function deriveAndUpdatePurchaseOrderStatus(
  tx: Tx,
  orgId: number,
  orderId: number,
) {
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
    .where(
      and(
        eq(purchaseOrdersTable.id, orderId),
        eq(purchaseOrdersTable.organizationId, orgId),
      ),
    );
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
    .where(
      and(
        eq(goodsReceiptLinesTable.organizationId, orgId),
        inArray(goodsReceiptLinesTable.goodsReceiptId, ids),
      ),
    );
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
    type Input = {
      purchaseOrderLineId: number;
      quantity: number;
      // Raw batches array as supplied by the client; null when omitted.
      // Validated against the batch-tracked flag inside the transaction.
      batchesRaw: unknown;
    };
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
      parsed.push({
        purchaseOrderLineId: lineId,
        quantity: qty,
        batchesRaw: l && typeof l === "object" ? (l as { batches?: unknown }).batches : undefined,
      });
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

      // Pre-load referenced items so we can detect bundles (rejected) and
      // batch-tracked items (require batch capture) in one round-trip.
      const recvItemIds = Array.from(
        new Set(
          parsed.map((p) => linesById.get(p.purchaseOrderLineId)!.itemId),
        ),
      );
      const itemRows = recvItemIds.length
        ? await tx
            .select({
              id: itemsTable.id,
              isBundle: itemsTable.isBundle,
              trackBatches: itemsTable.trackBatches,
              sku: itemsTable.sku,
              name: itemsTable.name,
            })
            .from(itemsTable)
            .where(
              and(
                eq(itemsTable.organizationId, t.organizationId),
                inArray(itemsTable.id, recvItemIds),
              ),
            )
        : [];
      const itemById = new Map(itemRows.map((r) => [r.id, r]));

      const bundleItems = await findBundleItems(t.organizationId, recvItemIds);
      if (bundleItems.length > 0) {
        return {
          kind: "bad" as const,
          message:
            "Cannot receive lines whose item is now a bundle. Bundles do not hold physical stock.",
        };
      }

      // Validate batch capture for tracked items, and reject batches
      // payload for non-tracked items so UI bugs surface loudly.
      const lineBatches = new Map<number, ParsedBatchIn[]>();
      for (const p of parsed) {
        const line = linesById.get(p.purchaseOrderLineId)!;
        const itemMeta = itemById.get(line.itemId);
        const tracked = !!itemMeta?.trackBatches;
        if (tracked) {
          const parsedBatches = parseBatchInArray(p.batchesRaw, p.quantity);
          if (!parsedBatches.ok) {
            const label = itemMeta
              ? `${itemMeta.name} (${itemMeta.sku})`
              : `item ${line.itemId}`;
            return {
              kind: "bad" as const,
              message: `${label}: ${parsedBatches.error}`,
            };
          }
          lineBatches.set(p.purchaseOrderLineId, parsedBatches.rows);
        } else if (p.batchesRaw !== undefined) {
          // Non-tracked item received a batches payload — reject.
          if (Array.isArray(p.batchesRaw) && p.batchesRaw.length > 0) {
            const label = itemMeta
              ? `${itemMeta.name} (${itemMeta.sku})`
              : `item ${line.itemId}`;
            return {
              kind: "bad" as const,
              message: `${label} is not batch-tracked; remove the batches array from this line`,
            };
          }
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
            .where(
              and(
                eq(itemWarehouseStockTable.organizationId, t.organizationId),
                eq(itemWarehouseStockTable.id, stockRows[0].id),
              ),
            );
        } else {
          await tx.insert(itemWarehouseStockTable).values({
            organizationId: t.organizationId,
            itemId: line.itemId,
            warehouseId: order.warehouseId,
            quantity: toStr(qty),
          });
        }
        const movementInserted = await tx
          .insert(stockMovementsTable)
          .values({
            organizationId: t.organizationId,
            itemId: line.itemId,
            warehouseId: order.warehouseId,
            movementType: "purchase",
            quantity: toStr(qty),
            referenceType: "goods_receipt",
            referenceId: receipt.id,
            notes: `Receipt ${receipt.receiptNumber} for order ${order.orderNumber}`,
          })
          .returning({ id: stockMovementsTable.id });
        const parentMovementId = movementInserted[0]!.id;

        // Batch fan-out: upsert each batch and write a per-batch ledger
        // row tied to the parent stock movement. Sum equals the parent
        // quantity by construction (validated above).
        const batchRows = lineBatches.get(p.purchaseOrderLineId);
        if (batchRows) {
          for (const br of batchRows) {
            const upserted = await upsertBatchInTx(
              tx,
              t.organizationId,
              line.itemId,
              br,
            );
            if (!upserted.ok) {
              return { kind: "bad" as const, message: upserted.error };
            }
            await applyBatchStockChange(
              tx,
              t.organizationId,
              upserted.itemBatchId,
              order.warehouseId,
              br.quantity,
            );
            await insertBatchMovement(
              tx,
              t.organizationId,
              parentMovementId,
              upserted.itemBatchId,
              order.warehouseId,
              br.quantity,
            );
          }
        }

        await tx
          .update(purchaseOrderLinesTable)
          .set({
            quantityReceived: toStr(toNum(line.quantityReceived) + qty),
          })
          .where(eq(purchaseOrderLinesTable.id, line.id));
        touchedItems.add(line.itemId);
      }

      await deriveAndUpdatePurchaseOrderStatus(tx, t.organizationId, orderId);
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
          .where(
            and(
              eq(purchaseOrdersTable.id, receipt.purchaseOrderId),
              eq(purchaseOrdersTable.organizationId, t.organizationId),
            ),
          )
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
          .where(
            and(
              eq(goodsReceiptLinesTable.organizationId, t.organizationId),
              eq(goodsReceiptLinesTable.goodsReceiptId, receiptId),
            ),
          );

        await tx
          .update(goodsReceiptsTable)
          .set({ status: "cancelled" })
          .where(
            and(
              eq(goodsReceiptsTable.organizationId, t.organizationId),
              eq(goodsReceiptsTable.id, receiptId),
            ),
          );

        // Look up all original purchase parent movements for this
        // receipt and their per-batch ledger rows up front so we can
        // pair each cancellation parent to its original batch fan-out.
        const originalParents = await tx
          .select({
            id: stockMovementsTable.id,
            itemId: stockMovementsTable.itemId,
            warehouseId: stockMovementsTable.warehouseId,
            quantity: stockMovementsTable.quantity,
          })
          .from(stockMovementsTable)
          .where(
            and(
              eq(stockMovementsTable.organizationId, t.organizationId),
              eq(stockMovementsTable.referenceType, "goods_receipt"),
              eq(stockMovementsTable.referenceId, receiptId),
              eq(stockMovementsTable.movementType, "purchase"),
            ),
          )
          .orderBy(stockMovementsTable.id);
        const allBatchMvts = await loadBatchMovementsForParents(
          t.organizationId,
          originalParents.map((p) => p.id),
        );
        const batchByParent = new Map<number, typeof allBatchMvts>();
        for (const m of allBatchMvts) {
          const arr = batchByParent.get(m.stockMovementId) ?? [];
          arr.push(m);
          batchByParent.set(m.stockMovementId, arr);
        }

        const touchedItems = new Set<number>();
        // Reverse stock from each original parent. Each cancellation
        // parent mirrors its original 1:1, with the batch ledger
        // reversed onto the new cancellation parent.
        for (const parent of originalParents) {
          const qty = toNum(parent.quantity); // positive
          const stockRows = await tx
            .select()
            .from(itemWarehouseStockTable)
            .where(
              and(
                eq(itemWarehouseStockTable.organizationId, t.organizationId),
                eq(itemWarehouseStockTable.itemId, parent.itemId),
                eq(itemWarehouseStockTable.warehouseId, parent.warehouseId),
              ),
            )
            .limit(1);
          if (stockRows[0]) {
            await tx
              .update(itemWarehouseStockTable)
              .set({
                quantity: toStr(toNum(stockRows[0].quantity) - qty),
              })
              .where(
                and(
                  eq(itemWarehouseStockTable.organizationId, t.organizationId),
                  eq(itemWarehouseStockTable.id, stockRows[0].id),
                ),
              );
          } else {
            await tx.insert(itemWarehouseStockTable).values({
              organizationId: t.organizationId,
              itemId: parent.itemId,
              warehouseId: parent.warehouseId,
              quantity: toStr(-qty),
            });
          }
          const cancelInserted = await tx
            .insert(stockMovementsTable)
            .values({
              organizationId: t.organizationId,
              itemId: parent.itemId,
              warehouseId: parent.warehouseId,
              movementType: "goods_receipt_cancelled",
              quantity: toStr(-qty),
              referenceType: "goods_receipt",
              referenceId: receiptId,
              notes: `Cancelled receipt ${receipt.receiptNumber}`,
            })
            .returning({ id: stockMovementsTable.id });
          const cancelParentId = cancelInserted[0]!.id;
          for (const bm of batchByParent.get(parent.id) ?? []) {
            // bm.quantity is the original positive batch qty.
            await applyBatchStockChange(
              tx,
              t.organizationId,
              bm.itemBatchId,
              bm.warehouseId,
              -bm.quantity,
            );
            await insertBatchMovement(
              tx,
              t.organizationId,
              cancelParentId,
              bm.itemBatchId,
              bm.warehouseId,
              -bm.quantity,
            );
          }
          touchedItems.add(parent.itemId);
        }

        // Update each PO line's quantityReceived from the receipt-line
        // metadata. Independent of the parent-movement loop above.
        for (const rl of receiptLines) {
          const qty = toNum(rl.line.quantity);
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

        await deriveAndUpdatePurchaseOrderStatus(
          tx,
          t.organizationId,
          receipt.purchaseOrderId,
        );
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
