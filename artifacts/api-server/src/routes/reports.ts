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

export default router;
