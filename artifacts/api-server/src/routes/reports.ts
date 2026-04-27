import { Router, type IRouter } from "express";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  db,
  itemsTable,
  itemWarehouseStockTable,
  salesOrdersTable,
  purchaseOrdersTable,
  customersTable,
  suppliersTable,
} from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import { toNum } from "../lib/numeric";

const router: IRouter = Router();
router.use(tenantMiddleware);

router.get("/reports/inventory-valuation", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const rows = await db
      .select({
        itemId: itemsTable.id,
        sku: itemsTable.sku,
        name: itemsTable.name,
        unitCost: itemsTable.purchasePrice,
        quantityOnHand: sql<string>`COALESCE(SUM(${itemWarehouseStockTable.quantity}), 0)`,
      })
      .from(itemsTable)
      .leftJoin(
        itemWarehouseStockTable,
        eq(itemWarehouseStockTable.itemId, itemsTable.id),
      )
      .where(eq(itemsTable.organizationId, t.organizationId))
      .groupBy(itemsTable.id, itemsTable.sku, itemsTable.name, itemsTable.purchasePrice);
    res.json(
      rows.map((r) => {
        const qty = toNum(r.quantityOnHand);
        const cost = toNum(r.unitCost);
        return {
          itemId: r.itemId,
          sku: r.sku,
          name: r.name,
          quantityOnHand: qty,
          unitCost: cost,
          totalValue: qty * cost,
        };
      }),
    );
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
      .where(eq(itemsTable.organizationId, t.organizationId))
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

export default router;
