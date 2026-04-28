import { Router, type IRouter } from "express";
import { and, desc, eq, gte, gt, lte, sql } from "drizzle-orm";
import {
  db,
  itemsTable,
  itemWarehouseStockTable,
  itemBatchesTable,
  itemBatchWarehouseStockTable,
  warehousesTable,
  salesOrdersTable,
  purchaseOrdersTable,
  customersTable,
  suppliersTable,
} from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import { toNum } from "../lib/numeric";
import {
  parsePeriod,
  computeGstr1,
  computeGstr3b,
  computeHsnSummary,
  gstr1ToCsv,
  gstr3bToCsv,
  hsnSummaryToCsv,
  gstr1ToGstnJson,
  gstr3bToGstnJson,
  hsnSummaryToGstnJson,
} from "../lib/gstReports";
import { buildTallyXml } from "../lib/tallyExport";

const router: IRouter = Router();
router.use(tenantMiddleware);

// Format negotiation for the GSTR endpoints. We default to "json" so a
// vanilla call returns a UI-friendly preview shape; "csv" emits the
// per-section spreadsheet, and "gstn" emits the JSON envelope that
// matches the GSTN offline-tool schema.
type GstrFormat = "json" | "csv" | "gstn";
function parseFormat(v: unknown): GstrFormat {
  if (v === "csv") return "csv";
  if (v === "gstn") return "gstn";
  return "json";
}

function setDownloadHeaders(
  res: import("express").Response,
  filename: string,
  contentType: string,
): void {
  res.setHeader("Content-Type", contentType);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`,
  );
}

router.get("/reports/gstr-1", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const period = parsePeriod(
      typeof req.query.period === "string" ? req.query.period : undefined,
    );
    const format = parseFormat(req.query.format);
    const report = await computeGstr1(t.organizationId, period);
    if (format === "csv") {
      setDownloadHeaders(res, `gstr1-${period.period}.csv`, "text/csv; charset=utf-8");
      res.send(gstr1ToCsv(report));
      return;
    }
    if (format === "gstn") {
      setDownloadHeaders(
        res,
        `gstr1-${period.period}.json`,
        "application/json",
      );
      res.send(JSON.stringify(gstr1ToGstnJson(report), null, 2));
      return;
    }
    res.json(report);
  } catch (err) {
    if (isPeriodValidationError(err)) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

router.get("/reports/gstr-3b", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const period = parsePeriod(
      typeof req.query.period === "string" ? req.query.period : undefined,
    );
    const format = parseFormat(req.query.format);
    const report = await computeGstr3b(t.organizationId, period);
    if (format === "csv") {
      setDownloadHeaders(res, `gstr3b-${period.period}.csv`, "text/csv; charset=utf-8");
      res.send(gstr3bToCsv(report));
      return;
    }
    if (format === "gstn") {
      setDownloadHeaders(
        res,
        `gstr3b-${period.period}.json`,
        "application/json",
      );
      res.send(JSON.stringify(gstr3bToGstnJson(report), null, 2));
      return;
    }
    res.json(report);
  } catch (err) {
    if (isPeriodValidationError(err)) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

router.get("/reports/hsn-summary", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const period = parsePeriod(
      typeof req.query.period === "string" ? req.query.period : undefined,
    );
    const format = parseFormat(req.query.format);
    const report = await computeHsnSummary(t.organizationId, period);
    if (format === "csv") {
      setDownloadHeaders(
        res,
        `hsn-summary-${period.period}.csv`,
        "text/csv; charset=utf-8",
      );
      res.send(hsnSummaryToCsv(report));
      return;
    }
    if (format === "gstn") {
      setDownloadHeaders(
        res,
        `hsn-summary-${period.period}.json`,
        "application/json",
      );
      res.send(JSON.stringify(hsnSummaryToGstnJson(report), null, 2));
      return;
    }
    res.json(report);
  } catch (err) {
    if (isPeriodValidationError(err)) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// parsePeriod can throw with messages prefixed by "period" or "month";
// both are user input errors that should map to HTTP 400.
function isPeriodValidationError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  return /^(period|month|quarter)\b/.test(err.message);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
router.get("/reports/tally-export", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const from = typeof req.query.from === "string" ? req.query.from : "";
    const to = typeof req.query.to === "string" ? req.query.to : "";
    if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to)) {
      res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
      return;
    }
    if (from > to) {
      res.status(400).json({ error: "from must be on or before to" });
      return;
    }
    const includeRaw =
      typeof req.query.include === "string"
        ? req.query.include.split(",").map((s) => s.trim())
        : ["sales", "receipts", "purchases", "payments"];
    const include = {
      sales: includeRaw.includes("sales"),
      receipts: includeRaw.includes("receipts"),
      purchases: includeRaw.includes("purchases"),
      payments: includeRaw.includes("payments"),
    };
    if (!include.sales && !include.receipts && !include.purchases && !include.payments) {
      res.status(400).json({ error: "include must contain at least one voucher type" });
      return;
    }
    const xml = await buildTallyXml(t.organizationId, {
      fromDate: from,
      toDate: to,
      include,
    });
    setDownloadHeaders(
      res,
      `tally-${from}_to_${to}.xml`,
      "application/xml; charset=utf-8",
    );
    res.send(xml);
  } catch (err) {
    next(err);
  }
});

router.get("/reports/inventory-valuation", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const showBatches = req.query.showBatches === "true";

    // Item-level rolled-up rows. When showBatches is on we still emit a
    // row for every untracked item (so the report stays complete) and
    // skip tracked items because they are expanded per-batch below.
    const itemRows = await db
      .select({
        itemId: itemsTable.id,
        sku: itemsTable.sku,
        name: itemsTable.name,
        unitCost: itemsTable.purchasePrice,
        trackBatches: itemsTable.trackBatches,
        quantityOnHand: sql<string>`COALESCE(SUM(${itemWarehouseStockTable.quantity}), 0)`,
      })
      .from(itemsTable)
      .leftJoin(
        itemWarehouseStockTable,
        eq(itemWarehouseStockTable.itemId, itemsTable.id),
      )
      .where(
        and(
          eq(itemsTable.organizationId, t.organizationId),
          // Inventory valuation is a working-set view — exclude
          // archived items so their residual stock value doesn't
          // skew totals.
          sql`${itemsTable.archivedAt} IS NULL`,
        ),
      )
      .groupBy(
        itemsTable.id,
        itemsTable.sku,
        itemsTable.name,
        itemsTable.purchasePrice,
        itemsTable.trackBatches,
      );

    const result: Array<{
      itemId: number;
      sku: string;
      name: string;
      quantityOnHand: number;
      unitCost: number;
      totalValue: number;
      isBatch: boolean;
      itemBatchId: number | null;
      batchNumber: string | null;
      mfgDate: string | null;
      expiryDate: string | null;
    }> = [];

    for (const r of itemRows) {
      if (showBatches && r.trackBatches) continue;
      const qty = toNum(r.quantityOnHand);
      const cost = toNum(r.unitCost);
      result.push({
        itemId: r.itemId,
        sku: r.sku,
        name: r.name,
        quantityOnHand: qty,
        unitCost: cost,
        totalValue: qty * cost,
        isBatch: false,
        itemBatchId: null,
        batchNumber: null,
        mfgDate: null,
        expiryDate: null,
      });
    }

    if (showBatches) {
      // Per-batch rows for tracked items. Cost falls back to the
      // item's purchasePrice when the batch was captured without one.
      const batchRows = await db
        .select({
          itemId: itemsTable.id,
          sku: itemsTable.sku,
          name: itemsTable.name,
          itemUnitCost: itemsTable.purchasePrice,
          itemBatchId: itemBatchesTable.id,
          batchNumber: itemBatchesTable.batchNumber,
          mfgDate: itemBatchesTable.mfgDate,
          expiryDate: itemBatchesTable.expiryDate,
          batchCost: itemBatchesTable.costPrice,
          quantityOnHand: sql<string>`COALESCE(SUM(${itemBatchWarehouseStockTable.quantity}), 0)`,
        })
        .from(itemBatchesTable)
        .innerJoin(itemsTable, eq(itemsTable.id, itemBatchesTable.itemId))
        .leftJoin(
          itemBatchWarehouseStockTable,
          eq(
            itemBatchWarehouseStockTable.itemBatchId,
            itemBatchesTable.id,
          ),
        )
        .where(
          and(
            eq(itemBatchesTable.organizationId, t.organizationId),
            eq(itemsTable.trackBatches, true),
            // Skip batches under archived items in valuation.
            sql`${itemsTable.archivedAt} IS NULL`,
          ),
        )
        .groupBy(
          itemsTable.id,
          itemsTable.sku,
          itemsTable.name,
          itemsTable.purchasePrice,
          itemBatchesTable.id,
          itemBatchesTable.batchNumber,
          itemBatchesTable.mfgDate,
          itemBatchesTable.expiryDate,
          itemBatchesTable.costPrice,
        );

      for (const r of batchRows) {
        const qty = toNum(r.quantityOnHand);
        const cost =
          r.batchCost != null ? toNum(r.batchCost) : toNum(r.itemUnitCost);
        result.push({
          itemId: r.itemId,
          sku: r.sku,
          name: r.name,
          quantityOnHand: qty,
          unitCost: cost,
          totalValue: qty * cost,
          isBatch: true,
          itemBatchId: r.itemBatchId,
          batchNumber: r.batchNumber,
          mfgDate: r.mfgDate ?? null,
          expiryDate: r.expiryDate ?? null,
        });
      }
    }

    // Stable display order: by item name, then batch expiry asc nulls
    // last, then batch number.
    result.sort((a, b) => {
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      if (a.isBatch !== b.isBatch) return a.isBatch ? 1 : -1;
      const aExp = a.expiryDate ?? "9999-12-31";
      const bExp = b.expiryDate ?? "9999-12-31";
      if (aExp !== bExp) return aExp.localeCompare(bExp);
      return (a.batchNumber ?? "").localeCompare(b.batchNumber ?? "");
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/reports/low-stock", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const rows = await db
      .select({
        itemId: itemsTable.id,
        sku: itemsTable.sku,
        name: itemsTable.name,
        reorderLevel: itemsTable.reorderLevel,
        quantityOnHand: sql<string>`COALESCE(SUM(${itemWarehouseStockTable.quantity}), 0)`,
      })
      .from(itemsTable)
      .leftJoin(
        itemWarehouseStockTable,
        eq(itemWarehouseStockTable.itemId, itemsTable.id),
      )
      .where(
        and(
          eq(itemsTable.organizationId, t.organizationId),
          // Archived items shouldn't trigger low-stock alerts.
          sql`${itemsTable.archivedAt} IS NULL`,
        ),
      )
      .groupBy(itemsTable.id, itemsTable.sku, itemsTable.name, itemsTable.reorderLevel);
    const filtered = rows
      .map((r) => {
        const qty = toNum(r.quantityOnHand);
        const reorder = toNum(r.reorderLevel);
        return {
          itemId: r.itemId,
          sku: r.sku,
          name: r.name,
          quantityOnHand: qty,
          reorderLevel: reorder,
          deficit: Math.max(0, reorder - qty),
        };
      })
      .filter((r) => r.reorderLevel > 0 && r.quantityOnHand <= r.reorderLevel);
    res.json(filtered);
  } catch (err) {
    next(err);
  }
});

function trend30Days(
  daily: Array<{ d: string; s: string }>,
): Array<{ date: string; sales: number; purchases: number }> {
  const map = new Map<string, number>();
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    map.set(d.toISOString().slice(0, 10), 0);
  }
  for (const row of daily) {
    if (map.has(row.d)) map.set(row.d, toNum(row.s));
  }
  return Array.from(map.entries()).map(([date, v]) => ({
    date,
    sales: v,
    purchases: 0,
  }));
}

router.get("/reports/sales-summary", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orgId = t.organizationId;
    const totalsRow = await db
      .select({
        total: sql<string>`COALESCE(SUM(${salesOrdersTable.total}), 0)`,
        count: sql<string>`COUNT(*)`,
      })
      .from(salesOrdersTable)
      .where(eq(salesOrdersTable.organizationId, orgId));
    const totalSales = toNum(totalsRow[0]?.total);
    const orderCount = Number(totalsRow[0]?.count ?? 0);

    const byCustomerRows = await db
      .select({
        customerId: customersTable.id,
        customerName: customersTable.name,
        orderCount: sql<string>`COUNT(${salesOrdersTable.id})`,
        total: sql<string>`COALESCE(SUM(${salesOrdersTable.total}), 0)`,
      })
      .from(salesOrdersTable)
      .innerJoin(customersTable, eq(customersTable.id, salesOrdersTable.customerId))
      .where(eq(salesOrdersTable.organizationId, orgId))
      .groupBy(customersTable.id, customersTable.name)
      .orderBy(desc(sql`SUM(${salesOrdersTable.total})`))
      .limit(20);

    const since = new Date();
    since.setDate(since.getDate() - 29);
    const sinceISO = since.toISOString().slice(0, 10);
    const dailyRows = await db
      .select({
        d: salesOrdersTable.orderDate,
        s: sql<string>`COALESCE(SUM(${salesOrdersTable.total}), 0)`,
      })
      .from(salesOrdersTable)
      .where(
        and(
          eq(salesOrdersTable.organizationId, orgId),
          gte(salesOrdersTable.orderDate, sinceISO),
        ),
      )
      .groupBy(salesOrdersTable.orderDate);

    res.json({
      totalSales,
      orderCount,
      averageOrderValue: orderCount > 0 ? totalSales / orderCount : 0,
      byCustomer: byCustomerRows.map((r) => ({
        customerId: r.customerId,
        customerName: r.customerName,
        orderCount: Number(r.orderCount),
        total: toNum(r.total),
      })),
      trend: trend30Days(dailyRows),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/reports/receivables-aging", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orgId = t.organizationId;
    const rows = await db
      .select({
        customerId: customersTable.id,
        customerName: customersTable.name,
        orderId: salesOrdersTable.id,
        orderDate: salesOrdersTable.orderDate,
        balanceDue: salesOrdersTable.balanceDue,
      })
      .from(salesOrdersTable)
      .innerJoin(
        customersTable,
        eq(customersTable.id, salesOrdersTable.customerId),
      )
      .where(
        and(
          eq(salesOrdersTable.organizationId, orgId),
          sql`${salesOrdersTable.balanceDue} > 0`,
          sql`${salesOrdersTable.status} IN ('confirmed', 'shipped', 'delivered', 'invoiced')`,
        ),
      );

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    type Bucket = {
      customerId: number;
      customerName: string;
      current: number;
      b30: number;
      b60: number;
      b90: number;
      b90plus: number;
      total: number;
    };
    const byCustomer = new Map<number, Bucket>();
    for (const r of rows) {
      const due = toNum(r.balanceDue);
      if (due <= 0) continue;
      const orderDate = new Date(r.orderDate);
      const ageDays = Math.floor(
        (today.getTime() - orderDate.getTime()) / (1000 * 60 * 60 * 24),
      );
      const existing = byCustomer.get(r.customerId) ?? {
        customerId: r.customerId,
        customerName: r.customerName,
        current: 0,
        b30: 0,
        b60: 0,
        b90: 0,
        b90plus: 0,
        total: 0,
      };
      if (ageDays <= 0) existing.current += due;
      else if (ageDays <= 30) existing.b30 += due;
      else if (ageDays <= 60) existing.b60 += due;
      else if (ageDays <= 90) existing.b90 += due;
      else existing.b90plus += due;
      existing.total += due;
      byCustomer.set(r.customerId, existing);
    }

    const list = Array.from(byCustomer.values()).sort(
      (a, b) => b.total - a.total,
    );
    const totals = list.reduce(
      (acc, c) => {
        acc.current += c.current;
        acc.b30 += c.b30;
        acc.b60 += c.b60;
        acc.b90 += c.b90;
        acc.b90plus += c.b90plus;
        acc.total += c.total;
        return acc;
      },
      { current: 0, b30: 0, b60: 0, b90: 0, b90plus: 0, total: 0 },
    );

    res.json({ rows: list, totals });
  } catch (err) {
    next(err);
  }
});

router.get("/reports/payables-aging", async (_req, res, next) => {
  try {
    const t = _req.tenant!;
    const orgId = t.organizationId;
    const rows = await db
      .select({
        supplierId: suppliersTable.id,
        supplierName: suppliersTable.name,
        orderId: purchaseOrdersTable.id,
        orderDate: purchaseOrdersTable.orderDate,
        balanceDue: purchaseOrdersTable.balanceDue,
      })
      .from(purchaseOrdersTable)
      .innerJoin(
        suppliersTable,
        eq(suppliersTable.id, purchaseOrdersTable.supplierId),
      )
      .where(
        and(
          eq(purchaseOrdersTable.organizationId, orgId),
          sql`${purchaseOrdersTable.balanceDue} > 0`,
          sql`${purchaseOrdersTable.status} IN ('ordered', 'partially_received', 'received', 'billed')`,
        ),
      );

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    type Bucket = {
      supplierId: number;
      supplierName: string;
      current: number;
      b30: number;
      b60: number;
      b90: number;
      b90plus: number;
      total: number;
    };
    const bySupplier = new Map<number, Bucket>();
    for (const r of rows) {
      const due = toNum(r.balanceDue);
      if (due <= 0) continue;
      const orderDate = new Date(r.orderDate);
      const ageDays = Math.floor(
        (today.getTime() - orderDate.getTime()) / (1000 * 60 * 60 * 24),
      );
      const existing = bySupplier.get(r.supplierId) ?? {
        supplierId: r.supplierId,
        supplierName: r.supplierName,
        current: 0,
        b30: 0,
        b60: 0,
        b90: 0,
        b90plus: 0,
        total: 0,
      };
      if (ageDays <= 0) existing.current += due;
      else if (ageDays <= 30) existing.b30 += due;
      else if (ageDays <= 60) existing.b60 += due;
      else if (ageDays <= 90) existing.b90 += due;
      else existing.b90plus += due;
      existing.total += due;
      bySupplier.set(r.supplierId, existing);
    }

    const list = Array.from(bySupplier.values()).sort(
      (a, b) => b.total - a.total,
    );
    const totals = list.reduce(
      (acc, c) => {
        acc.current += c.current;
        acc.b30 += c.b30;
        acc.b60 += c.b60;
        acc.b90 += c.b90;
        acc.b90plus += c.b90plus;
        acc.total += c.total;
        return acc;
      },
      { current: 0, b30: 0, b60: 0, b90: 0, b90plus: 0, total: 0 },
    );

    res.json({ rows: list, totals });
  } catch (err) {
    next(err);
  }
});

router.get("/reports/purchase-summary", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orgId = t.organizationId;
    const totalsRow = await db
      .select({
        total: sql<string>`COALESCE(SUM(${purchaseOrdersTable.total}), 0)`,
        count: sql<string>`COUNT(*)`,
      })
      .from(purchaseOrdersTable)
      .where(eq(purchaseOrdersTable.organizationId, orgId));
    const totalPurchases = toNum(totalsRow[0]?.total);
    const orderCount = Number(totalsRow[0]?.count ?? 0);

    const bySupplierRows = await db
      .select({
        supplierId: suppliersTable.id,
        supplierName: suppliersTable.name,
        orderCount: sql<string>`COUNT(${purchaseOrdersTable.id})`,
        total: sql<string>`COALESCE(SUM(${purchaseOrdersTable.total}), 0)`,
      })
      .from(purchaseOrdersTable)
      .innerJoin(suppliersTable, eq(suppliersTable.id, purchaseOrdersTable.supplierId))
      .where(eq(purchaseOrdersTable.organizationId, orgId))
      .groupBy(suppliersTable.id, suppliersTable.name)
      .orderBy(desc(sql`SUM(${purchaseOrdersTable.total})`))
      .limit(20);

    const since = new Date();
    since.setDate(since.getDate() - 29);
    const sinceISO = since.toISOString().slice(0, 10);
    const dailyRows = await db
      .select({
        d: purchaseOrdersTable.orderDate,
        s: sql<string>`COALESCE(SUM(${purchaseOrdersTable.total}), 0)`,
      })
      .from(purchaseOrdersTable)
      .where(
        and(
          eq(purchaseOrdersTable.organizationId, orgId),
          gte(purchaseOrdersTable.orderDate, sinceISO),
        ),
      )
      .groupBy(purchaseOrdersTable.orderDate);

    res.json({
      totalPurchases,
      orderCount,
      averageOrderValue: orderCount > 0 ? totalPurchases / orderCount : 0,
      bySupplier: bySupplierRows.map((r) => ({
        supplierId: r.supplierId,
        supplierName: r.supplierName,
        orderCount: Number(r.orderCount),
        total: toNum(r.total),
      })),
      trend: trend30Days(dailyRows),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/reports/batches-near-expiry", async (req, res, next) => {
  try {
    const t = req.tenant!;
    let days = 30;
    if (req.query.days !== undefined && req.query.days !== "") {
      const n = Number(req.query.days);
      if (!Number.isFinite(n) || n < 0 || n > 3650) {
        res.status(400).json({
          error: "days must be a non-negative number no greater than 3650",
        });
        return;
      }
      days = Math.floor(n);
    }
    let itemId: number | undefined;
    if (req.query.itemId !== undefined && req.query.itemId !== "") {
      const n = Number(req.query.itemId);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        res.status(400).json({
          error: "itemId must be a positive integer",
        });
        return;
      }
      itemId = n;
    }
    let warehouseId: number | undefined;
    if (
      req.query.warehouseId !== undefined &&
      req.query.warehouseId !== ""
    ) {
      const n = Number(req.query.warehouseId);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        res.status(400).json({
          error: "warehouseId must be a positive integer",
        });
        return;
      }
      warehouseId = n;
    }

    const today = new Date();
    const todayIso = today.toISOString().slice(0, 10);
    const cutoffDate = new Date(today);
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() + days);
    const cutoffIso = cutoffDate.toISOString().slice(0, 10);

    const conds = [
      eq(itemBatchesTable.organizationId, t.organizationId),
      // Only batches that actually have an expiry date.
      sql`${itemBatchesTable.expiryDate} IS NOT NULL`,
      // expiryDate <= cutoff (within window OR already expired).
      lte(itemBatchesTable.expiryDate, cutoffIso),
      // Skip lots that have no remaining stock.
      gt(itemBatchWarehouseStockTable.quantity, "0"),
    ];
    if (itemId !== undefined) {
      conds.push(eq(itemBatchesTable.itemId, itemId));
    }
    if (warehouseId !== undefined) {
      conds.push(eq(itemBatchWarehouseStockTable.warehouseId, warehouseId));
    }

    const rows = await db
      .select({
        itemBatchId: itemBatchesTable.id,
        batchNumber: itemBatchesTable.batchNumber,
        mfgDate: itemBatchesTable.mfgDate,
        expiryDate: itemBatchesTable.expiryDate,
        itemId: itemsTable.id,
        sku: itemsTable.sku,
        itemName: itemsTable.name,
        warehouseId: warehousesTable.id,
        warehouseName: warehousesTable.name,
        quantity: itemBatchWarehouseStockTable.quantity,
      })
      .from(itemBatchesTable)
      .innerJoin(
        itemBatchWarehouseStockTable,
        eq(itemBatchWarehouseStockTable.itemBatchId, itemBatchesTable.id),
      )
      .innerJoin(itemsTable, eq(itemsTable.id, itemBatchesTable.itemId))
      .innerJoin(
        warehousesTable,
        eq(warehousesTable.id, itemBatchWarehouseStockTable.warehouseId),
      )
      .where(
        and(
          // Don't surface near-expiry alerts for archived items.
          sql`${itemsTable.archivedAt} IS NULL`,
          ...conds,
        ),
      )
      .orderBy(
        sql`${itemBatchesTable.expiryDate} ASC`,
        itemsTable.name,
        warehousesTable.name,
      );

    const out = rows.map((r) => {
      const expiry = r.expiryDate as string;
      const expiryDate = new Date(`${expiry}T00:00:00Z`);
      const todayDate = new Date(`${todayIso}T00:00:00Z`);
      const daysUntilExpiry = Math.round(
        (expiryDate.getTime() - todayDate.getTime()) / (24 * 60 * 60 * 1000),
      );
      return {
        itemBatchId: r.itemBatchId,
        batchNumber: r.batchNumber,
        mfgDate: r.mfgDate,
        expiryDate: expiry,
        daysUntilExpiry,
        expired: daysUntilExpiry < 0,
        itemId: r.itemId,
        sku: r.sku,
        itemName: r.itemName,
        warehouseId: r.warehouseId,
        warehouseName: r.warehouseName,
        quantity: toNum(r.quantity),
      };
    });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

export default router;
