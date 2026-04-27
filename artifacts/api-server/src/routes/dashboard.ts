import { Router, type IRouter } from "express";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  db,
  itemsTable,
  itemWarehouseStockTable,
  customersTable,
  suppliersTable,
  salesOrdersTable,
  salesOrderLinesTable,
  purchaseOrdersTable,
} from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import { toNum } from "../lib/numeric";

const router: IRouter = Router();
router.use(tenantMiddleware);

router.get("/dashboard/summary", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orgId = t.organizationId;

    const itemsAgg = await db
      .select({
        totalItems: sql<string>`COUNT(*)`,
      })
      .from(itemsTable)
      .where(eq(itemsTable.organizationId, orgId));
    const totalItems = Number(itemsAgg[0]?.totalItems ?? 0);

    const stockAgg = await db
      .select({
        totalValue: sql<string>`COALESCE(SUM(${itemWarehouseStockTable.quantity} * ${itemsTable.purchasePrice}), 0)`,
      })
      .from(itemWarehouseStockTable)
      .innerJoin(itemsTable, eq(itemsTable.id, itemWarehouseStockTable.itemId))
      .where(eq(itemWarehouseStockTable.organizationId, orgId));
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
        eq(itemWarehouseStockTable.itemId, itemsTable.id),
      )
      .where(eq(itemsTable.organizationId, orgId))
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

    const recvAgg = await db
      .select({ s: sql<string>`COALESCE(SUM(${customersTable.outstandingBalance}), 0)` })
      .from(customersTable)
      .where(eq(customersTable.organizationId, orgId));
    const outstandingReceivables = toNum(recvAgg[0]?.s);

    const payAgg = await db
      .select({ s: sql<string>`COALESCE(SUM(${suppliersTable.outstandingPayable}), 0)` })
      .from(suppliersTable)
      .where(eq(suppliersTable.organizationId, orgId));
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
    });
  } catch (err) {
    next(err);
  }
});

export default router;
