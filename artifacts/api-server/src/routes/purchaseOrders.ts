import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  purchaseOrdersTable,
  purchaseOrderLinesTable,
  suppliersTable,
  warehousesTable,
  itemsTable,
  itemWarehouseStockTable,
  stockMovementsTable,
  goodsReceiptsTable,
  jobWorkReceiptsTable,
  jobWorkOrdersTable,
} from "@workspace/db";
import {
  tenantMiddleware,
  assertOwnership,
  findParentItems,
  findBundleItems,
} from "../lib/tenant";
import {
  serializePurchaseOrder,
  serializeOrderLine,
} from "../lib/serializers";
import { computeOrderTotals, nextOrderNumber } from "../lib/orderHelpers";
import { toNum, toStr } from "../lib/numeric";
import { pushStockToShopify } from "../lib/shopifyOutbound";
import { loadGoodsReceiptsForOrder } from "./goodsReceipts";

// `received` and `partially_received` are derived server-side from
// recorded goods receipts — clients cannot set them directly via PATCH /status.
const PATCHABLE_PURCHASE_STATUSES = [
  "draft",
  "ordered",
  "billed",
  "paid",
  "cancelled",
] as const;
type PatchablePurchaseStatus = (typeof PATCHABLE_PURCHASE_STATUSES)[number];
function isPatchablePurchaseStatus(s: string): s is PatchablePurchaseStatus {
  return (PATCHABLE_PURCHASE_STATUSES as readonly string[]).includes(s);
}

const router: IRouter = Router();
router.use(tenantMiddleware);

// Resolve {receiptId → {jobWorkOrderId, jwoNumber}} for a batch of POs
// so the serializer can include the back-link without an N+1 fetch.
async function loadJobWorkLinksForPos(
  orgId: number,
  receiptIds: number[],
): Promise<Map<number, { jobWorkOrderId: number; jwoNumber: string }>> {
  const m = new Map<number, { jobWorkOrderId: number; jwoNumber: string }>();
  if (receiptIds.length === 0) return m;
  const rows = await db
    .select({
      receiptId: jobWorkReceiptsTable.id,
      jobWorkOrderId: jobWorkReceiptsTable.jobWorkOrderId,
      jwoNumber: jobWorkOrdersTable.jwoNumber,
    })
    .from(jobWorkReceiptsTable)
    .innerJoin(
      jobWorkOrdersTable,
      eq(jobWorkOrdersTable.id, jobWorkReceiptsTable.jobWorkOrderId),
    )
    .where(
      and(
        eq(jobWorkReceiptsTable.organizationId, orgId),
        inArray(jobWorkReceiptsTable.id, receiptIds),
      ),
    );
  for (const r of rows) {
    m.set(r.receiptId, {
      jobWorkOrderId: r.jobWorkOrderId,
      jwoNumber: r.jwoNumber,
    });
  }
  return m;
}

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
    const receiptIds = rows
      .map((r) => r.order.jobWorkReceiptId)
      .filter((v): v is number => v !== null && v !== undefined);
    const links = await loadJobWorkLinksForPos(t.organizationId, receiptIds);
    res.json(
      rows.map((r) =>
        serializePurchaseOrder(
          r.order,
          r.supplierName,
          r.warehouseName,
          r.order.jobWorkReceiptId
            ? links.get(r.order.jobWorkReceiptId) ?? null
            : null,
        ),
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
      variantOptions: itemsTable.variantOptions,
      sku: itemsTable.sku,
      trackBatches: itemsTable.trackBatches,
    })
    .from(purchaseOrderLinesTable)
    .innerJoin(itemsTable, eq(itemsTable.id, purchaseOrderLinesTable.itemId))
    .where(eq(purchaseOrderLinesTable.purchaseOrderId, orderId));
  const goodsReceipts = await loadGoodsReceiptsForOrder(orgId, orderId);
  const receiptId = orderRows[0].order.jobWorkReceiptId;
  const links = receiptId
    ? await loadJobWorkLinksForPos(orgId, [receiptId])
    : new Map();
  return {
    order: serializePurchaseOrder(
      orderRows[0].order,
      orderRows[0].supplierName,
      orderRows[0].warehouseName,
      receiptId ? links.get(receiptId) ?? null : null,
    ),
    lines: lineRows.map((r) =>
      serializeOrderLine(
        r.line,
        r.itemName,
        r.sku,
        (r.variantOptions as Record<string, string> | null) ?? null,
        !!r.trackBatches,
      ),
    ),
    goodsReceipts,
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
    const parents = await findParentItems(t.organizationId, itemIds);
    if (parents.length > 0) {
      res.status(400).json({
        error: `Cannot use parent items on a purchase order. Pick a variant instead. Offending: ${parents
          .map((p) => p.sku)
          .join(", ")}`,
      });
      return;
    }
    const bundles = await findBundleItems(t.organizationId, itemIds);
    if (bundles.length > 0) {
      res.status(400).json({
        error: `Cannot receive bundle items on a purchase order. Order their components instead. Offending: ${bundles
          .map((p) => p.sku)
          .join(", ")}`,
      });
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
        amountPaid: "0",
        balanceDue: totals.total,
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
          discountPercent: l.discountPercent,
          discountAmount: l.discountAmount,
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

router.get("/purchase-orders/:id/pdf", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "Invalid purchase order id" });
      return;
    }
    const { loadPurchaseOrderPdf } = await import("../lib/purchaseOrderPdfData");
    const result = await loadPurchaseOrderPdf(t.organizationId, id);
    if ("notFound" in result) {
      res.status(404).json({ error: "Purchase order not found" });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="purchase-order-${result.orderNumber}.pdf"`,
    );
    res.setHeader("Cache-Control", "private, max-age=0, no-store");
    res.setHeader("Content-Length", String(result.pdf.length));
    res.send(result.pdf);
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
    if (itemIds.length) {
      const parents = await findParentItems(t.organizationId, itemIds);
      if (parents.length > 0) {
        res.status(400).json({
          error: `Cannot use parent items on a purchase order. Pick a variant instead. Offending: ${parents
            .map((p) => p.sku)
            .join(", ")}`,
        });
        return;
      }
      const bundles = await findBundleItems(t.organizationId, itemIds);
      if (bundles.length > 0) {
        res.status(400).json({
          error: `Cannot receive bundle items on a purchase order. Order their components instead. Offending: ${bundles
            .map((p) => p.sku)
            .join(", ")}`,
        });
        return;
      }
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
      // Draft orders cannot have payments yet, so we can safely
      // resync balance_due to the new total.
      update.amountPaid = "0";
      update.balanceDue = totals.total;
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
            discountPercent: l.discountPercent,
            discountAmount: l.discountAmount,
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
      .where(
        and(
          eq(purchaseOrdersTable.organizationId, t.organizationId),
          eq(purchaseOrdersTable.id, id),
        ),
      );
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
    // Auto-bills are owned by their job-work receipt — only the
    // receipt-cancel flow can delete them, otherwise the JWO would
    // be left holding a dangling reference.
    const existing = await db
      .select({ jobWorkReceiptId: purchaseOrdersTable.jobWorkReceiptId })
      .from(purchaseOrdersTable)
      .where(
        and(
          eq(purchaseOrdersTable.id, id),
          eq(purchaseOrdersTable.organizationId, t.organizationId),
        ),
      )
      .limit(1);
    if (existing[0]?.jobWorkReceiptId) {
      res.status(400).json({
        error:
          "This bill was auto-created from a job-work receipt. Cancel the receipt to remove it.",
      });
      return;
    }
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
    if (newStatus === "received" || newStatus === "partially_received") {
      res.status(400).json({
        error:
          "Use POST /purchase-orders/:id/goods-receipts to record receipts; the order status is derived automatically.",
      });
      return;
    }
    if (!isPatchablePurchaseStatus(newStatus)) {
      res.status(400).json({
        error: `Invalid status. Allowed: ${PATCHABLE_PURCHASE_STATUSES.join(", ")}`,
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
    if (order.jobWorkReceiptId) {
      res.status(400).json({
        error:
          "Status of an auto-created job-work bill is managed via the job-work receipt. Cancel the receipt to void this bill.",
      });
      return;
    }
    if (order.status === "returned") {
      res.status(400).json({
        error: "Returned orders are final and cannot change status.",
      });
      return;
    }

    // Validate per-status transition rules (mirror of sales-orders).
    const lineRows = await db
      .select({
        qty: purchaseOrderLinesTable.quantity,
        received: purchaseOrderLinesTable.quantityReceived,
      })
      .from(purchaseOrderLinesTable)
      .where(eq(purchaseOrderLinesTable.purchaseOrderId, id));
    const totalReceived = lineRows.reduce((s, l) => s + toNum(l.received), 0);

    if (newStatus === "draft" || newStatus === "ordered") {
      if (totalReceived > 0) {
        res.status(400).json({
          error:
            "Cannot revert to draft or ordered once receipts have been recorded. Cancel the receipts first.",
        });
        return;
      }
      if (order.status === "billed" || order.status === "paid") {
        res.status(400).json({
          error: "Cannot revert a billed or paid order to an earlier status.",
        });
        return;
      }
    }
    if (newStatus === "cancelled") {
      const activeReceipts = await db
        .select({ id: goodsReceiptsTable.id })
        .from(goodsReceiptsTable)
        .where(
          and(
            eq(goodsReceiptsTable.organizationId, t.organizationId),
            eq(goodsReceiptsTable.purchaseOrderId, id),
            sql`${goodsReceiptsTable.status} <> 'cancelled'`,
          ),
        )
        .limit(1);
      if (activeReceipts[0]) {
        res.status(400).json({
          error:
            "Cannot cancel an order that has recorded receipts. Cancel the receipts first.",
        });
        return;
      }
      if (!["draft", "ordered"].includes(order.status)) {
        res.status(400).json({
          error: "Cancellation is only allowed from draft or ordered orders.",
        });
        return;
      }
    }
    if (
      newStatus === "billed" &&
      !["received", "partially_received", "billed"].includes(order.status)
    ) {
      res.status(400).json({
        error: "Billed is only valid after at least one receipt has been recorded.",
      });
      return;
    }
    if (
      newStatus === "paid" &&
      !["received", "partially_received", "billed", "paid"].includes(
        order.status,
      )
    ) {
      res.status(400).json({
        error: "Paid is only valid after at least one receipt has been recorded.",
      });
      return;
    }

    await db
      .update(purchaseOrdersTable)
      .set({ status: newStatus })
      .where(
        and(
          eq(purchaseOrdersTable.organizationId, t.organizationId),
          eq(purchaseOrdersTable.id, id),
        ),
      );

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
    if (order.jobWorkReceiptId) {
      res.status(400).json({
        error:
          "Auto-created job-work bills cannot be returned. Cancel the originating job-work receipt instead.",
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
            sql`${purchaseOrdersTable.status} IN ('received','partially_received','billed','paid')`,
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

      const touched: number[] = [];
      for (const line of lines) {
        const qty = toNum(line.quantityReceived);
        if (qty <= 0) continue;
        touched.push(line.itemId);
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
      return { conflict: false as const, itemIds: touched };
    });

    if (result.conflict) {
      res.status(409).json({
        error: "Order has already been returned by another request.",
      });
      return;
    }
    for (const itemId of new Set(result.itemIds)) {
      pushStockToShopify(t.organizationId, itemId);
    }

    const detail = await loadDetail(t.organizationId, id);
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

export default router;
