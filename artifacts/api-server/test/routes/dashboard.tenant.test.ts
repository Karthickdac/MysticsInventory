// Cross-tenant isolation tests for the dashboard router.
//
// /dashboard/summary aggregates many tenant-scoped facts (item counts,
// stock value, low-stock count, open SO/PO counters, this-month sales
// and purchases totals, outstanding receivables/payables, 30-day trend,
// top-selling items, recent activity, and failed e-invoice rows). Each
// of those reads is funnelled through `t.organizationId` from the
// tenant middleware; this suite seeds both orgs with overlapping but
// distinctly-valued fixtures and asserts the response only ever
// reflects the caller's own data.

import { describe, it, expect, beforeEach, vi } from "vitest";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";
import {
  createInMemoryDbModuleMock,
  memDb,
  tables,
} from "../helpers/inMemoryDb";

vi.mock("@workspace/db", () => createInMemoryDbModuleMock());
vi.mock("../../src/lib/tenant", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/lib/tenant")>(
      "../../src/lib/tenant",
    );
  return {
    ...actual,
    tenantMiddleware: (req: Request, res: Response, next: NextFunction) => {
      const orgId = Number(req.header("x-test-org-id"));
      if (!Number.isFinite(orgId) || orgId <= 0) {
        res.status(401).json({ error: "missing x-test-org-id header" });
        return;
      }
      req.tenant = {
        userId: orgId * 10,
        organizationId: orgId,
        role: "owner",
        clerkUserId: `user_test_${orgId}`,
        isSuperAdmin: false,
      };
      next();
    },
  };
});

import dashboardRouter from "../../src/routes/dashboard";

const ORG_A = 1001;
const ORG_B = 2002;
const TODAY_ISO = new Date().toISOString().slice(0, 10);

interface OrgFixture {
  orgId: number;
  customerId: number;
  customerName: string;
  supplierId: number;
  warehouseId: number;
  itemId: number;
  itemName: string;
  itemSku: string;
  openSalesOrderId: number;
  openSalesOrderNumber: string;
  closedSalesOrderId: number;
  failedSalesOrderId: number;
  failedOrderError: string;
  openPurchaseOrderId: number;
  openPurchaseOrderNumber: string;
  outstandingBalance: number;
  outstandingPayable: number;
  openSalesTotal: number;
  closedSalesTotal: number;
  openPurchaseTotal: number;
  itemPurchasePrice: number;
  stockQuantity: number;
}

interface SeedSpec {
  outstandingBalance: string;
  outstandingPayable: string;
  itemPurchasePrice: string;
  stockQuantity: string;
  openSalesTotal: string;
  closedSalesTotal: string;
  openPurchaseTotal: string;
  reorderLevel: string;
}

async function seedOrg(label: "A" | "B", orgId: number, s: SeedSpec): Promise<OrgFixture> {
  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
  });
  const customerName = `Customer ${label}`;
  const customer = await memDb.seed(tables.customersTable, {
    organizationId: orgId,
    name: customerName,
    email: null,
    phone: null,
    company: null,
    gstNumber: null,
    billingAddress: null,
    shippingAddress: null,
    placeOfSupply: null,
    notes: null,
    outstandingBalance: s.outstandingBalance,
  });
  const supplier = await memDb.seed(tables.suppliersTable, {
    organizationId: orgId,
    name: `Supplier ${label}`,
    email: null,
    phone: null,
    company: null,
    gstNumber: null,
    billingAddress: null,
    shippingAddress: null,
    placeOfSupply: null,
    notes: null,
    outstandingPayable: s.outstandingPayable,
  });
  const warehouse = await memDb.seed(tables.warehousesTable, {
    organizationId: orgId,
    name: `WH ${label}`,
    code: `WH-${label}`,
    isVirtual: false,
    isDefault: true,
  });
  const itemName = `Item ${label}`;
  const itemSku = `SKU-${label}`;
  const item = await memDb.seed(tables.itemsTable, {
    organizationId: orgId,
    name: itemName,
    sku: itemSku,
    description: null,
    category: null,
    unit: "ea",
    barcode: null,
    salePrice: "10",
    purchasePrice: s.itemPurchasePrice,
    hsnCode: null,
    taxRate: "0",
    reorderLevel: s.reorderLevel,
    imageUrl: null,
    hasVariants: false,
    isBundle: false,
    trackBatches: false,
    parentItemId: null,
    variantOptions: null,
    archivedAt: null,
  });
  await memDb.seed(tables.itemWarehouseStockTable, {
    organizationId: orgId,
    itemId: item.id,
    warehouseId: warehouse.id,
    quantity: s.stockQuantity,
  });
  const openOrderNumber = `SO-${label}-OPEN`;
  const openSO = await memDb.seed(tables.salesOrdersTable, {
    organizationId: orgId,
    orderNumber: openOrderNumber,
    customerId: customer.id,
    warehouseId: warehouse.id,
    status: "confirmed",
    orderDate: TODAY_ISO,
    expectedShipDate: null,
    subtotal: s.openSalesTotal,
    taxTotal: "0",
    total: s.openSalesTotal,
    amountPaid: "0",
    balanceDue: s.openSalesTotal,
    notes: null,
    irpStatus: null,
    irpError: null,
    irpErrorCode: null,
    irpErrorContext: null,
    updatedAt: new Date(),
  });
  await memDb.seed(tables.salesOrderLinesTable, {
    organizationId: orgId,
    salesOrderId: openSO.id,
    itemId: item.id,
    description: null,
    quantity: "5",
    quantityShipped: "0",
    unitPrice: s.openSalesTotal,
    taxRate: "0",
    lineSubtotal: s.openSalesTotal,
    lineTax: "0",
    lineTotal: s.openSalesTotal,
  });
  const closedSO = await memDb.seed(tables.salesOrdersTable, {
    organizationId: orgId,
    orderNumber: `SO-${label}-DELIV`,
    customerId: customer.id,
    warehouseId: warehouse.id,
    status: "delivered",
    orderDate: TODAY_ISO,
    expectedShipDate: null,
    subtotal: s.closedSalesTotal,
    taxTotal: "0",
    total: s.closedSalesTotal,
    amountPaid: s.closedSalesTotal,
    balanceDue: "0",
    notes: null,
    irpStatus: null,
    irpError: null,
    irpErrorCode: null,
    irpErrorContext: null,
    updatedAt: new Date(),
  });
  const failedError = `IRP failure ${label}`;
  const failedSO = await memDb.seed(tables.salesOrdersTable, {
    organizationId: orgId,
    orderNumber: `SO-${label}-IRPFAIL`,
    customerId: customer.id,
    warehouseId: warehouse.id,
    status: "confirmed",
    orderDate: TODAY_ISO,
    expectedShipDate: null,
    subtotal: "1",
    taxTotal: "0",
    total: "1",
    amountPaid: "0",
    balanceDue: "1",
    notes: null,
    irpStatus: "failed",
    irpError: failedError,
    irpErrorCode: `FAIL_${label}`,
    irpErrorContext: { reason: `r-${label}` },
    updatedAt: new Date(),
  });
  const openPONumber = `PO-${label}-OPEN`;
  const openPO = await memDb.seed(tables.purchaseOrdersTable, {
    organizationId: orgId,
    orderNumber: openPONumber,
    supplierId: supplier.id,
    warehouseId: warehouse.id,
    status: "ordered",
    orderDate: TODAY_ISO,
    expectedDeliveryDate: null,
    subtotal: s.openPurchaseTotal,
    taxTotal: "0",
    total: s.openPurchaseTotal,
    amountPaid: "0",
    balanceDue: s.openPurchaseTotal,
    notes: null,
  });
  return {
    orgId,
    customerId: customer.id as number,
    customerName,
    supplierId: supplier.id as number,
    warehouseId: warehouse.id as number,
    itemId: item.id as number,
    itemName,
    itemSku,
    openSalesOrderId: openSO.id as number,
    openSalesOrderNumber: openOrderNumber,
    closedSalesOrderId: closedSO.id as number,
    failedSalesOrderId: failedSO.id as number,
    failedOrderError: failedError,
    openPurchaseOrderId: openPO.id as number,
    openPurchaseOrderNumber: openPONumber,
    outstandingBalance: Number(s.outstandingBalance),
    outstandingPayable: Number(s.outstandingPayable),
    openSalesTotal: Number(s.openSalesTotal),
    closedSalesTotal: Number(s.closedSalesTotal),
    openPurchaseTotal: Number(s.openPurchaseTotal),
    itemPurchasePrice: Number(s.itemPurchasePrice),
    stockQuantity: Number(s.stockQuantity),
  };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(dashboardRouter);
  return app;
}

interface DashboardSummary {
  totalItems: number;
  totalStockValue: number;
  lowStockCount: number;
  openSalesOrders: number;
  openPurchaseOrders: number;
  salesThisMonth: number;
  purchasesThisMonth: number;
  outstandingReceivables: number;
  outstandingPayables: number;
  topItems: Array<{
    itemId: number;
    name: string;
    sku: string;
    quantitySold: number;
    revenue: number;
  }>;
  recentActivity: Array<{
    id: string;
    kind: string;
    title: string;
    subtitle: string;
    amount: number;
  }>;
  failedEinvoices: Array<{
    salesOrderId: number;
    orderNumber: string;
    customerName: string;
    error: string;
  }>;
}

describe("dashboard cross-tenant isolation", () => {
  let app: Express;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeEach(async () => {
    await memDb.reset();
    a = await seedOrg("A", ORG_A, {
      outstandingBalance: "100",
      outstandingPayable: "200",
      itemPurchasePrice: "5",
      stockQuantity: "20",
      openSalesTotal: "300",
      closedSalesTotal: "150",
      openPurchaseTotal: "400",
      reorderLevel: "100",
    });
    b = await seedOrg("B", ORG_B, {
      outstandingBalance: "999",
      outstandingPayable: "888",
      itemPurchasePrice: "7",
      stockQuantity: "30",
      openSalesTotal: "1234",
      closedSalesTotal: "777",
      openPurchaseTotal: "555",
      reorderLevel: "100",
    });
    app = buildApp();
  });

  it("rejects requests without an x-test-org-id header", async () => {
    const res = await request(app).get("/dashboard/summary");
    expect(res.status).toBe(401);
  });

  it("returns only ORG_A facts when called as ORG_A", async () => {
    const res = await request(app)
      .get("/dashboard/summary")
      .set("x-test-org-id", String(ORG_A));
    expect(res.status).toBe(200);
    const body = res.body as DashboardSummary;

    // Item count, stock value, low-stock are ORG_A's
    expect(body.totalItems).toBe(1);
    expect(body.totalStockValue).toBe(
      a.stockQuantity * a.itemPurchasePrice,
    );
    expect(body.lowStockCount).toBe(1); // 20 on hand <= 100 reorder

    // Open counters reflect only ORG_A
    expect(body.openSalesOrders).toBe(2); // openSO + failedSO (both confirmed)
    expect(body.openPurchaseOrders).toBe(1);

    // Money totals are ORG_A's; ORG_B numbers must not bleed in.
    expect(body.salesThisMonth).toBe(
      a.openSalesTotal + a.closedSalesTotal + 1,
    );
    expect(body.purchasesThisMonth).toBe(a.openPurchaseTotal);
    // Receivables / payables are now derived from non-draft, non-cancelled
    // sales / purchase orders' balance_due (not the cached customer /
    // supplier columns). For ORG_A: openSO (balance 300) + failedSO
    // (balance 1) — the delivered SO has balance 0 — and the single
    // open PO with balance 400.
    expect(body.outstandingReceivables).toBe(a.openSalesTotal + 1);
    expect(body.outstandingPayables).toBe(a.openPurchaseTotal);
    expect(body.salesThisMonth).not.toBe(
      b.openSalesTotal + b.closedSalesTotal + 1,
    );

    // Top items: only ORG_A's item should appear.
    const topItemIds = body.topItems.map((t) => t.itemId);
    expect(topItemIds).toContain(a.itemId);
    expect(topItemIds).not.toContain(b.itemId);
    const topItemNames = body.topItems.map((t) => t.name);
    expect(topItemNames).not.toContain(b.itemName);

    // Recent activity: only ORG_A's order numbers.
    const titles = body.recentActivity.map((r) => r.title);
    expect(titles).toContain(a.openSalesOrderNumber);
    expect(titles).toContain(a.openPurchaseOrderNumber);
    expect(titles).not.toContain(b.openSalesOrderNumber);
    expect(titles).not.toContain(b.openPurchaseOrderNumber);

    // Failed e-invoices: only ORG_A's failed SO.
    const failedIds = body.failedEinvoices.map((f) => f.salesOrderId);
    expect(failedIds).toEqual([a.failedSalesOrderId]);
    expect(failedIds).not.toContain(b.failedSalesOrderId);
    const failedErrors = body.failedEinvoices.map((f) => f.error);
    expect(failedErrors).not.toContain(b.failedOrderError);
  });

  it("returns only ORG_B facts when called as ORG_B", async () => {
    const res = await request(app)
      .get("/dashboard/summary")
      .set("x-test-org-id", String(ORG_B));
    expect(res.status).toBe(200);
    const body = res.body as DashboardSummary;

    expect(body.totalItems).toBe(1);
    expect(body.totalStockValue).toBe(
      b.stockQuantity * b.itemPurchasePrice,
    );
    expect(body.outstandingReceivables).toBe(b.openSalesTotal + 1);
    expect(body.outstandingPayables).toBe(b.openPurchaseTotal);
    expect(body.salesThisMonth).toBe(
      b.openSalesTotal + b.closedSalesTotal + 1,
    );
    expect(body.purchasesThisMonth).toBe(b.openPurchaseTotal);

    const topItemIds = body.topItems.map((t) => t.itemId);
    expect(topItemIds).toContain(b.itemId);
    expect(topItemIds).not.toContain(a.itemId);

    const titles = body.recentActivity.map((r) => r.title);
    expect(titles).toContain(b.openSalesOrderNumber);
    expect(titles).not.toContain(a.openSalesOrderNumber);
    expect(titles).not.toContain(a.openPurchaseOrderNumber);

    const failedIds = body.failedEinvoices.map((f) => f.salesOrderId);
    expect(failedIds).toEqual([b.failedSalesOrderId]);
    expect(failedIds).not.toContain(a.failedSalesOrderId);
  });
});
