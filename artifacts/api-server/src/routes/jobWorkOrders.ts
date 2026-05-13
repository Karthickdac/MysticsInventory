import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  db,
  jobWorkOrdersTable,
  jobWorkOrderComponentsTable,
  jobWorkIssuesTable,
  jobWorkIssueLinesTable,
  jobWorkReceiptsTable,
  jobWorkReceiptComponentsTable,
  itemsTable,
  itemBundleComponentsTable,
  itemWarehouseStockTable,
  warehousesTable,
  suppliersTable,
  stockMovementsTable,
  purchaseOrdersTable,
  purchaseOrderLinesTable,
  supplierPaymentAllocationsTable,
} from "@workspace/db";
import { tenantMiddleware, assertOwnership } from "../lib/tenant";
import { nextOrderNumber } from "../lib/orderHelpers";
import { toNum, toStr } from "../lib/numeric";

const router: IRouter = Router();
router.use(tenantMiddleware);

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const STATUS_DRAFT = "draft";
const STATUS_ISSUED = "issued";
const STATUS_PARTIAL = "partially_received";
const STATUS_COMPLETED = "completed";
const STATUS_CANCELLED = "cancelled";

const STATUSES = [
  STATUS_DRAFT,
  STATUS_ISSUED,
  STATUS_PARTIAL,
  STATUS_COMPLETED,
  STATUS_CANCELLED,
] as const;

function isValidIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

// Atomic stock change. Same pattern as stockTransfers.ts: row-locked
// UPDATE that serialises concurrent writes on the same cell, falling
// back to INSERT when the cell does not yet exist.
async function applyStockChange(
  tx: Tx,
  orgId: number,
  itemId: number,
  warehouseId: number,
  delta: number,
) {
  const updated = await tx
    .update(itemWarehouseStockTable)
    .set({
      quantity: sql`${itemWarehouseStockTable.quantity} + ${toStr(delta)}::numeric`,
    })
    .where(
      and(
        eq(itemWarehouseStockTable.organizationId, orgId),
        eq(itemWarehouseStockTable.itemId, itemId),
        eq(itemWarehouseStockTable.warehouseId, warehouseId),
      ),
    )
    .returning({ id: itemWarehouseStockTable.id });
  if (updated.length === 0) {
    await tx.insert(itemWarehouseStockTable).values({
      organizationId: orgId,
      itemId,
      warehouseId,
      quantity: toStr(delta),
    });
  }
}

// Find or create the virtual warehouse that mirrors a supplier's
// premises. We allocate one per (org, supplier) and reuse it across
// every JWO with that supplier so per-component balances accumulate
// naturally and reports group cleanly.
export async function ensureVendorWarehouse(
  tx: Tx,
  orgId: number,
  supplierId: number,
  supplierName: string,
): Promise<number> {
  const existing = await tx
    .select({ id: warehousesTable.id })
    .from(warehousesTable)
    .where(
      and(
        eq(warehousesTable.organizationId, orgId),
        eq(warehousesTable.jobWorkerSupplierId, supplierId),
        eq(warehousesTable.isVirtual, true),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0].id;

  // Build a stable, readable code that is unlikely to collide with a
  // user-defined warehouse code. Suffix with the supplierId for
  // uniqueness across same-named workers.
  const code = `JW-${supplierId}`;
  try {
    const inserted = await tx
      .insert(warehousesTable)
      .values({
        organizationId: orgId,
        name: `Job Worker — ${supplierName}`,
        code,
        isVirtual: true,
        jobWorkerSupplierId: supplierId,
      })
      .returning({ id: warehousesTable.id });
    return inserted[0]!.id;
  } catch (err: unknown) {
    // Two concurrent "issue materials" calls for the same worker can
    // both pass the existence check above and race to INSERT. The
    // partial unique index on warehouses (organization_id,
    // job_worker_supplier_id) WHERE is_virtual=true makes Postgres
    // raise unique_violation (SQLSTATE 23505) on the loser. Re-read
    // and reuse the row the winner just committed instead of
    // surfacing a 500 to the user.
    const code23505 =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code23505 !== "23505") throw err;
    const winner = await tx
      .select({ id: warehousesTable.id })
      .from(warehousesTable)
      .where(
        and(
          eq(warehousesTable.organizationId, orgId),
          eq(warehousesTable.jobWorkerSupplierId, supplierId),
          eq(warehousesTable.isVirtual, true),
        ),
      )
      .limit(1);
    if (!winner[0]) throw err;
    return winner[0].id;
  }
}

async function loadOrderRow(orgId: number, id: number) {
  const rows = await db
    .select({
      o: jobWorkOrdersTable,
      supplierName: suppliersTable.name,
      outputItemName: itemsTable.name,
      outputItemSku: itemsTable.sku,
    })
    .from(jobWorkOrdersTable)
    .innerJoin(
      suppliersTable,
      eq(suppliersTable.id, jobWorkOrdersTable.supplierId),
    )
    .innerJoin(
      itemsTable,
      eq(itemsTable.id, jobWorkOrdersTable.outputItemId),
    )
    .where(
      and(
        eq(jobWorkOrdersTable.id, id),
        eq(jobWorkOrdersTable.organizationId, orgId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function serializeOrder(
  o: typeof jobWorkOrdersTable.$inferSelect,
  supplierName: string,
  outputItemName: string,
  outputItemSku: string,
  warehouseNames: { source?: string; dest?: string; vendor?: string },
  totals?: { received?: number; scrapped?: number },
) {
  const base = {
    id: o.id,
    jwoNumber: o.jwoNumber,
    supplierId: o.supplierId,
    supplierName,
    outputItemId: o.outputItemId,
    outputItemName,
    outputItemSku,
    outputQuantity: toNum(o.outputQuantity),
    sourceWarehouseId: o.sourceWarehouseId,
    sourceWarehouseName: warehouseNames.source ?? null,
    destWarehouseId: o.destWarehouseId,
    destWarehouseName: warehouseNames.dest ?? null,
    vendorWarehouseId: o.vendorWarehouseId,
    vendorWarehouseName: warehouseNames.vendor ?? null,
    jobChargeRate: toNum(o.jobChargeRate),
    expectedReturnDate: o.expectedReturnDate ?? null,
    notes: o.notes,
    status: o.status,
    createdAt: o.createdAt.toISOString(),
  };
  if (totals) {
    const received = totals.received ?? 0;
    const scrapped = totals.scrapped ?? 0;
    return {
      ...base,
      receivedQuantity: received,
      scrappedQuantity: scrapped,
      remainingQuantity: Math.max(
        0,
        toNum(o.outputQuantity) - received - scrapped,
      ),
    };
  }
  return base;
}

async function loadDetail(orgId: number, id: number) {
  const row = await loadOrderRow(orgId, id);
  if (!row) return null;
  const o = row.o;
  const whIds = Array.from(
    new Set([o.sourceWarehouseId, o.destWarehouseId, o.vendorWarehouseId]),
  );
  const whRows = await db
    .select({ id: warehousesTable.id, name: warehousesTable.name })
    .from(warehousesTable)
    .where(
      and(
        eq(warehousesTable.organizationId, orgId),
        inArray(warehousesTable.id, whIds),
      ),
    );
  const whName = new Map(whRows.map((w) => [w.id, w.name]));

  const componentRows = await db
    .select({
      c: jobWorkOrderComponentsTable,
      itemName: itemsTable.name,
      itemSku: itemsTable.sku,
    })
    .from(jobWorkOrderComponentsTable)
    .innerJoin(
      itemsTable,
      eq(itemsTable.id, jobWorkOrderComponentsTable.componentItemId),
    )
    .where(
      and(
        eq(jobWorkOrderComponentsTable.organizationId, orgId),
        eq(jobWorkOrderComponentsTable.jobWorkOrderId, id),
      ),
    )
    .orderBy(asc(jobWorkOrderComponentsTable.id));

  const issueRows = await db
    .select()
    .from(jobWorkIssuesTable)
    .where(
      and(
        eq(jobWorkIssuesTable.organizationId, orgId),
        eq(jobWorkIssuesTable.jobWorkOrderId, id),
      ),
    )
    .orderBy(desc(jobWorkIssuesTable.id));
  const issueIds = issueRows.map((i) => i.id);
  const issueLineRows = issueIds.length
    ? await db
        .select({
          l: jobWorkIssueLinesTable,
          itemName: itemsTable.name,
          itemSku: itemsTable.sku,
        })
        .from(jobWorkIssueLinesTable)
        .innerJoin(
          itemsTable,
          eq(itemsTable.id, jobWorkIssueLinesTable.componentItemId),
        )
        .where(
          and(
            eq(jobWorkIssueLinesTable.organizationId, orgId),
            inArray(jobWorkIssueLinesTable.jobWorkIssueId, issueIds),
          ),
        )
    : [];
  const issueLinesByIssue = new Map<number, typeof issueLineRows>();
  for (const r of issueLineRows) {
    const arr = issueLinesByIssue.get(r.l.jobWorkIssueId) ?? [];
    arr.push(r);
    issueLinesByIssue.set(r.l.jobWorkIssueId, arr);
  }

  const receiptRows = await db
    .select()
    .from(jobWorkReceiptsTable)
    .where(
      and(
        eq(jobWorkReceiptsTable.organizationId, orgId),
        eq(jobWorkReceiptsTable.jobWorkOrderId, id),
      ),
    )
    .orderBy(desc(jobWorkReceiptsTable.id));
  const receiptIds = receiptRows.map((r) => r.id);
  const receiptCompRows = receiptIds.length
    ? await db
        .select({
          c: jobWorkReceiptComponentsTable,
          itemName: itemsTable.name,
          itemSku: itemsTable.sku,
        })
        .from(jobWorkReceiptComponentsTable)
        .innerJoin(
          itemsTable,
          eq(
            itemsTable.id,
            jobWorkReceiptComponentsTable.componentItemId,
          ),
        )
        .where(
          and(
            eq(jobWorkReceiptComponentsTable.organizationId, orgId),
            inArray(
              jobWorkReceiptComponentsTable.jobWorkReceiptId,
              receiptIds,
            ),
          ),
        )
    : [];
  const receiptCompsByReceipt = new Map<number, typeof receiptCompRows>();
  for (const r of receiptCompRows) {
    const arr = receiptCompsByReceipt.get(r.c.jobWorkReceiptId) ?? [];
    arr.push(r);
    receiptCompsByReceipt.set(r.c.jobWorkReceiptId, arr);
  }

  // Pull each receipt's auto-created bill so the Charges/Receipts
  // tabs can deep-link to the supplier bill view.
  const billRows = receiptIds.length
    ? await db
        .select({
          jobWorkReceiptId: purchaseOrdersTable.jobWorkReceiptId,
          purchaseOrderId: purchaseOrdersTable.id,
          purchaseOrderNumber: purchaseOrdersTable.orderNumber,
        })
        .from(purchaseOrdersTable)
        .where(
          and(
            eq(purchaseOrdersTable.organizationId, orgId),
            inArray(
              purchaseOrdersTable.jobWorkReceiptId,
              receiptIds,
            ),
          ),
        )
    : [];
  const billByReceipt = new Map<
    number,
    { purchaseOrderId: number; purchaseOrderNumber: string }
  >();
  for (const b of billRows) {
    if (b.jobWorkReceiptId == null) continue;
    billByReceipt.set(b.jobWorkReceiptId, {
      purchaseOrderId: b.purchaseOrderId,
      purchaseOrderNumber: b.purchaseOrderNumber,
    });
  }

  // Roll-up totals shown on the detail page. Cancelled receipts have
  // already had their stock + payable + bill reversed, so we exclude
  // them from progress tallies.
  const liveReceipts = receiptRows.filter((r) => r.status !== "cancelled");
  const totalReceived = liveReceipts.reduce(
    (s, r) => s + toNum(r.finishedQuantity),
    0,
  );
  const totalScrapped = liveReceipts.reduce(
    (s, r) => s + toNum(r.scrapQuantity),
    0,
  );
  const totalCharges = liveReceipts.reduce(
    (s, r) => s + toNum(r.jobCharge),
    0,
  );

  return {
    order: serializeOrder(
      o,
      row.supplierName,
      row.outputItemName,
      row.outputItemSku,
      {
        source: whName.get(o.sourceWarehouseId),
        dest: whName.get(o.destWarehouseId),
        vendor: whName.get(o.vendorWarehouseId),
      },
    ),
    components: componentRows.map((r) => ({
      id: r.c.id,
      componentItemId: r.c.componentItemId,
      componentItemName: r.itemName,
      componentItemSku: r.itemSku,
      quantityPerOutput: toNum(r.c.quantityPerOutput),
      totalQuantity: toNum(r.c.totalQuantity),
    })),
    issues: issueRows.map((i) => ({
      id: i.id,
      issueNumber: i.issueNumber,
      issueDate: i.issueDate,
      notes: i.notes,
      createdAt: i.createdAt.toISOString(),
      lines: (issueLinesByIssue.get(i.id) ?? []).map((r) => ({
        id: r.l.id,
        componentItemId: r.l.componentItemId,
        componentItemName: r.itemName,
        componentItemSku: r.itemSku,
        quantity: toNum(r.l.quantity),
      })),
    })),
    receipts: receiptRows.map((r) => {
      const bill = billByReceipt.get(r.id) ?? null;
      return {
        id: r.id,
        receiptNumber: r.receiptNumber,
        receivedDate: r.receivedDate,
        finishedQuantity: toNum(r.finishedQuantity),
        scrapQuantity: toNum(r.scrapQuantity),
        jobCharge: toNum(r.jobCharge),
        notes: r.notes,
        status: r.status,
        purchaseOrderId: bill?.purchaseOrderId ?? null,
        purchaseOrderNumber: bill?.purchaseOrderNumber ?? null,
        createdAt: r.createdAt.toISOString(),
        components: (receiptCompsByReceipt.get(r.id) ?? []).map((cr) => ({
          id: cr.c.id,
          componentItemId: cr.c.componentItemId,
          componentItemName: cr.itemName,
          componentItemSku: cr.itemSku,
          quantityConsumed: toNum(cr.c.quantityConsumed),
          scrapQuantity: toNum(cr.c.scrapQuantity),
        })),
      };
    }),
    totals: {
      orderedQuantity: toNum(o.outputQuantity),
      receivedQuantity: totalReceived,
      scrappedQuantity: totalScrapped,
      remainingQuantity: Math.max(
        0,
        toNum(o.outputQuantity) - totalReceived - totalScrapped,
      ),
      totalCharges,
    },
  };
}

// Recompute an order's status from its receipts. Cancelled and draft
// statuses are sticky; otherwise the order moves through
// issued → partially_received → completed based on cumulative output.
async function deriveAndUpdateOrderStatus(
  tx: Tx,
  orgId: number,
  orderId: number,
) {
  const orderRows = await tx
    .select()
    .from(jobWorkOrdersTable)
    .where(
      and(
        eq(jobWorkOrdersTable.id, orderId),
        eq(jobWorkOrdersTable.organizationId, orgId),
      ),
    )
    .limit(1);
  const order = orderRows[0];
  if (!order) return;
  if (
    order.status === STATUS_DRAFT ||
    order.status === STATUS_CANCELLED
  ) {
    return;
  }
  const receiptRows = await tx
    .select({
      finishedQuantity: jobWorkReceiptsTable.finishedQuantity,
      scrapQuantity: jobWorkReceiptsTable.scrapQuantity,
      status: jobWorkReceiptsTable.status,
    })
    .from(jobWorkReceiptsTable)
    .where(
      and(
        eq(jobWorkReceiptsTable.organizationId, orgId),
        eq(jobWorkReceiptsTable.jobWorkOrderId, orderId),
      ),
    );
  let received = 0;
  let scrapped = 0;
  for (const r of receiptRows) {
    if (r.status === "cancelled") continue;
    received += toNum(r.finishedQuantity);
    scrapped += toNum(r.scrapQuantity);
  }
  const ordered = toNum(order.outputQuantity);
  const accountedFor = received + scrapped;
  let next: string;
  if (accountedFor + 1e-6 >= ordered) next = STATUS_COMPLETED;
  else if (received > 0 || scrapped > 0) next = STATUS_PARTIAL;
  else next = STATUS_ISSUED;
  if (next !== order.status) {
    await tx
      .update(jobWorkOrdersTable)
      .set({ status: next })
      .where(
        and(
          eq(jobWorkOrdersTable.id, orderId),
          eq(jobWorkOrdersTable.organizationId, orgId),
        ),
      );
  }
}

// ──────────────────────────────────────────────────────────────────
// LIST + GET
// ──────────────────────────────────────────────────────────────────

router.get("/job-work-orders", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const conds = [eq(jobWorkOrdersTable.organizationId, t.organizationId)];
    if (typeof req.query.status === "string" && req.query.status) {
      const s = req.query.status;
      if (!(STATUSES as readonly string[]).includes(s)) {
        res.status(400).json({ error: `Unknown status: ${s}` });
        return;
      }
      conds.push(eq(jobWorkOrdersTable.status, s));
    }
    if (req.query.supplierId) {
      const sid = Number(req.query.supplierId);
      if (!Number.isFinite(sid) || sid <= 0) {
        res.status(400).json({ error: "supplierId must be a positive integer" });
        return;
      }
      conds.push(eq(jobWorkOrdersTable.supplierId, sid));
    }
    const rows = await db
      .select({
        o: jobWorkOrdersTable,
        supplierName: suppliersTable.name,
        outputItemName: itemsTable.name,
        outputItemSku: itemsTable.sku,
      })
      .from(jobWorkOrdersTable)
      .innerJoin(
        suppliersTable,
        eq(suppliersTable.id, jobWorkOrdersTable.supplierId),
      )
      .innerJoin(
        itemsTable,
        eq(itemsTable.id, jobWorkOrdersTable.outputItemId),
      )
      .where(and(...conds))
      .orderBy(desc(jobWorkOrdersTable.createdAt));

    // Pull receipt totals for the listed orders so the list view can
    // show planned / received / pending columns without N+1 fetches.
    const orderIds = rows.map((r) => r.o.id);
    const receiptRows = orderIds.length
      ? await db
          .select({
            jobWorkOrderId: jobWorkReceiptsTable.jobWorkOrderId,
            finishedQuantity: jobWorkReceiptsTable.finishedQuantity,
            scrapQuantity: jobWorkReceiptsTable.scrapQuantity,
            status: jobWorkReceiptsTable.status,
          })
          .from(jobWorkReceiptsTable)
          .where(
            and(
              eq(
                jobWorkReceiptsTable.organizationId,
                t.organizationId,
              ),
              inArray(jobWorkReceiptsTable.jobWorkOrderId, orderIds),
            ),
          )
      : [];
    const totalsByOrder = new Map<
      number,
      { received: number; scrapped: number }
    >();
    for (const r of receiptRows) {
      if (r.status === "cancelled") continue;
      const cur = totalsByOrder.get(r.jobWorkOrderId) ?? {
        received: 0,
        scrapped: 0,
      };
      cur.received += toNum(r.finishedQuantity);
      cur.scrapped += toNum(r.scrapQuantity);
      totalsByOrder.set(r.jobWorkOrderId, cur);
    }

    res.json(
      rows.map((r) =>
        serializeOrder(
          r.o,
          r.supplierName,
          r.outputItemName,
          r.outputItemSku,
          {},
          totalsByOrder.get(r.o.id) ?? { received: 0, scrapped: 0 },
        ),
      ),
    );
  } catch (err) {
    next(err);
  }
});

router.get("/job-work-orders/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "id must be a positive integer" });
      return;
    }
    const detail = await loadDetail(t.organizationId, id);
    if (!detail) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

router.get(
  "/job-work-orders/:id/issues/:issueId/challan.pdf",
  async (req, res, next) => {
    try {
      const t = req.tenant!;
      const id = Number(req.params.id);
      const issueId = Number(req.params.issueId);
      if (
        !Number.isFinite(id) ||
        id <= 0 ||
        !Number.isFinite(issueId) ||
        issueId <= 0
      ) {
        res
          .status(400)
          .json({ error: "id and issueId must be positive integers" });
        return;
      }
      const { loadJwoChallanPdf } = await import(
        "../lib/jobWorkChallanPdfData"
      );
      const result = await loadJwoChallanPdf(t.organizationId, id, issueId);
      if ("notFound" in result) {
        res.status(404).json({ error: "Challan not found" });
        return;
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="challan-${result.issueNumber}.pdf"`,
      );
      res.setHeader("Cache-Control", "private, max-age=0, no-store");
      res.setHeader("Content-Length", String(result.pdf.length));
      res.send(result.pdf);
    } catch (err) {
      next(err);
    }
  },
);

router.get("/job-work-orders/:id/print", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "id must be a positive integer" });
      return;
    }
    const { loadJwoOrderPdf } = await import("../lib/jobWorkOrderPdfData");
    const result = await loadJwoOrderPdf(t.organizationId, id);
    if ("notFound" in result) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="jwo-${result.jwoNumber}.pdf"`,
    );
    res.setHeader("Cache-Control", "private, max-age=0, no-store");
    res.setHeader("Content-Length", String(result.pdf.length));
    res.send(result.pdf);
  } catch (err) {
    next(err);
  }
});

// Create JWO. Components default to the output item's bundle BOM.
// Allocates the supplier's vendor warehouse on demand. Starts DRAFT.
router.post("/job-work-orders", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const b = req.body ?? {};
    const supplierId = Number(b.supplierId);
    const outputItemId = Number(b.outputItemId);
    const sourceWarehouseId = Number(b.sourceWarehouseId);
    const destWarehouseId = Number(b.destWarehouseId);
    const outputQuantity = toNum(b.outputQuantity);
    const jobChargeRate =
      b.jobChargeRate === undefined || b.jobChargeRate === null
        ? 0
        : toNum(b.jobChargeRate);
    if (![supplierId, outputItemId, sourceWarehouseId, destWarehouseId].every(
      (n) => Number.isFinite(n) && n > 0,
    )) {
      res.status(400).json({
        error:
          "supplierId, outputItemId, sourceWarehouseId and destWarehouseId are required",
      });
      return;
    }
    if (!(outputQuantity > 0)) {
      res
        .status(400)
        .json({ error: "outputQuantity must be greater than zero" });
      return;
    }
    if (!(jobChargeRate >= 0)) {
      res
        .status(400)
        .json({ error: "jobChargeRate must be zero or greater" });
      return;
    }
    if (
      b.expectedReturnDate !== undefined &&
      b.expectedReturnDate !== null &&
      b.expectedReturnDate !== "" &&
      !isValidIsoDate(b.expectedReturnDate)
    ) {
      res
        .status(400)
        .json({ error: "expectedReturnDate must be YYYY-MM-DD" });
      return;
    }

    const own = await assertOwnership({
      organizationId: t.organizationId,
      supplierIds: [supplierId],
      itemIds: [outputItemId],
      warehouseIds: [sourceWarehouseId, destWarehouseId],
    });
    if (!own.ok) {
      res.status(400).json({ error: `Invalid ${own.missing}` });
      return;
    }

    // Supplier must be flagged as a job worker.
    const [supplierRow] = await db
      .select({ isJobWorker: suppliersTable.isJobWorker })
      .from(suppliersTable)
      .where(
        and(
          eq(suppliersTable.id, supplierId),
          eq(suppliersTable.organizationId, t.organizationId),
        ),
      )
      .limit(1);
    if (!supplierRow?.isJobWorker) {
      res.status(400).json({
        error:
          "Selected supplier is not marked as a job worker. Edit the supplier and enable the Job worker flag, or pick a different supplier.",
      });
      return;
    }

    // Reject the source/dest being a virtual warehouse — those exist
    // solely as vendor premises representations and must not be
    // pickable as real-world warehouses for a JWO.
    const whRows = await db
      .select({
        id: warehousesTable.id,
        isVirtual: warehousesTable.isVirtual,
      })
      .from(warehousesTable)
      .where(
        and(
          eq(warehousesTable.organizationId, t.organizationId),
          inArray(warehousesTable.id, [sourceWarehouseId, destWarehouseId]),
        ),
      );
    if (whRows.some((w) => w.isVirtual)) {
      res.status(400).json({
        error:
          "Source and destination warehouses must be real warehouses (not job-worker virtual warehouses).",
      });
      return;
    }

    // BOM snapshot: caller-supplied components, else output item's bundle.
    type RawComp = { componentItemId: number; quantityPerOutput: number };
    let snapshot: RawComp[] = [];
    if (Array.isArray(b.components) && b.components.length > 0) {
      const seen = new Set<number>();
      for (const c of b.components) {
        const cid = Number(c?.componentItemId);
        const qpo = toNum(c?.quantityPerOutput);
        if (!Number.isFinite(cid) || cid <= 0) {
          res.status(400).json({
            error: "Each component must include componentItemId",
          });
          return;
        }
        if (!(qpo > 0)) {
          res.status(400).json({
            error:
              "Each component's quantityPerOutput must be greater than zero",
          });
          return;
        }
        if (seen.has(cid)) {
          res.status(400).json({
            error: "Duplicate componentItemId in components",
          });
          return;
        }
        seen.add(cid);
        snapshot.push({ componentItemId: cid, quantityPerOutput: qpo });
      }
    } else {
      const bomRows = await db
        .select({
          componentItemId: itemBundleComponentsTable.componentItemId,
          quantityPerBundle: itemBundleComponentsTable.quantityPerBundle,
        })
        .from(itemBundleComponentsTable)
        .where(
          and(
            eq(itemBundleComponentsTable.organizationId, t.organizationId),
            eq(itemBundleComponentsTable.parentItemId, outputItemId),
          ),
        );
      snapshot = bomRows.map((r) => ({
        componentItemId: r.componentItemId,
        quantityPerOutput: toNum(r.quantityPerBundle),
      }));
    }
    if (snapshot.length === 0) {
      res.status(400).json({
        error:
          "Output item has no BOM components defined and no components were provided.",
      });
      return;
    }
    // Confirm every component belongs to this org.
    const compOwn = await assertOwnership({
      organizationId: t.organizationId,
      itemIds: snapshot.map((c) => c.componentItemId),
    });
    if (!compOwn.ok) {
      res.status(400).json({ error: `Invalid ${compOwn.missing}` });
      return;
    }

    const supplierRows = await db
      .select({ id: suppliersTable.id, name: suppliersTable.name })
      .from(suppliersTable)
      .where(
        and(
          eq(suppliersTable.id, supplierId),
          eq(suppliersTable.organizationId, t.organizationId),
        ),
      )
      .limit(1);
    const supplierName = supplierRows[0]?.name ?? "Job worker";

    const notes =
      typeof b.notes === "string" && b.notes.trim()
        ? String(b.notes).trim()
        : null;

    const createdId = await db.transaction(async (tx) => {
      const vendorWarehouseId = await ensureVendorWarehouse(
        tx,
        t.organizationId,
        supplierId,
        supplierName,
      );
      const inserted = await tx
        .insert(jobWorkOrdersTable)
        .values({
          organizationId: t.organizationId,
          jwoNumber: nextOrderNumber("JWO"),
          supplierId,
          outputItemId,
          outputQuantity: toStr(outputQuantity),
          sourceWarehouseId,
          destWarehouseId,
          vendorWarehouseId,
          jobChargeRate: toStr(jobChargeRate),
          expectedReturnDate:
            typeof b.expectedReturnDate === "string" &&
            b.expectedReturnDate !== ""
              ? b.expectedReturnDate
              : null,
          notes,
          status: STATUS_DRAFT,
        })
        .returning({ id: jobWorkOrdersTable.id });
      const newId = inserted[0]!.id;
      await tx.insert(jobWorkOrderComponentsTable).values(
        snapshot.map((c) => ({
          organizationId: t.organizationId,
          jobWorkOrderId: newId,
          componentItemId: c.componentItemId,
          quantityPerOutput: toStr(c.quantityPerOutput),
          totalQuantity: toStr(c.quantityPerOutput * outputQuantity),
        })),
      );
      return newId;
    });

    const detail = await loadDetail(t.organizationId, createdId);
    res.status(201).json(detail);
  } catch (err) {
    next(err);
  }
});

// Patch JWO. Full edits are DRAFT only. Once the order is open
// (ISSUED / PARTIALLY_RECEIVED) we still allow editing the per-unit
// jobChargeRate so users can honour mid-job price negotiations
// without cancelling the order. Existing receipts and the bills they
// produced keep their original jobCharge — only future receipts
// pick up the new rate.
router.patch("/job-work-orders/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const existing = (
      await db
        .select()
        .from(jobWorkOrdersTable)
        .where(
          and(
            eq(jobWorkOrdersTable.id, id),
            eq(jobWorkOrdersTable.organizationId, t.organizationId),
          ),
        )
        .limit(1)
    )[0];
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // Rate-only edit path for open (already-issued) orders. We treat
    // this as a narrow guardrail: any other field is rejected so we
    // can't accidentally renumber components or change quantities
    // after stock has moved.
    if (existing.status !== STATUS_DRAFT) {
      if (
        existing.status === STATUS_COMPLETED ||
        existing.status === STATUS_CANCELLED
      ) {
        res.status(400).json({
          error: `Cannot edit a ${existing.status} job-work order.`,
        });
        return;
      }
      const allowedKeys = new Set([
        "jobChargeRate",
        "expectedReturnDate",
        "notes",
      ]);
      const otherKeys = Object.keys(b).filter(
        (k) => !allowedKeys.has(k) && b[k] !== undefined,
      );
      if (otherKeys.length > 0) {
        res.status(400).json({
          error:
            "Once a job-work order has been issued, only the per-unit job charge rate, expected return date and notes can be edited. Cancel and recreate to change other fields.",
        });
        return;
      }
      const updates: Partial<typeof jobWorkOrdersTable.$inferInsert> = {};
      if (b.jobChargeRate !== undefined) {
        const newRate = toNum(b.jobChargeRate);
        if (!(newRate >= 0)) {
          res.status(400).json({
            error: "jobChargeRate must be zero or greater",
          });
          return;
        }
        updates.jobChargeRate = toStr(newRate);
      }
      if (b.expectedReturnDate !== undefined) {
        if (
          b.expectedReturnDate !== null &&
          b.expectedReturnDate !== "" &&
          !isValidIsoDate(b.expectedReturnDate)
        ) {
          res
            .status(400)
            .json({ error: "expectedReturnDate must be YYYY-MM-DD" });
          return;
        }
        updates.expectedReturnDate =
          b.expectedReturnDate === null || b.expectedReturnDate === ""
            ? null
            : b.expectedReturnDate;
      }
      if (b.notes !== undefined) {
        if (b.notes !== null && typeof b.notes !== "string") {
          res.status(400).json({ error: "notes must be a string or null" });
          return;
        }
        updates.notes =
          b.notes === null || b.notes === "" ? null : (b.notes as string);
      }
      if (Object.keys(updates).length === 0) {
        res.status(400).json({
          error:
            "Provide at least one of jobChargeRate, expectedReturnDate or notes.",
        });
        return;
      }
      await db
        .update(jobWorkOrdersTable)
        .set(updates)
        .where(
          and(
            eq(jobWorkOrdersTable.organizationId, t.organizationId),
            eq(jobWorkOrdersTable.id, id),
          ),
        );
      const detail = await loadDetail(t.organizationId, id);
      res.json(detail);
      return;
    }

    const outputQuantity =
      b.outputQuantity === undefined
        ? toNum(existing.outputQuantity)
        : toNum(b.outputQuantity);
    if (!(outputQuantity > 0)) {
      res
        .status(400)
        .json({ error: "outputQuantity must be greater than zero" });
      return;
    }
    const jobChargeRate =
      b.jobChargeRate === undefined
        ? toNum(existing.jobChargeRate)
        : toNum(b.jobChargeRate);
    if (!(jobChargeRate >= 0)) {
      res
        .status(400)
        .json({ error: "jobChargeRate must be zero or greater" });
      return;
    }

    let parsedComponents: Array<{
      componentItemId: number;
      quantityPerOutput: number;
    }> | null = null;
    if (Array.isArray(b.components)) {
      const seen = new Set<number>();
      parsedComponents = [];
      for (const c of b.components) {
        const cid = Number(c?.componentItemId);
        const qpo = toNum(c?.quantityPerOutput);
        if (!Number.isFinite(cid) || cid <= 0) {
          res.status(400).json({
            error: "Each component must include componentItemId",
          });
          return;
        }
        if (!(qpo > 0)) {
          res.status(400).json({
            error:
              "Each component's quantityPerOutput must be greater than zero",
          });
          return;
        }
        if (seen.has(cid)) {
          res.status(400).json({
            error: "Duplicate componentItemId in components",
          });
          return;
        }
        seen.add(cid);
        parsedComponents.push({
          componentItemId: cid,
          quantityPerOutput: qpo,
        });
      }
      if (parsedComponents.length === 0) {
        res
          .status(400)
          .json({ error: "Components list cannot be empty" });
        return;
      }
      const compOwn = await assertOwnership({
        organizationId: t.organizationId,
        itemIds: parsedComponents.map((c) => c.componentItemId),
      });
      if (!compOwn.ok) {
        res.status(400).json({ error: `Invalid ${compOwn.missing}` });
        return;
      }
    }

    if (
      b.expectedReturnDate !== undefined &&
      b.expectedReturnDate !== null &&
      b.expectedReturnDate !== "" &&
      !isValidIsoDate(b.expectedReturnDate)
    ) {
      res
        .status(400)
        .json({ error: "expectedReturnDate must be YYYY-MM-DD" });
      return;
    }

    await db.transaction(async (tx) => {
      await tx
        .update(jobWorkOrdersTable)
        .set({
          outputQuantity: toStr(outputQuantity),
          jobChargeRate: toStr(jobChargeRate),
          expectedReturnDate:
            b.expectedReturnDate === undefined
              ? existing.expectedReturnDate
              : b.expectedReturnDate === null || b.expectedReturnDate === ""
                ? null
                : b.expectedReturnDate,
          notes: b.notes === undefined ? existing.notes : b.notes,
        })
        .where(
          and(
            eq(jobWorkOrdersTable.id, id),
            eq(jobWorkOrdersTable.organizationId, t.organizationId),
          ),
        );
      if (parsedComponents) {
        await tx
          .delete(jobWorkOrderComponentsTable)
          .where(
            and(
              eq(jobWorkOrderComponentsTable.organizationId, t.organizationId),
              eq(jobWorkOrderComponentsTable.jobWorkOrderId, id),
            ),
          );
        await tx.insert(jobWorkOrderComponentsTable).values(
          parsedComponents.map((c) => ({
            organizationId: t.organizationId,
            jobWorkOrderId: id,
            componentItemId: c.componentItemId,
            quantityPerOutput: toStr(c.quantityPerOutput),
            totalQuantity: toStr(c.quantityPerOutput * outputQuantity),
          })),
        );
      } else if (b.outputQuantity !== undefined) {
        // outputQuantity changed — recompute totalQuantity for each
        // existing component row using the snapshot's quantityPerOutput.
        const comps = await tx
          .select()
          .from(jobWorkOrderComponentsTable)
          .where(
            and(
              eq(jobWorkOrderComponentsTable.organizationId, t.organizationId),
              eq(jobWorkOrderComponentsTable.jobWorkOrderId, id),
            ),
          );
        for (const c of comps) {
          await tx
            .update(jobWorkOrderComponentsTable)
            .set({
              totalQuantity: toStr(
                toNum(c.quantityPerOutput) * outputQuantity,
              ),
            })
            .where(
              and(
                eq(jobWorkOrderComponentsTable.organizationId, t.organizationId),
                eq(jobWorkOrderComponentsTable.id, c.id),
              ),
            );
        }
      }
    });

    const detail = await loadDetail(t.organizationId, id);
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

// Cancel JWO. Does not auto-reverse issued material; record pull-back as a stock transfer.
router.post("/job-work-orders/:id/cancel", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const result = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(jobWorkOrdersTable)
        .where(
          and(
            eq(jobWorkOrdersTable.id, id),
            eq(jobWorkOrdersTable.organizationId, t.organizationId),
          ),
        )
        .for("update")
        .limit(1);
      const order = rows[0];
      if (!order) return { kind: "notfound" as const };
      if (order.status === STATUS_CANCELLED) {
        return {
          kind: "bad" as const,
          message: "Order is already cancelled.",
        };
      }
      if (order.status === STATUS_COMPLETED) {
        return {
          kind: "bad" as const,
          message: "Completed orders cannot be cancelled.",
        };
      }
      await tx
        .update(jobWorkOrdersTable)
        .set({ status: STATUS_CANCELLED })
        .where(
          and(
            eq(jobWorkOrdersTable.organizationId, t.organizationId),
            eq(jobWorkOrdersTable.id, id),
          ),
        );
      return { kind: "ok" as const };
    });
    if (result.kind === "notfound") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (result.kind === "bad") {
      res.status(400).json({ error: result.message });
      return;
    }
    const detail = await loadDetail(t.organizationId, id);
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

// Issue material to vendor warehouse; writes job_work_issue movements both sides.
router.post("/job-work-orders/:id/issue", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const issueDate =
      typeof b.issueDate === "string" && b.issueDate
        ? b.issueDate
        : new Date().toISOString().slice(0, 10);
    if (!isValidIsoDate(issueDate)) {
      res.status(400).json({ error: "issueDate must be YYYY-MM-DD" });
      return;
    }
    const inputLines = Array.isArray(b.lines) ? b.lines : [];
    if (inputLines.length === 0) {
      res
        .status(400)
        .json({ error: "At least one component line is required" });
      return;
    }
    const parsed: Array<{ componentItemId: number; quantity: number }> = [];
    const seen = new Set<number>();
    for (const l of inputLines) {
      const cid = Number(l?.componentItemId);
      const qty = toNum(l?.quantity);
      if (!Number.isFinite(cid) || cid <= 0) {
        res
          .status(400)
          .json({ error: "Each line must include componentItemId" });
        return;
      }
      if (!(qty > 0)) {
        res.status(400).json({
          error: "Each line quantity must be greater than zero",
        });
        return;
      }
      if (seen.has(cid)) {
        res
          .status(400)
          .json({ error: "Duplicate componentItemId in lines" });
        return;
      }
      seen.add(cid);
      parsed.push({ componentItemId: cid, quantity: qty });
    }
    const notes =
      typeof b.notes === "string" && b.notes.trim()
        ? String(b.notes).trim()
        : null;

    const result = await db.transaction(async (tx) => {
      const orderRows = await tx
        .select()
        .from(jobWorkOrdersTable)
        .where(
          and(
            eq(jobWorkOrdersTable.id, id),
            eq(jobWorkOrdersTable.organizationId, t.organizationId),
          ),
        )
        .for("update")
        .limit(1);
      const order = orderRows[0];
      if (!order) return { kind: "notfound" as const };
      if (
        order.status !== STATUS_DRAFT &&
        order.status !== STATUS_ISSUED &&
        order.status !== STATUS_PARTIAL
      ) {
        return {
          kind: "bad" as const,
          message: `Cannot issue material when order is ${order.status}.`,
        };
      }

      // Validate components belong to this order.
      const componentRows = await tx
        .select()
        .from(jobWorkOrderComponentsTable)
        .where(
          and(
            eq(
              jobWorkOrderComponentsTable.organizationId,
              t.organizationId,
            ),
            eq(jobWorkOrderComponentsTable.jobWorkOrderId, id),
          ),
        );
      const componentById = new Map(
        componentRows.map((c) => [c.componentItemId, c]),
      );
      for (const p of parsed) {
        if (!componentById.has(p.componentItemId)) {
          return {
            kind: "bad" as const,
            message: `Component ${p.componentItemId} is not part of this job-work order.`,
          };
        }
      }

      // Oversend prevention: cumulative issued (across all challans)
      // must not exceed the planned BOM total. Pull prior totals per
      // component and reject if this challan would push us past the
      // plan. We start strict — no over-issue tolerance.
      const priorIssuedRows = await tx
        .select({
          componentItemId: jobWorkIssueLinesTable.componentItemId,
          quantity: jobWorkIssueLinesTable.quantity,
        })
        .from(jobWorkIssueLinesTable)
        .innerJoin(
          jobWorkIssuesTable,
          eq(
            jobWorkIssuesTable.id,
            jobWorkIssueLinesTable.jobWorkIssueId,
          ),
        )
        .where(
          and(
            eq(jobWorkIssueLinesTable.organizationId, t.organizationId),
            eq(jobWorkIssuesTable.organizationId, t.organizationId),
            eq(jobWorkIssuesTable.jobWorkOrderId, id),
          ),
        );
      const priorByComponent = new Map<number, number>();
      for (const r of priorIssuedRows) {
        priorByComponent.set(
          r.componentItemId,
          (priorByComponent.get(r.componentItemId) ?? 0) + toNum(r.quantity),
        );
      }
      for (const p of parsed) {
        const planned = toNum(
          componentById.get(p.componentItemId)!.totalQuantity,
        );
        const prior = priorByComponent.get(p.componentItemId) ?? 0;
        if (prior + p.quantity - planned > 1e-6) {
          const remaining = Math.max(0, planned - prior);
          return {
            kind: "bad" as const,
            message: `Issue would exceed planned quantity for component ${p.componentItemId}: planned ${planned}, already issued ${prior}, remaining ${remaining}.`,
          };
        }
      }

      // Lock + verify on-hand at the source warehouse for each line.
      // We only validate physical stock here (no per-batch handling
      // for the v1 of this module — workers ship loose, not by batch).
      const itemRows = await tx
        .select({
          id: itemsTable.id,
          name: itemsTable.name,
          sku: itemsTable.sku,
        })
        .from(itemsTable)
        .where(
          and(
            eq(itemsTable.organizationId, t.organizationId),
            inArray(
              itemsTable.id,
              parsed.map((p) => p.componentItemId),
            ),
          ),
        );
      const itemById = new Map(itemRows.map((r) => [r.id, r]));

      for (const p of parsed) {
        const stockRows = await tx
          .select({ quantity: itemWarehouseStockTable.quantity })
          .from(itemWarehouseStockTable)
          .where(
            and(
              eq(itemWarehouseStockTable.organizationId, t.organizationId),
              eq(itemWarehouseStockTable.itemId, p.componentItemId),
              eq(
                itemWarehouseStockTable.warehouseId,
                order.sourceWarehouseId,
              ),
            ),
          )
          .for("update")
          .limit(1);
        const onHand = stockRows[0] ? toNum(stockRows[0].quantity) : 0;
        if (p.quantity - onHand > 1e-6) {
          const meta = itemById.get(p.componentItemId);
          const label = meta
            ? `${meta.name} (${meta.sku})`
            : `item ${p.componentItemId}`;
          return {
            kind: "bad" as const,
            message: `Insufficient stock at source for ${label}: need ${p.quantity}, on hand ${onHand}.`,
          };
        }
      }

      const issueInsert = await tx
        .insert(jobWorkIssuesTable)
        .values({
          organizationId: t.organizationId,
          jobWorkOrderId: id,
          issueNumber: nextOrderNumber("JWI"),
          issueDate,
          notes,
        })
        .returning({
          id: jobWorkIssuesTable.id,
          issueNumber: jobWorkIssuesTable.issueNumber,
        });
      const issue = issueInsert[0]!;

      await tx.insert(jobWorkIssueLinesTable).values(
        parsed.map((p) => ({
          organizationId: t.organizationId,
          jobWorkIssueId: issue.id,
          componentItemId: p.componentItemId,
          quantity: toStr(p.quantity),
        })),
      );

      // Decrement source warehouse, increment vendor warehouse, and
      // write a paired stock movement on each side. Movement types
      // mirror the codebase's snake_case convention so reports can
      // filter on them as a group.
      for (const p of parsed) {
        await applyStockChange(
          tx,
          t.organizationId,
          p.componentItemId,
          order.sourceWarehouseId,
          -p.quantity,
        );
        await tx.insert(stockMovementsTable).values({
          organizationId: t.organizationId,
          itemId: p.componentItemId,
          warehouseId: order.sourceWarehouseId,
          movementType: "job_work_issue",
          quantity: toStr(-p.quantity),
          referenceType: "job_work_issue",
          referenceId: issue.id,
          notes: `Issued via ${issue.issueNumber} (${order.jwoNumber})`,
        });
        await applyStockChange(
          tx,
          t.organizationId,
          p.componentItemId,
          order.vendorWarehouseId,
          p.quantity,
        );
        await tx.insert(stockMovementsTable).values({
          organizationId: t.organizationId,
          itemId: p.componentItemId,
          warehouseId: order.vendorWarehouseId,
          movementType: "job_work_issue",
          quantity: toStr(p.quantity),
          referenceType: "job_work_issue",
          referenceId: issue.id,
          notes: `Received at job worker via ${issue.issueNumber}`,
        });
      }

      // Promote DRAFT → ISSUED on first issue. Status derivation
      // handles later transitions when receipts come in.
      if (order.status === STATUS_DRAFT) {
        await tx
          .update(jobWorkOrdersTable)
          .set({ status: STATUS_ISSUED })
          .where(
            and(
              eq(jobWorkOrdersTable.organizationId, t.organizationId),
              eq(jobWorkOrdersTable.id, id),
            ),
          );
      }

      return { kind: "ok" as const };
    });

    if (result.kind === "notfound") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (result.kind === "bad") {
      res.status(400).json({ error: result.message });
      return;
    }
    const detail = await loadDetail(t.organizationId, id);
    res.status(201).json(detail);
  } catch (err) {
    next(err);
  }
});

// Receive finished goods. Increments dest warehouse; decrements vendor warehouse
// (consumed+scrap) per component. Per-component scrap → job_work_scrap write-off.
// Job charge accrues to suppliers.outstandingPayable (canonical payable in this codebase).
router.post("/job-work-orders/:id/receive", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const receivedDate =
      typeof b.receivedDate === "string" && b.receivedDate
        ? b.receivedDate
        : new Date().toISOString().slice(0, 10);
    if (!isValidIsoDate(receivedDate)) {
      res.status(400).json({ error: "receivedDate must be YYYY-MM-DD" });
      return;
    }
    const finishedQuantity = toNum(b.finishedQuantity);
    if (!(finishedQuantity > 0)) {
      res
        .status(400)
        .json({ error: "finishedQuantity must be greater than zero" });
      return;
    }
    const scrapQuantity = b.scrapQuantity === undefined
      ? 0
      : toNum(b.scrapQuantity);
    if (!(scrapQuantity >= 0)) {
      res
        .status(400)
        .json({ error: "scrapQuantity cannot be negative" });
      return;
    }
    const jobCharge =
      b.jobCharge === undefined || b.jobCharge === null
        ? -1
        : toNum(b.jobCharge);
    // jobCharge defaulting: if omitted, derive as finished * order.rate
    const notes =
      typeof b.notes === "string" && b.notes.trim()
        ? String(b.notes).trim()
        : null;

    type CompInput = {
      componentItemId: number;
      quantityConsumed: number;
      scrapQuantity: number;
    };
    const inputComps = Array.isArray(b.components) ? b.components : [];
    const userComps: CompInput[] = [];
    const seen = new Set<number>();
    for (const c of inputComps) {
      const cid = Number(c?.componentItemId);
      const qty = toNum(c?.quantityConsumed);
      const scrap =
        c?.scrapQuantity === undefined || c?.scrapQuantity === null
          ? 0
          : toNum(c?.scrapQuantity);
      if (!Number.isFinite(cid) || cid <= 0) {
        res.status(400).json({
          error: "Each component must include componentItemId",
        });
        return;
      }
      if (!(qty >= 0)) {
        res.status(400).json({
          error: "Each component quantityConsumed cannot be negative",
        });
        return;
      }
      if (!(scrap >= 0)) {
        res.status(400).json({
          error: "Each component scrapQuantity cannot be negative",
        });
        return;
      }
      if (seen.has(cid)) {
        res
          .status(400)
          .json({ error: "Duplicate componentItemId in components" });
        return;
      }
      seen.add(cid);
      userComps.push({
        componentItemId: cid,
        quantityConsumed: qty,
        scrapQuantity: scrap,
      });
    }

    const result = await db.transaction(async (tx) => {
      const orderRows = await tx
        .select()
        .from(jobWorkOrdersTable)
        .where(
          and(
            eq(jobWorkOrdersTable.id, id),
            eq(jobWorkOrdersTable.organizationId, t.organizationId),
          ),
        )
        .for("update")
        .limit(1);
      const order = orderRows[0];
      if (!order) return { kind: "notfound" as const };
      if (
        order.status !== STATUS_ISSUED &&
        order.status !== STATUS_PARTIAL
      ) {
        return {
          kind: "bad" as const,
          message: `Cannot receive when order is ${order.status}. Issue material first.`,
        };
      }

      // Don't allow receiving more than ordered (received + scrap).
      // Cancelled receipts are excluded — their quantities have been
      // reversed off the warehouse already.
      const priorReceipts = await tx
        .select({
          finishedQuantity: jobWorkReceiptsTable.finishedQuantity,
          scrapQuantity: jobWorkReceiptsTable.scrapQuantity,
          status: jobWorkReceiptsTable.status,
        })
        .from(jobWorkReceiptsTable)
        .where(
          and(
            eq(jobWorkReceiptsTable.organizationId, t.organizationId),
            eq(jobWorkReceiptsTable.jobWorkOrderId, id),
          ),
        );
      const priorAccountedFor = priorReceipts.reduce(
        (s, r) =>
          r.status === "cancelled"
            ? s
            : s + toNum(r.finishedQuantity) + toNum(r.scrapQuantity),
        0,
      );
      const ordered = toNum(order.outputQuantity);
      if (
        priorAccountedFor + finishedQuantity + scrapQuantity - ordered >
        1e-6
      ) {
        const remaining = Math.max(0, ordered - priorAccountedFor);
        return {
          kind: "bad" as const,
          message: `Total received + scrapped would exceed the ordered quantity. Remaining: ${remaining}.`,
        };
      }

      // Default unspecified components to (finished + headerScrap) *
      // BOM ratio for consumption, with zero per-component scrap.
      const orderComps = await tx
        .select()
        .from(jobWorkOrderComponentsTable)
        .where(
          and(
            eq(
              jobWorkOrderComponentsTable.organizationId,
              t.organizationId,
            ),
            eq(jobWorkOrderComponentsTable.jobWorkOrderId, id),
          ),
        );
      const orderCompMap = new Map(
        orderComps.map((c) => [c.componentItemId, c]),
      );
      const userMap = new Map(
        userComps.map((c) => [c.componentItemId, c]),
      );
      for (const u of userComps) {
        if (!orderCompMap.has(u.componentItemId)) {
          return {
            kind: "bad" as const,
            message: `Component ${u.componentItemId} is not part of this job-work order.`,
          };
        }
      }
      const resolvedComps: CompInput[] = orderComps.map((c) => {
        const override = userMap.get(c.componentItemId);
        if (override !== undefined) return override;
        return {
          componentItemId: c.componentItemId,
          quantityConsumed:
            toNum(c.quantityPerOutput) *
            (finishedQuantity + scrapQuantity),
          scrapQuantity: 0,
        };
      });

      // Lock + verify vendor warehouse has enough of every component
      // for the total deduction (consumed + per-component scrap).
      const totalDeductById = new Map<number, number>();
      for (const c of resolvedComps) {
        const total = c.quantityConsumed + c.scrapQuantity;
        if (total > 0) totalDeductById.set(c.componentItemId, total);
      }
      const consumeIds = Array.from(totalDeductById.keys());
      const itemRows = consumeIds.length
        ? await tx
            .select({
              id: itemsTable.id,
              name: itemsTable.name,
              sku: itemsTable.sku,
            })
            .from(itemsTable)
            .where(
              and(
                eq(itemsTable.organizationId, t.organizationId),
                inArray(itemsTable.id, consumeIds),
              ),
            )
        : [];
      const itemById = new Map(itemRows.map((r) => [r.id, r]));

      for (const [cid, total] of totalDeductById) {
        const stockRows = await tx
          .select({ quantity: itemWarehouseStockTable.quantity })
          .from(itemWarehouseStockTable)
          .where(
            and(
              eq(itemWarehouseStockTable.organizationId, t.organizationId),
              eq(itemWarehouseStockTable.itemId, cid),
              eq(
                itemWarehouseStockTable.warehouseId,
                order.vendorWarehouseId,
              ),
            ),
          )
          .for("update")
          .limit(1);
        const onHand = stockRows[0] ? toNum(stockRows[0].quantity) : 0;
        if (total - onHand > 1e-6) {
          const meta = itemById.get(cid);
          const label = meta ? `${meta.name} (${meta.sku})` : `item ${cid}`;
          return {
            kind: "bad" as const,
            message: `Insufficient material at job worker for ${label}: need ${total}, on hand ${onHand}.`,
          };
        }
      }

      const computedJobCharge =
        jobCharge >= 0
          ? jobCharge
          : toNum(order.jobChargeRate) * finishedQuantity;

      const receiptInsert = await tx
        .insert(jobWorkReceiptsTable)
        .values({
          organizationId: t.organizationId,
          jobWorkOrderId: id,
          receiptNumber: nextOrderNumber("JWR"),
          receivedDate,
          finishedQuantity: toStr(finishedQuantity),
          scrapQuantity: toStr(scrapQuantity),
          jobCharge: toStr(computedJobCharge),
          notes,
        })
        .returning({
          id: jobWorkReceiptsTable.id,
          receiptNumber: jobWorkReceiptsTable.receiptNumber,
        });
      const receipt = receiptInsert[0]!;

      await tx.insert(jobWorkReceiptComponentsTable).values(
        resolvedComps.map((c) => ({
          organizationId: t.organizationId,
          jobWorkReceiptId: receipt.id,
          componentItemId: c.componentItemId,
          quantityConsumed: toStr(c.quantityConsumed),
          scrapQuantity: toStr(c.scrapQuantity),
        })),
      );

      // Increment dest warehouse with finished output + write movement.
      await applyStockChange(
        tx,
        t.organizationId,
        order.outputItemId,
        order.destWarehouseId,
        finishedQuantity,
      );
      await tx.insert(stockMovementsTable).values({
        organizationId: t.organizationId,
        itemId: order.outputItemId,
        warehouseId: order.destWarehouseId,
        movementType: "job_work_receipt",
        quantity: toStr(finishedQuantity),
        referenceType: "job_work_receipt",
        referenceId: receipt.id,
        notes: `Received via ${receipt.receiptNumber} (${order.jwoNumber})`,
      });

      // Per component: one job_work_receipt for consumed, one job_work_scrap for scrap.
      for (const c of resolvedComps) {
        const total = c.quantityConsumed + c.scrapQuantity;
        if (total > 0) {
          await applyStockChange(
            tx,
            t.organizationId,
            c.componentItemId,
            order.vendorWarehouseId,
            -total,
          );
        }
        if (c.quantityConsumed > 0) {
          await tx.insert(stockMovementsTable).values({
            organizationId: t.organizationId,
            itemId: c.componentItemId,
            warehouseId: order.vendorWarehouseId,
            movementType: "job_work_receipt",
            quantity: toStr(-c.quantityConsumed),
            referenceType: "job_work_receipt",
            referenceId: receipt.id,
            notes: `Consumed at job worker via ${receipt.receiptNumber}`,
          });
        }
        if (c.scrapQuantity > 0) {
          await tx.insert(stockMovementsTable).values({
            organizationId: t.organizationId,
            itemId: c.componentItemId,
            warehouseId: order.vendorWarehouseId,
            movementType: "job_work_scrap",
            quantity: toStr(-c.scrapQuantity),
            referenceType: "job_work_receipt",
            referenceId: receipt.id,
            notes: `Component wastage at job worker via ${receipt.receiptNumber}`,
          });
        }
      }

      // Header-level scrap covers finished-good defects (units the
      // worker tried to produce but had to discard). Recorded as an
      // audit ledger row only — no stock cell to mutate because the
      // output never reached our warehouses.
      if (scrapQuantity > 0) {
        await tx.insert(stockMovementsTable).values({
          organizationId: t.organizationId,
          itemId: order.outputItemId,
          warehouseId: order.vendorWarehouseId,
          movementType: "job_work_scrap",
          quantity: toStr(-scrapQuantity),
          referenceType: "job_work_receipt",
          referenceId: receipt.id,
          notes: `Finished-good scrap reported via ${receipt.receiptNumber}`,
        });
      }

      // Job charge bumps supplier outstanding payable AND auto-creates
      // a "billed" purchase order so the charge flows through normal
      // supplier payments / payables aging.
      if (computedJobCharge > 0) {
        await tx
          .update(suppliersTable)
          .set({
            outstandingPayable: sql`${suppliersTable.outstandingPayable} + ${toStr(computedJobCharge)}`,
          })
          .where(
            and(
              eq(suppliersTable.id, order.supplierId),
              eq(suppliersTable.organizationId, t.organizationId),
            ),
          );

        const unitPrice =
          finishedQuantity > 0
            ? computedJobCharge / finishedQuantity
            : computedJobCharge;
        const totalStr = toStr(computedJobCharge);
        const poInsert = await tx
          .insert(purchaseOrdersTable)
          .values({
            organizationId: t.organizationId,
            orderNumber: nextOrderNumber("JWB"),
            supplierId: order.supplierId,
            warehouseId: order.destWarehouseId,
            status: "billed",
            orderDate: receivedDate,
            jobWorkReceiptId: receipt.id,
            subtotal: totalStr,
            taxTotal: "0",
            total: totalStr,
            amountPaid: "0",
            balanceDue: totalStr,
            notes: `Auto-created from ${receipt.receiptNumber} (${order.jwoNumber})`,
          })
          .returning({ id: purchaseOrdersTable.id });
        const poId = poInsert[0]!.id;
        await tx.insert(purchaseOrderLinesTable).values({
          purchaseOrderId: poId,
          itemId: order.outputItemId,
          quantity: toStr(finishedQuantity),
          quantityReceived: toStr(finishedQuantity),
          unitPrice: toStr(unitPrice),
          taxRate: "0",
          lineSubtotal: totalStr,
          lineTax: "0",
          lineTotal: totalStr,
        });
      }

      // Promote ISSUED → PARTIAL or → COMPLETED based on totals.
      await deriveAndUpdateOrderStatus(tx, t.organizationId, id);

      return { kind: "ok" as const };
    });

    if (result.kind === "notfound") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (result.kind === "bad") {
      res.status(400).json({ error: result.message });
      return;
    }
    const detail = await loadDetail(t.organizationId, id);
    res.status(201).json(detail);
  } catch (err) {
    next(err);
  }
});

// Cancel a job-work receipt: reverses the finished-goods stock at the
// destination warehouse, returns components to the vendor warehouse,
// reverses the supplier's outstanding payable, and deletes the
// auto-generated bill. Refuses if the bill already has supplier
// payments allocated against it (settle/refund those first). Marked
// soft-cancelled so the receipt number stays auditable.
router.post(
  "/job-work-orders/:id/receipts/:receiptId/cancel",
  async (req, res, next) => {
    try {
      const t = req.tenant!;
      const id = Number(req.params.id);
      const receiptId = Number(req.params.receiptId);
      if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ error: "id must be a positive integer" });
        return;
      }
      if (!Number.isFinite(receiptId) || receiptId <= 0) {
        res
          .status(400)
          .json({ error: "receiptId must be a positive integer" });
        return;
      }
      const result = await db.transaction(async (tx) => {
        const orderRows = await tx
          .select()
          .from(jobWorkOrdersTable)
          .where(
            and(
              eq(jobWorkOrdersTable.id, id),
              eq(jobWorkOrdersTable.organizationId, t.organizationId),
            ),
          )
          .for("update")
          .limit(1);
        const order = orderRows[0];
        if (!order) return { kind: "notfound" as const };

        const receiptRows = await tx
          .select()
          .from(jobWorkReceiptsTable)
          .where(
            and(
              eq(jobWorkReceiptsTable.id, receiptId),
              eq(jobWorkReceiptsTable.jobWorkOrderId, id),
              eq(jobWorkReceiptsTable.organizationId, t.organizationId),
            ),
          )
          .for("update")
          .limit(1);
        const receipt = receiptRows[0];
        if (!receipt) return { kind: "notfound" as const };
        if (receipt.status === "cancelled") {
          return {
            kind: "bad" as const,
            message: "Receipt is already cancelled.",
          };
        }

        // Refuse if any supplier payments have been allocated to the
        // auto-bill — the user must settle / refund those first.
        const billRows = await tx
          .select({ id: purchaseOrdersTable.id })
          .from(purchaseOrdersTable)
          .where(
            and(
              eq(purchaseOrdersTable.organizationId, t.organizationId),
              eq(purchaseOrdersTable.jobWorkReceiptId, receiptId),
            ),
          )
          .limit(1);
        const billId = billRows[0]?.id ?? null;
        if (billId !== null) {
          const allocs = await tx
            .select({ id: supplierPaymentAllocationsTable.id })
            .from(supplierPaymentAllocationsTable)
            .where(
              and(
                eq(
                  supplierPaymentAllocationsTable.organizationId,
                  t.organizationId,
                ),
                eq(supplierPaymentAllocationsTable.purchaseOrderId, billId),
              ),
            )
            .limit(1);
          if (allocs.length > 0) {
            return {
              kind: "bad" as const,
              message:
                "This receipt's bill has supplier payments applied. Reverse those payments before cancelling.",
            };
          }
        }

        const finishedQuantity = toNum(receipt.finishedQuantity);
        const scrapQuantity = toNum(receipt.scrapQuantity);
        const jobCharge = toNum(receipt.jobCharge);

        // Reverse finished-goods stock at the destination warehouse.
        if (finishedQuantity > 0) {
          await applyStockChange(
            tx,
            t.organizationId,
            order.outputItemId,
            order.destWarehouseId,
            -finishedQuantity,
          );
          await tx.insert(stockMovementsTable).values({
            organizationId: t.organizationId,
            itemId: order.outputItemId,
            warehouseId: order.destWarehouseId,
            movementType: "job_work_receipt_cancel",
            quantity: toStr(-finishedQuantity),
            referenceType: "job_work_receipt",
            referenceId: receipt.id,
            notes: `Cancelled receipt ${receipt.receiptNumber}`,
          });
        }

        // Return components back to the vendor warehouse.
        const compRows = await tx
          .select()
          .from(jobWorkReceiptComponentsTable)
          .where(
            and(
              eq(
                jobWorkReceiptComponentsTable.organizationId,
                t.organizationId,
              ),
              eq(
                jobWorkReceiptComponentsTable.jobWorkReceiptId,
                receipt.id,
              ),
            ),
          );
        for (const c of compRows) {
          const consumed = toNum(c.quantityConsumed);
          const compScrap = toNum(c.scrapQuantity);
          const total = consumed + compScrap;
          if (total > 0) {
            await applyStockChange(
              tx,
              t.organizationId,
              c.componentItemId,
              order.vendorWarehouseId,
              total,
            );
          }
          if (consumed > 0) {
            await tx.insert(stockMovementsTable).values({
              organizationId: t.organizationId,
              itemId: c.componentItemId,
              warehouseId: order.vendorWarehouseId,
              movementType: "job_work_receipt_cancel",
              quantity: toStr(consumed),
              referenceType: "job_work_receipt",
              referenceId: receipt.id,
              notes: `Reversed component consumption from ${receipt.receiptNumber}`,
            });
          }
          if (compScrap > 0) {
            await tx.insert(stockMovementsTable).values({
              organizationId: t.organizationId,
              itemId: c.componentItemId,
              warehouseId: order.vendorWarehouseId,
              movementType: "job_work_receipt_cancel",
              quantity: toStr(compScrap),
              referenceType: "job_work_receipt",
              referenceId: receipt.id,
              notes: `Reversed component scrap from ${receipt.receiptNumber}`,
            });
          }
        }

        // Audit ledger row to reverse header-level finished-good scrap.
        if (scrapQuantity > 0) {
          await tx.insert(stockMovementsTable).values({
            organizationId: t.organizationId,
            itemId: order.outputItemId,
            warehouseId: order.vendorWarehouseId,
            movementType: "job_work_receipt_cancel",
            quantity: toStr(scrapQuantity),
            referenceType: "job_work_receipt",
            referenceId: receipt.id,
            notes: `Reversed finished-good scrap from ${receipt.receiptNumber}`,
          });
        }

        // Reverse supplier payable + delete the auto-bill.
        if (jobCharge > 0) {
          await tx
            .update(suppliersTable)
            .set({
              outstandingPayable: sql`${suppliersTable.outstandingPayable} - ${toStr(jobCharge)}`,
            })
            .where(
              and(
                eq(suppliersTable.id, order.supplierId),
                eq(suppliersTable.organizationId, t.organizationId),
              ),
            );
        }
        if (billId !== null) {
          await tx
            .delete(purchaseOrdersTable)
            .where(
              and(
                eq(purchaseOrdersTable.id, billId),
                eq(purchaseOrdersTable.organizationId, t.organizationId),
              ),
            );
        }

        // Mark cancelled then re-derive JWO status (cancelled receipts
        // are excluded from totals so the order can drop back to PARTIAL
        // or ISSUED if needed).
        await tx
          .update(jobWorkReceiptsTable)
          .set({ status: "cancelled" })
          .where(
            and(
              eq(jobWorkReceiptsTable.id, receipt.id),
              eq(jobWorkReceiptsTable.organizationId, t.organizationId),
            ),
          );
        await deriveAndUpdateOrderStatus(tx, t.organizationId, id);

        return { kind: "ok" as const };
      });

      if (result.kind === "notfound") {
        res.status(404).json({ error: "Not found" });
        return;
      }
      if (result.kind === "bad") {
        res.status(400).json({ error: result.message });
        return;
      }
      const detail = await loadDetail(t.organizationId, id);
      res.json(detail);
    } catch (err) {
      next(err);
    }
  },
);

// ──────────────────────────────────────────────────────────────────
// REPORTS
// ──────────────────────────────────────────────────────────────────

// Stock currently at job workers — flat list of (supplier, virtual
// warehouse, item) rows where quantity > 0. Sorted by supplier then
// item for easy reading on a picker / printable list.
router.get("/reports/stock-with-job-workers", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const rows = await db
      .select({
        supplierId: warehousesTable.jobWorkerSupplierId,
        supplierName: suppliersTable.name,
        warehouseId: warehousesTable.id,
        warehouseName: warehousesTable.name,
        itemId: itemWarehouseStockTable.itemId,
        itemName: itemsTable.name,
        sku: itemsTable.sku,
        quantity: itemWarehouseStockTable.quantity,
      })
      .from(itemWarehouseStockTable)
      .innerJoin(
        warehousesTable,
        eq(warehousesTable.id, itemWarehouseStockTable.warehouseId),
      )
      .innerJoin(
        itemsTable,
        eq(itemsTable.id, itemWarehouseStockTable.itemId),
      )
      .innerJoin(
        suppliersTable,
        eq(suppliersTable.id, warehousesTable.jobWorkerSupplierId),
      )
      .where(
        and(
          eq(itemWarehouseStockTable.organizationId, t.organizationId),
          eq(warehousesTable.isVirtual, true),
          sql`${itemWarehouseStockTable.quantity} > 0`,
        ),
      )
      .orderBy(asc(suppliersTable.name), asc(itemsTable.name));
    res.json({
      rows: rows.map((r) => ({
        supplierId: r.supplierId,
        supplierName: r.supplierName,
        warehouseId: r.warehouseId,
        warehouseName: r.warehouseName,
        itemId: r.itemId,
        itemName: r.itemName,
        sku: r.sku,
        quantity: toNum(r.quantity),
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/reports/pending-job-work", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orders = await db
      .select({
        o: jobWorkOrdersTable,
        supplierName: suppliersTable.name,
        outputItemName: itemsTable.name,
        outputItemSku: itemsTable.sku,
      })
      .from(jobWorkOrdersTable)
      .innerJoin(
        suppliersTable,
        eq(suppliersTable.id, jobWorkOrdersTable.supplierId),
      )
      .innerJoin(
        itemsTable,
        eq(itemsTable.id, jobWorkOrdersTable.outputItemId),
      )
      .where(
        and(
          eq(jobWorkOrdersTable.organizationId, t.organizationId),
          inArray(jobWorkOrdersTable.status, [STATUS_ISSUED, STATUS_PARTIAL]),
        ),
      )
      .orderBy(asc(jobWorkOrdersTable.expectedReturnDate));
    const orderIds = orders.map((r) => r.o.id);
    const receipts = orderIds.length
      ? await db
          .select({
            jobWorkOrderId: jobWorkReceiptsTable.jobWorkOrderId,
            finishedQuantity: jobWorkReceiptsTable.finishedQuantity,
            scrapQuantity: jobWorkReceiptsTable.scrapQuantity,
          })
          .from(jobWorkReceiptsTable)
          .where(
            and(
              eq(jobWorkReceiptsTable.organizationId, t.organizationId),
              inArray(jobWorkReceiptsTable.jobWorkOrderId, orderIds),
              ne(jobWorkReceiptsTable.status, "cancelled"),
            ),
          )
      : [];
    const totalsByOrder = new Map<
      number,
      { finished: number; scrapped: number }
    >();
    for (const r of receipts) {
      const cur = totalsByOrder.get(r.jobWorkOrderId) ?? {
        finished: 0,
        scrapped: 0,
      };
      cur.finished += toNum(r.finishedQuantity);
      cur.scrapped += toNum(r.scrapQuantity);
      totalsByOrder.set(r.jobWorkOrderId, cur);
    }
    // Per-JWO components-still-with-vendor: sum(issued) − sum(consumed+scrap).
    const issuedByOrder = new Map<number, number>();
    if (orderIds.length) {
      const issuedRows = await db
        .select({
          jobWorkOrderId: jobWorkIssuesTable.jobWorkOrderId,
          quantity: jobWorkIssueLinesTable.quantity,
        })
        .from(jobWorkIssueLinesTable)
        .innerJoin(
          jobWorkIssuesTable,
          eq(jobWorkIssuesTable.id, jobWorkIssueLinesTable.jobWorkIssueId),
        )
        .where(
          and(
            eq(jobWorkIssueLinesTable.organizationId, t.organizationId),
            eq(jobWorkIssuesTable.organizationId, t.organizationId),
            inArray(jobWorkIssuesTable.jobWorkOrderId, orderIds),
          ),
        );
      for (const r of issuedRows) {
        issuedByOrder.set(
          r.jobWorkOrderId,
          (issuedByOrder.get(r.jobWorkOrderId) ?? 0) + toNum(r.quantity),
        );
      }
    }
    const consumedByOrder = new Map<number, number>();
    if (orderIds.length) {
      const consumedRows = await db
        .select({
          jobWorkOrderId: jobWorkReceiptsTable.jobWorkOrderId,
          quantityConsumed: jobWorkReceiptComponentsTable.quantityConsumed,
          scrapQuantity: jobWorkReceiptComponentsTable.scrapQuantity,
        })
        .from(jobWorkReceiptComponentsTable)
        .innerJoin(
          jobWorkReceiptsTable,
          eq(
            jobWorkReceiptsTable.id,
            jobWorkReceiptComponentsTable.jobWorkReceiptId,
          ),
        )
        .where(
          and(
            eq(jobWorkReceiptComponentsTable.organizationId, t.organizationId),
            eq(jobWorkReceiptsTable.organizationId, t.organizationId),
            inArray(jobWorkReceiptsTable.jobWorkOrderId, orderIds),
            ne(jobWorkReceiptsTable.status, "cancelled"),
          ),
        );
      for (const r of consumedRows) {
        consumedByOrder.set(
          r.jobWorkOrderId,
          (consumedByOrder.get(r.jobWorkOrderId) ?? 0) +
            toNum(r.quantityConsumed) +
            toNum(r.scrapQuantity),
        );
      }
    }
    res.json({
      rows: orders.map((row) => {
        const t = totalsByOrder.get(row.o.id) ?? {
          finished: 0,
          scrapped: 0,
        };
        const ordered = toNum(row.o.outputQuantity);
        const remaining = Math.max(0, ordered - t.finished - t.scrapped);
        const issued = issuedByOrder.get(row.o.id) ?? 0;
        const consumed = consumedByOrder.get(row.o.id) ?? 0;
        const componentsAtVendor = Math.max(0, issued - consumed);
        return {
          jobWorkOrderId: row.o.id,
          jwoNumber: row.o.jwoNumber,
          supplierId: row.o.supplierId,
          supplierName: row.supplierName,
          outputItemId: row.o.outputItemId,
          outputItemName: row.outputItemName,
          outputItemSku: row.outputItemSku,
          orderedQuantity: ordered,
          receivedQuantity: t.finished,
          scrappedQuantity: t.scrapped,
          remainingQuantity: remaining,
          componentsAtVendorTotal: componentsAtVendor,
          expectedReturnDate: row.o.expectedReturnDate ?? null,
          status: row.o.status,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
