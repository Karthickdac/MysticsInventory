// Cross-tenant isolation tests for the purchase-orders router.
//
// Mirror of sales-orders on the AP side: list, detail, edit, delete,
// status transitions, and the return endpoint must all refuse to read
// or write the other org's rows. The detail loader joins suppliers,
// warehouses, and goods-receipts so we seed those for both orgs.

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
// `goodsReceipts` is imported eagerly for `loadGoodsReceiptsForOrder`,
// which in turn imports lib/batches.
vi.mock("../../src/lib/batches", () => ({
  applyBatchStockChange: vi.fn(),
  insertBatchMovement: vi.fn(),
  loadBatchMovementsForParents: vi.fn(async () => []),
  parseBatchInArray: vi.fn(() => ({ ok: true as const, rows: [] })),
  upsertBatchInTx: vi.fn(async () => undefined),
  isValidIsoDate: () => true,
}));

import purchaseOrdersRouter from "../../src/routes/purchaseOrders";

const ORG_A = 1001;
const ORG_B = 2002;

interface OrgFixture {
  orgId: number;
  supplierId: number;
  warehouseId: number;
  itemId: number;
  draftOrderId: number;
  receivedOrderId: number;
}

async function seedOrg(label: "A" | "B", orgId: number): Promise<OrgFixture> {
  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
  });
  const supplier = await memDb.seed(tables.suppliersTable, {
    organizationId: orgId,
    name: `Supplier ${label}`,
    isJobWorker: false,
    outstandingPayable: "0",
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
  const draft = await memDb.seed(tables.purchaseOrdersTable, {
    organizationId: orgId,
    orderNumber: `PO-${label}-1`,
    supplierId: supplier.id,
    warehouseId: warehouse.id,
    status: "draft",
    orderDate: "2026-01-01",
    expectedDeliveryDate: null,
    subtotal: "10",
    taxTotal: "0",
    total: "10",
    amountPaid: "0",
    balanceDue: "10",
    notes: null,
    jobWorkReceiptId: null,
  });
  await memDb.seed(tables.purchaseOrderLinesTable, {
    organizationId: orgId,
    purchaseOrderId: draft.id,
    itemId: item.id,
    description: null,
    quantity: "1",
    quantityReceived: "0",
    unitPrice: "10",
    taxRate: "0",
    lineSubtotal: "10",
    lineTax: "0",
    lineTotal: "10",
  });
  // A second order in `received` status so the return endpoint has a
  // valid target on the same org.
  const received = await memDb.seed(tables.purchaseOrdersTable, {
    organizationId: orgId,
    orderNumber: `PO-${label}-2`,
    supplierId: supplier.id,
    warehouseId: warehouse.id,
    status: "received",
    orderDate: "2026-01-02",
    expectedDeliveryDate: null,
    subtotal: "10",
    taxTotal: "0",
    total: "10",
    amountPaid: "0",
    balanceDue: "10",
    notes: null,
    jobWorkReceiptId: null,
  });
  await memDb.seed(tables.purchaseOrderLinesTable, {
    organizationId: orgId,
    purchaseOrderId: received.id,
    itemId: item.id,
    description: null,
    quantity: "1",
    quantityReceived: "1",
    unitPrice: "10",
    taxRate: "0",
    lineSubtotal: "10",
    lineTax: "0",
    lineTotal: "10",
  });
  return {
    orgId,
    supplierId: supplier.id as number,
    warehouseId: warehouse.id as number,
    itemId: item.id as number,
    draftOrderId: draft.id as number,
    receivedOrderId: received.id as number,
  };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(purchaseOrdersRouter);
  return app;
}

describe("purchase-orders cross-tenant isolation", () => {
  let app: Express;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeEach(async () => {
    await memDb.reset();
    a = await seedOrg("A", ORG_A);
    b = await seedOrg("B", ORG_B);
    app = buildApp();
  });

  describe("GET /purchase-orders", () => {
    it("only returns the caller's orders", async () => {
      const res = await request(app)
        .get("/purchase-orders")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ id: number }>)
        .map((r) => r.id)
        .sort((x, y) => x - y);
      expect(ids).toEqual(
        [a.draftOrderId, a.receivedOrderId].sort((x, y) => x - y),
      );
      expect(ids).not.toContain(b.draftOrderId);
      expect(ids).not.toContain(b.receivedOrderId);
    });
  });

  describe("GET /purchase-orders/:id", () => {
    it("returns 404 for the other org's order", async () => {
      const res = await request(app)
        .get(`/purchase-orders/${b.draftOrderId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /purchase-orders/:id", () => {
    it("returns 404 and never mutates the other org's draft", async () => {
      const before = JSON.stringify(
        (await memDb.rowsOf("purchase_orders")).find((r) => r.id === b.draftOrderId),
      );
      const res = await request(app)
        .patch(`/purchase-orders/${b.draftOrderId}`)
        .set("x-test-org-id", String(ORG_A))
        .send({ notes: "Hacked" });
      expect(res.status).toBe(404);
      const after = JSON.stringify(
        (await memDb.rowsOf("purchase_orders")).find((r) => r.id === b.draftOrderId),
      );
      expect(after).toBe(before);
    });
  });

  describe("DELETE /purchase-orders/:id", () => {
    it("returns 204 but never deletes the other org's row", async () => {
      const beforeCount = (await memDb.rowsOf("purchase_orders"))
        .filter((r) => r.organizationId === ORG_B).length;
      const res = await request(app)
        .delete(`/purchase-orders/${b.draftOrderId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(204);
      const afterCount = (await memDb.rowsOf("purchase_orders"))
        .filter((r) => r.organizationId === ORG_B).length;
      expect(afterCount).toBe(beforeCount);
    });
  });

  describe("PATCH /purchase-orders/:id/status", () => {
    it("returns 404 and never flips the other org's order status", async () => {
      const before = JSON.stringify(
        (await memDb.rowsOf("purchase_orders")).find((r) => r.id === b.draftOrderId),
      );
      const res = await request(app)
        .patch(`/purchase-orders/${b.draftOrderId}/status`)
        .set("x-test-org-id", String(ORG_A))
        .send({ status: "cancelled" });
      expect(res.status).toBe(404);
      const after = JSON.stringify(
        (await memDb.rowsOf("purchase_orders")).find((r) => r.id === b.draftOrderId),
      );
      expect(after).toBe(before);
    });
  });

  describe("POST /purchase-orders/:id/return", () => {
    it("returns 404 and never moves stock for the other org", async () => {
      const beforeMovements = (await memDb.rowsOf("stock_movements")).length;
      const res = await request(app)
        .post(`/purchase-orders/${b.receivedOrderId}/return`)
        .set("x-test-org-id", String(ORG_A))
        .send({});
      expect(res.status).toBe(404);
      expect((await memDb.rowsOf("stock_movements")).length).toBe(beforeMovements);
    });
  });

  describe("POST /purchase-orders", () => {
    it("rejects when supplier / warehouse belong to the other org", async () => {
      const beforeCount = (await memDb.rowsOf("purchase_orders"))
        .filter((r) => r.organizationId === ORG_B).length;
      const res = await request(app)
        .post("/purchase-orders")
        .set("x-test-org-id", String(ORG_A))
        .send({
          supplierId: b.supplierId,
          warehouseId: b.warehouseId,
          orderDate: "2026-04-01",
          lines: [{ itemId: b.itemId, quantity: 1, unitPrice: 10 }],
        });
      expect(res.status).toBe(400);
      expect(
        (await memDb.rowsOf("purchase_orders"))
          .filter((r) => r.organizationId === ORG_B).length,
      ).toBe(beforeCount);
    });
  });
});
