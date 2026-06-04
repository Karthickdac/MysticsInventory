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
  salesOrderLinesTable,
  purchaseOrdersTable,
  customersTable,
  suppliersTable,
  shipmentsTable,
  shipmentLinesTable,
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
    const filterWarehouseId = req.query.warehouseId ? Number(req.query.warehouseId) : undefined;
    const filterItemId = req.query.itemId ? Number(req.query.itemId) : undefined;
    const filterSearch = typeof req.query.search === "string" ? req.query.search.trim().toLowerCase() : undefined;

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
        filterWarehouseId
          ? and(
              eq(itemWarehouseStockTable.itemId, itemsTable.id),
              eq(itemWarehouseStockTable.warehouseId, filterWarehouseId),
            )
          : eq(itemWarehouseStockTable.itemId, itemsTable.id),
      )
      .where(
        and(
          eq(itemsTable.organizationId, t.organizationId),
          // Inventory valuation is a working-set view — exclude
          // archived items so their residual stock value doesn't
          // skew totals.
          sql`${itemsTable.archivedAt} IS NULL`,
          filterItemId ? eq(itemsTable.id, filterItemId) : undefined,
          filterSearch
            ? sql`(LOWER(${itemsTable.name}) LIKE ${`%${filterSearch}%`} OR LOWER(${itemsTable.sku}) LIKE ${`%${filterSearch}%`})`
            : undefined,
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
    const filterWarehouseId = req.query.warehouseId ? Number(req.query.warehouseId) : undefined;
    const filterSearch = typeof req.query.search === "string" ? req.query.search.trim().toLowerCase() : undefined;
    // Cross-join items × non-virtual warehouses so items with zero stock
    // (no row in item_warehouse_stock) still appear per warehouse.
    const rawRows = await db.execute(sql`
      SELECT
        i.id                                        AS "itemId",
        i.sku                                       AS sku,
        i.name                                      AS name,
        i.barcode                                   AS barcode,
        i.reorder_level                             AS "reorderLevel",
        w.id                                        AS "warehouseId",
        w.name                                      AS "warehouseName",
        COALESCE(iws.quantity, 0)                   AS "quantityOnHand"
      FROM items i
      CROSS JOIN warehouses w
      LEFT JOIN item_warehouse_stock iws
        ON  iws.item_id         = i.id
        AND iws.warehouse_id    = w.id
        AND iws.organization_id = ${t.organizationId}
      WHERE i.organization_id = ${t.organizationId}
        AND i.archived_at IS NULL
        AND i.reorder_level IS NOT NULL
        AND i.reorder_level::numeric > 0
        AND w.organization_id = ${t.organizationId}
        AND w.is_virtual = false
        ${filterWarehouseId ? sql`AND w.id = ${filterWarehouseId}` : sql``}
        ${filterSearch ? sql`AND (LOWER(i.name) LIKE ${`%${filterSearch}%`} OR LOWER(i.sku) LIKE ${`%${filterSearch}%`})` : sql``}
        AND COALESCE(iws.quantity::numeric, 0) <= i.reorder_level::numeric
      ORDER BY i.name, w.name
    `); // org-scope-allow: items, warehouses, item_warehouse_stock all constrained by organization_id
    const filtered = rawRows.rows.map((r) => {
      const qty = toNum(r["quantityOnHand"] as string);
      const reorder = toNum(r["reorderLevel"] as string);
      return {
        itemId: Number(r["itemId"]),
        sku: String(r["sku"]),
        name: String(r["name"]),
        barcode: r["barcode"] != null ? String(r["barcode"]) : null,
        warehouseId: Number(r["warehouseId"]),
        warehouseName: String(r["warehouseName"]),
        quantityOnHand: qty,
        reorderLevel: reorder,
        deficit: Math.max(0, reorder - qty),
      };
    });
    res.json(filtered);
  } catch (err) {
    next(err);
  }
});

// Build a per-day trend series. When the caller passes Feature-5
// `from`/`to` filters the window honors them; otherwise it falls back
// to the trailing 30 days from today (the legacy behavior so existing
// callers don't shift). The returned `purchases` field is always 0 —
// kept for backward shape compatibility with the existing chart.
function trendForRange(
  daily: Array<{ d: string; s: string }>,
  from?: string,
  to?: string,
): Array<{ date: string; sales: number; purchases: number }> {
  const isoDay = /^\d{4}-\d{2}-\d{2}$/;
  let startStr: string;
  let endStr: string;
  if (from && to && isoDay.test(from) && isoDay.test(to) && from <= to) {
    startStr = from;
    endStr = to;
  } else {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 29);
    startStr = start.toISOString().slice(0, 10);
    endStr = end.toISOString().slice(0, 10);
  }
  const map = new Map<string, number>();
  const cur = new Date(`${startStr}T00:00:00Z`);
  const end = new Date(`${endStr}T00:00:00Z`);
  // Cap at ~370 buckets to avoid pathological responses.
  let safety = 400;
  while (cur <= end && safety-- > 0) {
    map.set(cur.toISOString().slice(0, 10), 0);
    cur.setUTCDate(cur.getUTCDate() + 1);
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

// Feature 5 — strict input validation for the new/updated report
// filters. Returns the validated values or sends a 400. Centralised so
// every report endpoint speaks the same language.
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function parseReportFilters(
  req: import("express").Request,
  res: import("express").Response,
  allowed: ReadonlyArray<"from" | "to" | "customerId" | "supplierId" | "warehouseId" | "itemId" | "reasonCode">,
):
  | {
      from?: string;
      to?: string;
      customerId?: number;
      supplierId?: number;
      warehouseId?: number;
      itemId?: number;
      reasonCode?: string;
    }
  | null {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    const raw = req.query[key];
    if (raw === undefined || raw === "" || raw === null) continue;
    if (Array.isArray(raw)) {
      res.status(400).json({ error: `invalid_${key}` });
      return null;
    }
    const s = String(raw);
    if (key === "from" || key === "to") {
      if (!ISO_DAY.test(s)) {
        res.status(400).json({ error: `invalid_${key}`, message: "Expected YYYY-MM-DD" });
        return null;
      }
      out[key] = s;
    } else if (key === "reasonCode") {
      if (s.length > 64) {
        res.status(400).json({ error: "invalid_reasonCode" });
        return null;
      }
      out[key] = s;
    } else {
      const n = Number(s);
      if (!Number.isInteger(n) || n <= 0) {
        res.status(400).json({ error: `invalid_${key}` });
        return null;
      }
      out[key] = n;
    }
  }
  if (out.from && out.to && (out.from as string) > (out.to as string)) {
    res.status(400).json({ error: "invalid_range", message: "`from` must be <= `to`" });
    return null;
  }
  return out as ReturnType<typeof parseReportFilters>;
}

router.get("/reports/sales-summary", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orgId = t.organizationId;
    // Optional filters (Feature 5 — reports filters): inclusive date
    // range on orderDate, plus dimensional filters on customer and
    // warehouse. ISO date strings sort lexicographically, so plain
    // gte/lte on the `date` column is correct.
    const f = parseReportFilters(req, res, ["from", "to", "customerId", "warehouseId"]);
    if (!f) return;
    const baseConds = [eq(salesOrdersTable.organizationId, orgId)];
    if (f.from) baseConds.push(gte(salesOrdersTable.orderDate, f.from));
    if (f.to) baseConds.push(lte(salesOrdersTable.orderDate, f.to));
    if (f.customerId) baseConds.push(eq(salesOrdersTable.customerId, f.customerId));
    if (f.warehouseId) baseConds.push(eq(salesOrdersTable.warehouseId, f.warehouseId));
    const baseWhere = and(...baseConds);
    const totalsRow = await db
      .select({
        total: sql<string>`COALESCE(SUM(${salesOrdersTable.total}), 0)`,
        count: sql<string>`COUNT(*)`,
      })
      .from(salesOrdersTable)
      .where(baseWhere);
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
      .where(baseWhere)
      .groupBy(customersTable.id, customersTable.name)
      .orderBy(desc(sql`SUM(${salesOrdersTable.total})`))
      .limit(20);

    // Trend window honors the validated filter range when provided so
    // the chart and summary cards agree; otherwise trailing 30 days.
    const dailyRows = await db
      .select({
        d: salesOrdersTable.orderDate,
        s: sql<string>`COALESCE(SUM(${salesOrdersTable.total}), 0)`,
      })
      .from(salesOrdersTable)
      .where(baseWhere)
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
      trend: trendForRange(dailyRows, f.from, f.to),
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
    const f = parseReportFilters(req, res, ["from", "to", "supplierId", "warehouseId"]);
    if (!f) return;
    const baseConds = [eq(purchaseOrdersTable.organizationId, orgId)];
    if (f.from) baseConds.push(gte(purchaseOrdersTable.orderDate, f.from));
    if (f.to) baseConds.push(lte(purchaseOrdersTable.orderDate, f.to));
    if (f.supplierId) baseConds.push(eq(purchaseOrdersTable.supplierId, f.supplierId));
    if (f.warehouseId) baseConds.push(eq(purchaseOrdersTable.warehouseId, f.warehouseId));
    const baseWhere = and(...baseConds);
    const totalsRow = await db
      .select({
        total: sql<string>`COALESCE(SUM(${purchaseOrdersTable.total}), 0)`,
        count: sql<string>`COUNT(*)`,
      })
      .from(purchaseOrdersTable)
      .where(baseWhere);
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
      .where(baseWhere)
      .groupBy(suppliersTable.id, suppliersTable.name)
      .orderBy(desc(sql`SUM(${purchaseOrdersTable.total})`))
      .limit(20);

    const dailyRows = await db
      .select({
        d: purchaseOrdersTable.orderDate,
        s: sql<string>`COALESCE(SUM(${purchaseOrdersTable.total}), 0)`,
      })
      .from(purchaseOrdersTable)
      .where(baseWhere)
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
      trend: trendForRange(dailyRows, f.from, f.to),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/reports/inventory-valuation-by-warehouse", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const rows = await db
      .select({
        warehouseId: warehousesTable.id,
        warehouseName: warehousesTable.name,
        itemId: itemsTable.id,
        itemName: itemsTable.name,
        sku: itemsTable.sku,
        category: itemsTable.category,
        unitCost: itemsTable.purchasePrice,
        quantity: itemWarehouseStockTable.quantity,
      })
      .from(itemsTable)
      .innerJoin(
        itemWarehouseStockTable,
        eq(itemWarehouseStockTable.itemId, itemsTable.id),
      )
      .innerJoin(
        warehousesTable,
        eq(warehousesTable.id, itemWarehouseStockTable.warehouseId),
      )
      .where(
        and(
          eq(itemsTable.organizationId, t.organizationId),
          sql`${itemsTable.archivedAt} IS NULL`,
          sql`${warehousesTable.isVirtual} = false`,
        ),
      )
      .orderBy(warehousesTable.name, itemsTable.name);

    res.json(
      rows.map((r) => {
        const qty = toNum(r.quantity);
        const cost = toNum(r.unitCost);
        return {
          warehouseId: r.warehouseId,
          warehouseName: r.warehouseName,
          itemId: r.itemId,
          itemName: r.itemName,
          sku: r.sku,
          category: r.category ?? null,
          quantity: qty,
          unitCost: cost,
          totalValue: qty * cost,
        };
      }),
    );
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

// Returns report (Feature 5) — surfaces every cancelled shipment with
// its reason metadata so an operator can answer "what got returned,
// when, and why". Backed by the cancel-reason columns added to
// `shipments` in Feature 4. Org-scoped via the tenant middleware.
router.get("/reports/returns", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orgId = t.organizationId;
    const f = parseReportFilters(req, res, [
      "from",
      "to",
      "reasonCode",
      "customerId",
      "warehouseId",
    ]);
    if (!f) return;
    const conds = [
      eq(shipmentsTable.organizationId, orgId),
      eq(shipmentsTable.status, "cancelled"),
    ];
    if (f.from)
      conds.push(gte(shipmentsTable.cancelledAt, new Date(`${f.from}T00:00:00.000Z`)));
    if (f.to)
      conds.push(lte(shipmentsTable.cancelledAt, new Date(`${f.to}T23:59:59.999Z`)));
    if (f.reasonCode)
      conds.push(eq(shipmentsTable.cancelReasonCode, f.reasonCode));
    if (f.customerId)
      conds.push(eq(salesOrdersTable.customerId, f.customerId));
    if (f.warehouseId)
      conds.push(eq(salesOrdersTable.warehouseId, f.warehouseId));

    const baseWhere = and(...conds);
    const rows = await db
      .select({
        shipmentId: shipmentsTable.id,
        shipmentNumber: shipmentsTable.shipmentNumber,
        cancelledAt: shipmentsTable.cancelledAt,
        cancelReasonCode: shipmentsTable.cancelReasonCode,
        cancelReasonNotes: shipmentsTable.cancelReasonNotes,
        salesOrderId: salesOrdersTable.id,
        orderNumber: salesOrdersTable.orderNumber,
        customerId: customersTable.id,
        customerName: customersTable.name,
        warehouseId: warehousesTable.id,
        warehouseName: warehousesTable.name,
        unitsReturned: sql<string>`COALESCE(SUM(${shipmentLinesTable.quantity}), 0)`,
      })
      .from(shipmentsTable)
      .innerJoin(
        salesOrdersTable,
        eq(salesOrdersTable.id, shipmentsTable.salesOrderId),
      )
      .innerJoin(
        customersTable,
        eq(customersTable.id, salesOrdersTable.customerId),
      )
      .innerJoin(
        warehousesTable,
        eq(warehousesTable.id, salesOrdersTable.warehouseId),
      )
      .leftJoin(
        shipmentLinesTable,
        eq(shipmentLinesTable.shipmentId, shipmentsTable.id),
      )
      .where(baseWhere)
      .groupBy(
        shipmentsTable.id,
        shipmentsTable.shipmentNumber,
        shipmentsTable.cancelledAt,
        shipmentsTable.cancelReasonCode,
        shipmentsTable.cancelReasonNotes,
        salesOrdersTable.id,
        salesOrdersTable.orderNumber,
        customersTable.id,
        customersTable.name,
        warehousesTable.id,
        warehousesTable.name,
      )
      .orderBy(desc(shipmentsTable.cancelledAt));

    const totalShipments = rows.length;
    let totalUnits = 0;
    const byReasonMap = new Map<string | null, { count: number; units: number }>();
    const out = rows.map((r) => {
      const units = toNum(r.unitsReturned);
      totalUnits += units;
      const key = r.cancelReasonCode ?? null;
      const cur = byReasonMap.get(key) ?? { count: 0, units: 0 };
      cur.count += 1;
      cur.units += units;
      byReasonMap.set(key, cur);
      return {
        shipmentId: r.shipmentId,
        shipmentNumber: r.shipmentNumber,
        cancelledAt: r.cancelledAt ? r.cancelledAt.toISOString() : null,
        cancelReasonCode: r.cancelReasonCode ?? null,
        cancelReasonNotes: r.cancelReasonNotes ?? null,
        salesOrderId: r.salesOrderId,
        orderNumber: r.orderNumber,
        customerId: r.customerId,
        customerName: r.customerName,
        warehouseId: r.warehouseId,
        warehouseName: r.warehouseName,
        unitsReturned: units,
      };
    });
    const byReason = Array.from(byReasonMap.entries()).map(([k, v]) => ({
      reasonCode: k,
      shipmentCount: v.count,
      unitsReturned: v.units,
    }));
    res.json({ totalShipments, totalUnits, byReason, rows: out });
  } catch (err) {
    next(err);
  }
});

// Discounts-given report (Feature 5) — line-level rollup of every
// sales-order line with a non-zero discount. Multi-tenant via the
// salesOrders join (no orphan lines).
router.get("/reports/discounts", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orgId = t.organizationId;
    const f = parseReportFilters(req, res, [
      "from",
      "to",
      "itemId",
      "customerId",
      "warehouseId",
    ]);
    if (!f) return;
    const conds = [
      eq(salesOrdersTable.organizationId, orgId),
      sql`(COALESCE(${salesOrderLinesTable.discountAmount}, 0) > 0 OR COALESCE(${salesOrderLinesTable.discountPercent}, 0) > 0)`,
    ];
    if (f.from) conds.push(gte(salesOrdersTable.orderDate, f.from));
    if (f.to) conds.push(lte(salesOrdersTable.orderDate, f.to));
    if (f.itemId) conds.push(eq(salesOrderLinesTable.itemId, f.itemId));
    if (f.customerId) conds.push(eq(salesOrdersTable.customerId, f.customerId));
    if (f.warehouseId) conds.push(eq(salesOrdersTable.warehouseId, f.warehouseId));
    const baseWhere = and(...conds);

    // Effective per-line discount = explicit discountAmount, else
    // discountPercent * quantity * unitPrice / 100. Mirrors the logic
    // in computeOrderTotals.
    const lineDiscount = sql<string>`
      COALESCE(
        ${salesOrderLinesTable.discountAmount},
        (
          COALESCE(${salesOrderLinesTable.discountPercent}, 0)::numeric
          * ${salesOrderLinesTable.quantity}::numeric
          * ${salesOrderLinesTable.unitPrice}::numeric
        ) / 100
      )
    `;

    const totalsRow = await db
      .select({
        totalDiscount: sql<string>`COALESCE(SUM(${lineDiscount}), 0)`,
        lineCount: sql<string>`COUNT(*)`,
        orderCount: sql<string>`COUNT(DISTINCT ${salesOrdersTable.id})`,
      })
      .from(salesOrderLinesTable)
      .innerJoin(
        salesOrdersTable,
        eq(salesOrdersTable.id, salesOrderLinesTable.salesOrderId),
      )
      .where(baseWhere);

    const byItemRows = await db
      .select({
        itemId: itemsTable.id,
        sku: itemsTable.sku,
        itemName: itemsTable.name,
        unitsDiscounted: sql<string>`COALESCE(SUM(${salesOrderLinesTable.quantity}), 0)`,
        discountTotal: sql<string>`COALESCE(SUM(${lineDiscount}), 0)`,
      })
      .from(salesOrderLinesTable)
      .innerJoin(
        salesOrdersTable,
        eq(salesOrdersTable.id, salesOrderLinesTable.salesOrderId),
      )
      .innerJoin(itemsTable, eq(itemsTable.id, salesOrderLinesTable.itemId))
      .where(baseWhere)
      .groupBy(itemsTable.id, itemsTable.sku, itemsTable.name)
      .orderBy(desc(sql`SUM(${lineDiscount})`))
      .limit(50);

    const trendRows = await db
      .select({
        d: salesOrdersTable.orderDate,
        s: sql<string>`COALESCE(SUM(${lineDiscount}), 0)`,
      })
      .from(salesOrderLinesTable)
      .innerJoin(
        salesOrdersTable,
        eq(salesOrdersTable.id, salesOrderLinesTable.salesOrderId),
      )
      .where(baseWhere)
      .groupBy(salesOrdersTable.orderDate);
    const trendBuckets = trendForRange(
      trendRows.map((r) => ({ d: r.d, s: r.s })),
      f.from,
      f.to,
    );

    res.json({
      totalDiscount: toNum(totalsRow[0]?.totalDiscount),
      lineCount: Number(totalsRow[0]?.lineCount ?? 0),
      orderCount: Number(totalsRow[0]?.orderCount ?? 0),
      byItem: byItemRows.map((r) => ({
        itemId: r.itemId,
        sku: r.sku,
        itemName: r.itemName,
        unitsDiscounted: toNum(r.unitsDiscounted),
        discountTotal: toNum(r.discountTotal),
      })),
      trend: trendBuckets.map((b) => ({
        date: b.date,
        discountTotal: b.sales,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
