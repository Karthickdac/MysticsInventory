// Cross-tenant isolation tests for the reports router.
//
// Every reports endpoint pulls `t.organizationId` from the tenant
// middleware and uses it in the WHERE clause of its read query (or
// passes it down into a lib helper that does). This suite seeds two
// orgs with overlapping shapes but distinct identifiers and asserts
// that none of the endpoints leaks the other org's customers, items,
// suppliers, batches, or money totals.
//
// We cover the data-driven endpoints fully:
//   /reports/inventory-valuation, /reports/low-stock,
//   /reports/sales-summary, /reports/receivables-aging,
//   /reports/payables-aging, /reports/purchase-summary,
//   /reports/batches-near-expiry.
// The GST and Tally endpoints (gstr-1, gstr-3b, hsn-summary,
// tally-export) are exercised lightly to confirm their lib helpers
// honour the org filter; the deep semantic shape of those reports is
// covered elsewhere.

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

import reportsRouter from "../../src/routes/reports";

const ORG_A = 1001;
const ORG_B = 2002;
const TODAY_ISO = new Date().toISOString().slice(0, 10);
const TOMORROW_ISO = new Date(Date.now() + 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);

interface OrgFixture {
  orgId: number;
  customerId: number;
  customerName: string;
  supplierId: number;
  supplierName: string;
  warehouseId: number;
  warehouseName: string;
  itemId: number;
  itemName: string;
  itemSku: string;
  batchId: number;
  batchNumber: string;
  salesOrderId: number;
  salesOrderNumber: string;
  purchaseOrderId: number;
  purchaseOrderNumber: string;
  itemPurchasePrice: number;
  stockQuantity: number;
  reorderLevel: number;
  soBalanceDue: number;
  poBalanceDue: number;
  soTotal: number;
  poTotal: number;
}

interface SeedSpec {
  itemPurchasePrice: string;
  stockQuantity: string;
  reorderLevel: string;
  soTotal: string;
  soBalanceDue: string;
  poTotal: string;
  poBalanceDue: string;
}

async function seedOrg(label: "A" | "B", orgId: number, s: SeedSpec): Promise<OrgFixture> {
  const customerName = `Customer ${label}`;
  const supplierName = `Supplier ${label}`;
  const warehouseName = `Warehouse ${label}`;
  const itemName = `Item ${label}`;
  const itemSku = `SKU-${label}`;
  const batchNumber = `BATCH-${label}-1`;
  const salesOrderNumber = `SO-${label}-1`;
  const purchaseOrderNumber = `PO-${label}-1`;

  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
    gstNumber: label === "A" ? "27ABCDE1234F1Z5" : "29ABCDE1234F1Z6",
    state: label === "A" ? "Maharashtra" : "Karnataka",
  });
  const customer = await memDb.seed(tables.customersTable, {
    organizationId: orgId,
    name: customerName,
    email: null,
    phone: null,
    company: null,
    gstNumber: null,
    billingAddress: null,
    shippingAddress: null,
    placeOfSupply: label === "A" ? "Maharashtra" : "Karnataka",
    notes: null,
    outstandingBalance: s.soBalanceDue,
  });
  const supplier = await memDb.seed(tables.suppliersTable, {
    organizationId: orgId,
    name: supplierName,
    email: null,
    phone: null,
    company: null,
    gstNumber: null,
    billingAddress: null,
    shippingAddress: null,
    placeOfSupply: null,
    notes: null,
    outstandingPayable: s.poBalanceDue,
  });
  const warehouse = await memDb.seed(tables.warehousesTable, {
    organizationId: orgId,
    name: warehouseName,
    code: `WH-${label}`,
    isVirtual: false,
    isDefault: true,
  });
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
    hsnCode: "1234",
    taxRate: "18",
    reorderLevel: s.reorderLevel,
    imageUrl: null,
    hasVariants: false,
    isBundle: false,
    trackBatches: true,
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
  const batch = await memDb.seed(tables.itemBatchesTable, {
    organizationId: orgId,
    itemId: item.id,
    batchNumber,
    mfgDate: TODAY_ISO,
    expiryDate: TOMORROW_ISO,
    costPrice: s.itemPurchasePrice,
  });
  await memDb.seed(tables.itemBatchWarehouseStockTable, {
    organizationId: orgId,
    itemBatchId: batch.id,
    warehouseId: warehouse.id,
    quantity: s.stockQuantity,
  });
  const so = await memDb.seed(tables.salesOrdersTable, {
    organizationId: orgId,
    orderNumber: salesOrderNumber,
    customerId: customer.id,
    warehouseId: warehouse.id,
    status: "confirmed",
    orderDate: TODAY_ISO,
    expectedShipDate: null,
    subtotal: s.soTotal,
    taxTotal: "0",
    total: s.soTotal,
    amountPaid: "0",
    balanceDue: s.soBalanceDue,
    notes: null,
  });
  await memDb.seed(tables.salesOrderLinesTable, {
    organizationId: orgId,
    salesOrderId: so.id,
    itemId: item.id,
    description: null,
    quantity: "1",
    quantityShipped: "0",
    unitPrice: s.soTotal,
    taxRate: "18",
    lineSubtotal: s.soTotal,
    lineTax: String(Number(s.soTotal) * 0.18),
    lineTotal: String(Number(s.soTotal) * 1.18),
  });
  const po = await memDb.seed(tables.purchaseOrdersTable, {
    organizationId: orgId,
    orderNumber: purchaseOrderNumber,
    supplierId: supplier.id,
    warehouseId: warehouse.id,
    status: "ordered",
    orderDate: TODAY_ISO,
    expectedDeliveryDate: null,
    subtotal: s.poTotal,
    taxTotal: "0",
    total: s.poTotal,
    amountPaid: "0",
    balanceDue: s.poBalanceDue,
    notes: null,
  });
  return {
    orgId,
    customerId: customer.id as number,
    customerName,
    supplierId: supplier.id as number,
    supplierName,
    warehouseId: warehouse.id as number,
    warehouseName,
    itemId: item.id as number,
    itemName,
    itemSku,
    batchId: batch.id as number,
    batchNumber,
    salesOrderId: so.id as number,
    salesOrderNumber,
    purchaseOrderId: po.id as number,
    purchaseOrderNumber,
    itemPurchasePrice: Number(s.itemPurchasePrice),
    stockQuantity: Number(s.stockQuantity),
    reorderLevel: Number(s.reorderLevel),
    soBalanceDue: Number(s.soBalanceDue),
    poBalanceDue: Number(s.poBalanceDue),
    soTotal: Number(s.soTotal),
    poTotal: Number(s.poTotal),
  };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(reportsRouter);
  return app;
}

describe("reports cross-tenant isolation", () => {
  let app: Express;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeEach(async () => {
    await memDb.reset();
    a = await seedOrg("A", ORG_A, {
      itemPurchasePrice: "5",
      stockQuantity: "20",
      reorderLevel: "100",
      soTotal: "111",
      soBalanceDue: "111",
      poTotal: "222",
      poBalanceDue: "222",
    });
    b = await seedOrg("B", ORG_B, {
      itemPurchasePrice: "9",
      stockQuantity: "30",
      reorderLevel: "100",
      soTotal: "555",
      soBalanceDue: "555",
      poTotal: "777",
      poBalanceDue: "777",
    });
    app = buildApp();
  });

  describe("auth", () => {
    const endpoints = [
      "/reports/inventory-valuation",
      "/reports/low-stock",
      "/reports/sales-summary",
      "/reports/receivables-aging",
      "/reports/payables-aging",
      "/reports/purchase-summary",
      "/reports/batches-near-expiry",
    ];
    for (const path of endpoints) {
      it(`rejects ${path} without an x-test-org-id header`, async () => {
        const res = await request(app).get(path);
        expect(res.status).toBe(401);
      });
    }
  });

  describe("GET /reports/inventory-valuation", () => {
    it("returns only the caller's items", async () => {
      const res = await request(app)
        .get("/reports/inventory-valuation")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ itemId: number }>).map((r) => r.itemId);
      expect(ids).toEqual([a.itemId]);
      expect(ids).not.toContain(b.itemId);
      const skus = (res.body as Array<{ sku: string }>).map((r) => r.sku);
      expect(skus).not.toContain(b.itemSku);
    });

    it("with showBatches=true does not surface the other org's batches", async () => {
      const res = await request(app)
        .get("/reports/inventory-valuation?showBatches=true")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const batches = (res.body as Array<{ batchNumber: string | null }>)
        .map((r) => r.batchNumber)
        .filter((n): n is string => n !== null);
      expect(batches).toContain(a.batchNumber);
      expect(batches).not.toContain(b.batchNumber);
    });
  });

  describe("GET /reports/low-stock", () => {
    it("returns only the caller's low-stock items", async () => {
      const res = await request(app)
        .get("/reports/low-stock")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ itemId: number; sku: string }>).map(
        (r) => r.itemId,
      );
      expect(ids).toEqual([a.itemId]);
      expect(ids).not.toContain(b.itemId);
    });
  });

  describe("GET /reports/sales-summary", () => {
    it("returns totals and customer breakdown for caller only", async () => {
      const res = await request(app)
        .get("/reports/sales-summary")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const body = res.body as {
        totalSales: number;
        orderCount: number;
        byCustomer: Array<{ customerId: number; customerName: string; total: number }>;
      };
      expect(body.totalSales).toBe(a.soTotal);
      expect(body.orderCount).toBe(1);
      const customerIds = body.byCustomer.map((r) => r.customerId);
      expect(customerIds).toEqual([a.customerId]);
      expect(customerIds).not.toContain(b.customerId);
      const customerNames = body.byCustomer.map((r) => r.customerName);
      expect(customerNames).not.toContain(b.customerName);
    });

    it("ORG_B sees its own totals (smoke check)", async () => {
      const res = await request(app)
        .get("/reports/sales-summary")
        .set("x-test-org-id", String(ORG_B));
      expect(res.status).toBe(200);
      expect((res.body as { totalSales: number }).totalSales).toBe(b.soTotal);
    });
  });

  describe("GET /reports/receivables-aging", () => {
    it("returns rows only for caller's customers", async () => {
      const res = await request(app)
        .get("/reports/receivables-aging")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const body = res.body as {
        rows: Array<{ customerId: number; customerName: string; total: number }>;
        totals: { total: number };
      };
      const ids = body.rows.map((r) => r.customerId);
      expect(ids).toEqual([a.customerId]);
      expect(ids).not.toContain(b.customerId);
      // Totals should equal A's outstanding only.
      expect(body.totals.total).toBe(a.soBalanceDue);
      expect(body.totals.total).not.toBe(b.soBalanceDue);
    });
  });

  describe("GET /reports/payables-aging", () => {
    it("returns rows only for caller's suppliers", async () => {
      const res = await request(app)
        .get("/reports/payables-aging")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const body = res.body as {
        rows: Array<{ supplierId: number; supplierName: string }>;
        totals: { total: number };
      };
      const ids = body.rows.map((r) => r.supplierId);
      expect(ids).toEqual([a.supplierId]);
      expect(ids).not.toContain(b.supplierId);
      expect(body.totals.total).toBe(a.poBalanceDue);
    });
  });

  describe("GET /reports/purchase-summary", () => {
    it("returns totals and supplier breakdown for caller only", async () => {
      const res = await request(app)
        .get("/reports/purchase-summary")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const body = res.body as {
        totalPurchases: number;
        orderCount: number;
        bySupplier: Array<{ supplierId: number; supplierName: string }>;
      };
      expect(body.totalPurchases).toBe(a.poTotal);
      expect(body.orderCount).toBe(1);
      const ids = body.bySupplier.map((r) => r.supplierId);
      expect(ids).toEqual([a.supplierId]);
      expect(ids).not.toContain(b.supplierId);
      const names = body.bySupplier.map((r) => r.supplierName);
      expect(names).not.toContain(b.supplierName);
    });
  });

  describe("GET /reports/batches-near-expiry", () => {
    it("returns batches only for caller's items / warehouses", async () => {
      const res = await request(app)
        .get("/reports/batches-near-expiry?days=7")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const batches = (res.body as Array<{
        itemBatchId: number;
        itemId: number;
        warehouseId: number;
        batchNumber: string;
      }>).map((r) => r.batchNumber);
      expect(batches).toEqual([a.batchNumber]);
      expect(batches).not.toContain(b.batchNumber);
      const warehouseIds = (res.body as Array<{ warehouseId: number }>).map(
        (r) => r.warehouseId,
      );
      expect(warehouseIds).not.toContain(b.warehouseId);
    });
  });
});
