// Cross-tenant isolation tests for the goods-receipts router.
//
// Goods-receipts is mounted under /purchase-orders/:id/goods-receipts and
// /goods-receipts/:goodsReceiptId/cancel. The list and create endpoints
// must reject when the parent purchase order belongs to the other org;
// the cancel endpoint must reject when the receipt itself belongs to the
// other org. Each path is exercised here with the same two-org fixture.

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
  parseBatchInArray: vi.fn(() => ({ ok: true as const, rows: [] })),
  upsertBatchInTx: vi.fn(async () => undefined),
  isValidIsoDate: () => true,
}));

import goodsReceiptsRouter from "../../src/routes/goodsReceipts";

const ORG_A = 1001;
const ORG_B = 2002;

interface OrgFixture {
  orgId: number;
  supplierId: number;
  warehouseId: number;
  itemId: number;
  purchaseOrderId: number;
  purchaseOrderLineId: number;
  goodsReceiptId: number;
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
  const order = await memDb.seed(tables.purchaseOrdersTable, {
    organizationId: orgId,
    orderNumber: `PO-${label}-1`,
    supplierId: supplier.id,
    warehouseId: warehouse.id,
    status: "partially_received",
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
  const orderLine = await memDb.seed(tables.purchaseOrderLinesTable, {
    organizationId: orgId,
    purchaseOrderId: order.id,
    itemId: item.id,
    description: null,
    quantity: "10",
    quantityReceived: "5",
    unitPrice: "10",
    taxRate: "0",
    lineSubtotal: "100",
    lineTax: "0",
    lineTotal: "100",
  });
  const receipt = await memDb.seed(tables.goodsReceiptsTable, {
    organizationId: orgId,
    purchaseOrderId: order.id,
    receiptNumber: `GR-${label}-1`,
    status: "received",
    receivedDate: "2026-01-02",
    notes: null,
  });
  await memDb.seed(tables.goodsReceiptLinesTable, {
    organizationId: orgId,
    goodsReceiptId: receipt.id,
    purchaseOrderLineId: orderLine.id,
    quantity: "5",
  });
  return {
    orgId,
    supplierId: supplier.id as number,
    warehouseId: warehouse.id as number,
    itemId: item.id as number,
    purchaseOrderId: order.id as number,
    purchaseOrderLineId: orderLine.id as number,
    goodsReceiptId: receipt.id as number,
  };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(goodsReceiptsRouter);
  return app;
}

describe("goods-receipts cross-tenant isolation", () => {
  let app: Express;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeEach(async () => {
    await memDb.reset();
    a = await seedOrg("A", ORG_A);
    b = await seedOrg("B", ORG_B);
    app = buildApp();
  });

  describe("GET /purchase-orders/:id/goods-receipts", () => {
    it("returns 404 when the parent PO belongs to the other org", async () => {
      const res = await request(app)
        .get(`/purchase-orders/${b.purchaseOrderId}/goods-receipts`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
    });

    it("only returns the caller's receipts for their own PO", async () => {
      const res = await request(app)
        .get(`/purchase-orders/${a.purchaseOrderId}/goods-receipts`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ id: number }>).map((r) => r.id);
      expect(ids).toEqual([a.goodsReceiptId]);
      expect(ids).not.toContain(b.goodsReceiptId);
    });
  });

  describe("POST /purchase-orders/:id/goods-receipts", () => {
    it("returns 404 and never inserts a receipt against the other org's PO", async () => {
      const beforeCount = (await memDb.rowsOf("goods_receipts"))
        .filter((r) => r.purchaseOrderId === b.purchaseOrderId).length;
      const res = await request(app)
        .post(`/purchase-orders/${b.purchaseOrderId}/goods-receipts`)
        .set("x-test-org-id", String(ORG_A))
        .send({
          receivedDate: "2026-02-01",
          lines: [
            { purchaseOrderLineId: b.purchaseOrderLineId, quantity: 1 },
          ],
        });
      expect(res.status).toBe(404);
      expect(
        (await memDb.rowsOf("goods_receipts"))
          .filter((r) => r.purchaseOrderId === b.purchaseOrderId).length,
      ).toBe(beforeCount);
    });
  });

  describe("POST /goods-receipts/:goodsReceiptId/cancel", () => {
    it("returns 404 and never cancels the other org's receipt", async () => {
      const before = JSON.stringify(
        (await memDb.rowsOf("goods_receipts"))
          .find((r) => r.id === b.goodsReceiptId),
      );
      const res = await request(app)
        .post(`/goods-receipts/${b.goodsReceiptId}/cancel`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
      const after = JSON.stringify(
        (await memDb.rowsOf("goods_receipts"))
          .find((r) => r.id === b.goodsReceiptId),
      );
      expect(after).toBe(before);
    });
  });
});
