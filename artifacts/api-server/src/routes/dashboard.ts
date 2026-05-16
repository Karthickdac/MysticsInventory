import { Router, type IRouter } from "express";
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import {
  db,
  itemsTable,
  itemWarehouseStockTable,
  customersTable,
  suppliersTable,
  salesOrdersTable,
  salesOrderLinesTable,
  purchaseOrdersTable,
  warehousesTable,
} from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import { toNum } from "../lib/numeric";

const router: IRouter = Router();
router.use(tenantMiddleware);

// We cap the failed-IRP feed on the dashboard so the panel stays a
// glanceable summary; tenants with more than this should drill into
// the sales-order list (which surfaces the same friendly "what to
// fix" guidance per row).
const FAILED_EINVOICES_LIMIT = 5;

router.get("/dashboard/summary", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orgId = t.organizationId;

    // Optional warehouse filter — scopes stock metrics to a single location.
    let warehouseId: number | undefined;
    if (req.query.warehouseId !== undefined && req.query.warehouseId !== "") {
      const n = Number(req.query.warehouseId);
      if (!Number.isInteger(n) || n <= 0) {
        res.status(400).json({ error: "warehouseId must be a positive integer" });
        return;
      }
      // Verify warehouse belongs to this org before using it.
      const whRows = await db
        .select({ id: warehousesTable.id })
        .from(warehousesTable)
        .where(
          and(
            eq(warehousesTable.id, n),
            eq(warehousesTable.organizationId, orgId),
          ),
        )
        .limit(1);
      if (whRows.length === 0) {
        res.status(404).json({ error: "Warehouse not found" });
        return;
      }
      warehouseId = n;
    }

    const itemsAgg = await db
      .select({
        totalItems: sql<string>`COUNT(DISTINCT ${itemsTable.id})`,
      })
      .from(itemsTable)
      .leftJoin(
        itemWarehouseStockTable,
        and(
          eq(itemWarehouseStockTable.itemId, itemsTable.id),
          warehouseId !== undefined
            ? eq(itemWarehouseStockTable.warehouseId, warehouseId)
            : undefined,
        ),
      )
      .where(
        and(
          eq(itemsTable.organizationId, orgId),
          sql`${itemsTable.archivedAt} IS NULL`,
          warehouseId !== undefined
            ? sql`${itemWarehouseStockTable.quantity} > 0`
            : undefined,
        ),
      );
    const totalItems = Number(itemsAgg[0]?.totalItems ?? 0);

    const stockWhere = and(
      eq(itemWarehouseStockTable.organizationId, orgId),
      sql`${itemsTable.archivedAt} IS NULL`,
      warehouseId !== undefined
        ? eq(itemWarehouseStockTable.warehouseId, warehouseId)
        : undefined,
    );
    const stockAgg = await db
      .select({
        totalValue: sql<string>`COALESCE(SUM(${itemWarehouseStockTable.quantity} * ${itemsTable.purchasePrice}), 0)`,
      })
      .from(itemWarehouseStockTable)
      .innerJoin(itemsTable, eq(itemsTable.id, itemWarehouseStockTable.itemId))
      .where(stockWhere);
    const totalStockValue = toNum(stockAgg[0]?.totalValue);

    const lowStockRows = await db
      .select({
        itemId: itemsTable.id,
        reorder: itemsTable.reorderLevel,
        onHand: sql<string>`COALESCE(SUM(${itemWarehouseStockTable.quantity}), 0)`,
      })
      .from(itemsTable)
      .leftJoin(
        itemWarehouseStockTable,
        and(
          eq(itemWarehouseStockTable.itemId, itemsTable.id),
          warehouseId !== undefined
            ? eq(itemWarehouseStockTable.warehouseId, warehouseId)
            : undefined,
        ),
      )
      .where(
        and(
          eq(itemsTable.organizationId, orgId),
          sql`${itemsTable.archivedAt} IS NULL`,
        ),
      )
      .groupBy(itemsTable.id, itemsTable.reorderLevel);
    const lowStockCount = lowStockRows.filter(
      (r) => toNum(r.reorder) > 0 && toNum(r.onHand) <= toNum(r.reorder),
    ).length;

    const openSO = await db
      .select({ c: sql<string>`COUNT(*)` })
      .from(salesOrdersTable)
      .where(
        and(
          eq(salesOrdersTable.organizationId, orgId),
          sql`${salesOrdersTable.status} NOT IN ('delivered','cancelled')`,
        ),
      );
    const openSalesOrders = Number(openSO[0]?.c ?? 0);

    const openPO = await db
      .select({ c: sql<string>`COUNT(*)` })
      .from(purchaseOrdersTable)
      .where(
        and(
          eq(purchaseOrdersTable.organizationId, orgId),
          sql`${purchaseOrdersTable.status} NOT IN ('received','cancelled')`,
        ),
      );
    const openPurchaseOrders = Number(openPO[0]?.c ?? 0);

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const startISO = startOfMonth.toISOString().slice(0, 10);

    const salesMonth = await db
      .select({ s: sql<string>`COALESCE(SUM(${salesOrdersTable.total}), 0)` })
      .from(salesOrdersTable)
      .where(
        and(
          eq(salesOrdersTable.organizationId, orgId),
          gte(salesOrdersTable.orderDate, startISO),
        ),
      );
    const salesThisMonth = toNum(salesMonth[0]?.s);

    const purchasesMonth = await db
      .select({ s: sql<string>`COALESCE(SUM(${purchaseOrdersTable.total}), 0)` })
      .from(purchaseOrdersTable)
      .where(
        and(
          eq(purchaseOrdersTable.organizationId, orgId),
          gte(purchaseOrdersTable.orderDate, startISO),
        ),
      );
    const purchasesThisMonth = toNum(purchasesMonth[0]?.s);

    // Derive receivables from open sales orders' balance_due rather
    // than reading the cached customers.outstanding_balance column —
    // that column can drift if a payment / cancellation path forgot
    // to decrement it. The actual liability is the sum of balances
    // on every non-draft, non-cancelled SO.
    const recvAgg = await db
      .select({
        s: sql<string>`COALESCE(SUM(${salesOrdersTable.balanceDue}), 0)`,
      })
      .from(salesOrdersTable)
      .where(
        and(
          eq(salesOrdersTable.organizationId, orgId),
          sql`${salesOrdersTable.status} NOT IN ('draft','cancelled')`,
        ),
      );
    const outstandingReceivables = toNum(recvAgg[0]?.s);

    // Same derivation for payables: sum balance_due on every
    // non-draft, non-cancelled PO.
    const payAgg = await db
      .select({
        s: sql<string>`COALESCE(SUM(${purchaseOrdersTable.balanceDue}), 0)`,
      })
      .from(purchaseOrdersTable)
      .where(
        and(
          eq(purchaseOrdersTable.organizationId, orgId),
          sql`${purchaseOrdersTable.status} NOT IN ('draft','cancelled')`,
        ),
      );
    const outstandingPayables = toNum(payAgg[0]?.s);

    const since = new Date();
    since.setDate(since.getDate() - 29);
    const sinceISO = since.toISOString().slice(0, 10);

    const dailySales = await db
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

    const dailyPurchases = await db
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

    const trendMap = new Map<string, { sales: number; purchases: number }>();
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      trendMap.set(d.toISOString().slice(0, 10), { sales: 0, purchases: 0 });
    }
    for (const row of dailySales) {
      const e = trendMap.get(row.d);
      if (e) e.sales = toNum(row.s);
    }
    for (const row of dailyPurchases) {
      const e = trendMap.get(row.d);
      if (e) e.purchases = toNum(row.s);
    }
    const salesTrend = Array.from(trendMap.entries()).map(([date, v]) => ({
      date,
      sales: v.sales,
      purchases: v.purchases,
    }));

    const topItemsRows = await db
      .select({
        itemId: itemsTable.id,
        name: itemsTable.name,
        sku: itemsTable.sku,
        qty: sql<string>`COALESCE(SUM(${salesOrderLinesTable.quantity}), 0)`,
        revenue: sql<string>`COALESCE(SUM(${salesOrderLinesTable.lineTotal}), 0)`,
      })
      .from(salesOrderLinesTable)
      .innerJoin(itemsTable, eq(itemsTable.id, salesOrderLinesTable.itemId))
      .innerJoin(
        salesOrdersTable,
        eq(salesOrdersTable.id, salesOrderLinesTable.salesOrderId),
      )
      .where(eq(salesOrdersTable.organizationId, orgId))
      .groupBy(itemsTable.id, itemsTable.name, itemsTable.sku)
      .orderBy(desc(sql`SUM(${salesOrderLinesTable.lineTotal})`))
      .limit(5);
    const topItems = topItemsRows.map((r) => ({
      itemId: r.itemId,
      name: r.name,
      sku: r.sku,
      quantitySold: toNum(r.qty),
      revenue: toNum(r.revenue),
    }));

    const recentSO = await db
      .select({
        id: salesOrdersTable.id,
        orderNumber: salesOrdersTable.orderNumber,
        total: salesOrdersTable.total,
        createdAt: salesOrdersTable.createdAt,
        customerName: customersTable.name,
      })
      .from(salesOrdersTable)
      .innerJoin(customersTable, eq(customersTable.id, salesOrdersTable.customerId))
      .where(eq(salesOrdersTable.organizationId, orgId))
      .orderBy(desc(salesOrdersTable.createdAt))
      .limit(5);

    const recentPO = await db
      .select({
        id: purchaseOrdersTable.id,
        orderNumber: purchaseOrdersTable.orderNumber,
        total: purchaseOrdersTable.total,
        createdAt: purchaseOrdersTable.createdAt,
        supplierName: suppliersTable.name,
      })
      .from(purchaseOrdersTable)
      .innerJoin(suppliersTable, eq(suppliersTable.id, purchaseOrdersTable.supplierId))
      .where(eq(purchaseOrdersTable.organizationId, orgId))
      .orderBy(desc(purchaseOrdersTable.createdAt))
      .limit(5);

    const recentActivity = [
      ...recentSO.map((r) => ({
        id: `so-${r.id}`,
        kind: "sales_order",
        title: r.orderNumber,
        subtitle: r.customerName,
        amount: toNum(r.total),
        timestamp: r.createdAt.toISOString(),
      })),
      ...recentPO.map((r) => ({
        id: `po-${r.id}`,
        kind: "purchase_order",
        title: r.orderNumber,
        subtitle: r.supplierName,
        amount: toNum(r.total),
        timestamp: r.createdAt.toISOString(),
      })),
    ]
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
      .slice(0, 8);

    // Failed IRP submissions surfaced on the dashboard with the same
    // friendly "what to fix" treatment as the SalesOrderDetail panel.
    // We rely on `irpStatus = 'failed'` (set by the single-order route
    // and the bulk worker) and ignore rows without an error message —
    // there's nothing actionable to show without one.
    const failedRows = await db
      .select({
        id: salesOrdersTable.id,
        orderNumber: salesOrdersTable.orderNumber,
        customerId: salesOrdersTable.customerId,
        customerName: customersTable.name,
        irpError: salesOrdersTable.irpError,
        irpErrorCode: salesOrdersTable.irpErrorCode,
        irpErrorContext: salesOrdersTable.irpErrorContext,
        updatedAt: salesOrdersTable.updatedAt,
      })
      .from(salesOrdersTable)
      .innerJoin(
        customersTable,
        eq(customersTable.id, salesOrdersTable.customerId),
      )
      .where(
        and(
          eq(salesOrdersTable.organizationId, orgId),
          eq(salesOrdersTable.irpStatus, "failed"),
          isNotNull(salesOrdersTable.irpError),
        ),
      )
      .orderBy(desc(salesOrdersTable.updatedAt))
      .limit(FAILED_EINVOICES_LIMIT);
    const failedEinvoices = failedRows.map((r) => ({
      salesOrderId: r.id,
      orderNumber: r.orderNumber,
      customerId: r.customerId,
      customerName: r.customerName,
      errorCode: r.irpErrorCode,
      errorContext:
        r.irpErrorContext &&
        typeof r.irpErrorContext === "object" &&
        !Array.isArray(r.irpErrorContext)
          ? (r.irpErrorContext as Record<string, unknown>)
          : null,
      error: r.irpError,
      updatedAt: r.updatedAt.toISOString(),
    }));

    res.json({
      totalItems,
      totalStockValue,
      lowStockCount,
      openSalesOrders,
      openPurchaseOrders,
      salesThisMonth,
      purchasesThisMonth,
      outstandingReceivables,
      outstandingPayables,
      salesTrend,
      topItems,
      recentActivity,
      failedEinvoices,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
