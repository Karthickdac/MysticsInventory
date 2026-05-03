// Cross-tenant isolation tests for the shipments router.
//
// Mirror of goods-receipts on the AR side: shipments are mounted under
// /sales-orders/:id/shipments and /shipments/:shipmentId/cancel. The
// list / create endpoints must reject when the parent sales order
// belongs to the other org; the cancel endpoint must reject when the
// shipment row itself belongs to the other org.

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
    tenantMiddleware: (req: Request, _res: Response, next: NextFunction) => {
      const orgId = Number(req.header("x-test-org-id"));
      if (!Number.isFinite(orgId) || orgId <= 0) {
        _res.status(401).json({ error: "missing x-test-org-id header" });
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
vi.mock("../../src/lib/shopifyOutbound", () => ({
  pushStockToShopify: vi.fn(),
}));
vi.mock("../../src/lib/batches", () => ({
  applyBatchStockChange: vi.fn(),
  insertBatchMovement: vi.fn(),
  loadBatchMovementsForParents: vi.fn(async () => []),
  parseBatchPicks: vi.fn(() => ({ ok: true as const, rows: [] })),
}));

import shipmentsRouter from "../../src/routes/shipments";

const ORG_A = 1001;
const ORG_B = 2002;

interface OrgFixture {
  orgId: number;
  customerId: number;
  warehouseId: number;
  itemId: number;
  salesOrderId: number;
  salesOrderLineId: number;
  shipmentId: number;
}

async function seedOrg(label: "A" | "B", orgId: number): Promise<OrgFixture> {
  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
  });
  const customer = await memDb.seed(tables.customersTable, {
    organizationId: orgId,
    name: `Customer ${label}`,
    email: null,
    phone: null,
    company: null,
    gstNumber: null,
    billingAddress: null,
    shippingAddress: null,
    placeOfSupply: null,
    notes: null,
    outstandingBalance: "0",
  });
  const warehouse = await memDb.seed(tables.warehousesTable, {
    organizationId: orgId,
    name: `WH ${label}`,
    code: `WH-${label}`,
    isVirtual: false,
    isDefault: true,
  });
  const item = await memDb.seed(tables.itemsTable, {
    organizationId: orgId,
    name: `Item ${label}`,
    sku: `SKU-${label}`,
    description: null,
    category: null,
    unit: "ea",
    barcode: null,
    salePrice: "10",
    purchasePrice: "5",
    hsnCode: null,
    taxRate: "0",
    reorderLevel: "0",
    imageUrl: null,
    hasVariants: false,
    isBundle: false,
    trackBatches: false,
    parentItemId: null,
    variantOptions: null,
    archivedAt: null,
  });
  const order = await memDb.seed(tables.salesOrdersTable, {
    organizationId: orgId,
    orderNumber: `SO-${label}-1`,
    customerId: customer.id,
    warehouseId: warehouse.id,
    status: "partially_shipped",
    orderDate: "2026-01-01",
    expectedShipDate: null,
    subtotal: "100",
    taxTotal: "0",
    total: "100",
    amountPaid: "0",
    balanceDue: "100",
    notes: null,
  });
  const orderLine = await memDb.seed(tables.salesOrderLinesTable, {
    organizationId: orgId,
    salesOrderId: order.id,
    itemId: item.id,
    description: null,
    quantity: "10",
    quantityShipped: "5",
    unitPrice: "10",
    taxRate: "0",
    lineSubtotal: "100",
    lineTax: "0",
    lineTotal: "100",
  });
  const shipment = await memDb.seed(tables.shipmentsTable, {
    organizationId: orgId,
    salesOrderId: order.id,
    shipmentNumber: `SH-${label}-1`,
    status: "shipped",
    shipDate: "2026-01-02",
    notes: null,
  });
  await memDb.seed(tables.shipmentLinesTable, {
    organizationId: orgId,
    shipmentId: shipment.id,
    salesOrderLineId: orderLine.id,
    quantity: "5",
  });
  return {
    orgId,
    customerId: customer.id as number,
    warehouseId: warehouse.id as number,
    itemId: item.id as number,
    salesOrderId: order.id as number,
    salesOrderLineId: orderLine.id as number,
    shipmentId: shipment.id as number,
  };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(shipmentsRouter);
  return app;
}

describe("shipments cross-tenant isolation", () => {
  let app: Express;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeEach(async () => {
    await memDb.reset();
    a = await seedOrg("A", ORG_A);
    b = await seedOrg("B", ORG_B);
    app = buildApp();
  });

  describe("GET /sales-orders/:id/shipments", () => {
    it("returns 404 when the parent SO belongs to the other org", async () => {
      const res = await request(app)
        .get(`/sales-orders/${b.salesOrderId}/shipments`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
    });

    it("only returns the caller's shipments for their own SO", async () => {
      const res = await request(app)
        .get(`/sales-orders/${a.salesOrderId}/shipments`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ id: number }>).map((r) => r.id);
      expect(ids).toEqual([a.shipmentId]);
      expect(ids).not.toContain(b.shipmentId);
    });
  });

  describe("POST /sales-orders/:id/shipments", () => {
    it("returns 404 and never inserts a shipment against the other org's SO", async () => {
      const beforeCount = (await memDb.rowsOf("shipments"))
        .filter((r) => r.salesOrderId === b.salesOrderId).length;
      const res = await request(app)
        .post(`/sales-orders/${b.salesOrderId}/shipments`)
        .set("x-test-org-id", String(ORG_A))
        .send({
          shipDate: "2026-02-01",
          lines: [
            { salesOrderLineId: b.salesOrderLineId, quantity: 1 },
          ],
        });
      expect(res.status).toBe(404);
      expect(
        (await memDb.rowsOf("shipments"))
          .filter((r) => r.salesOrderId === b.salesOrderId).length,
      ).toBe(beforeCount);
    });
  });

  describe("POST /shipments/:shipmentId/cancel", () => {
    it("returns 404 and never cancels the other org's shipment", async () => {
      const before = JSON.stringify(
        (await memDb.rowsOf("shipments")).find((r) => r.id === b.shipmentId),
      );
      const res = await request(app)
        .post(`/shipments/${b.shipmentId}/cancel`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
      const after = JSON.stringify(
        (await memDb.rowsOf("shipments")).find((r) => r.id === b.shipmentId),
      );
      expect(after).toBe(before);
    });
  });
});
