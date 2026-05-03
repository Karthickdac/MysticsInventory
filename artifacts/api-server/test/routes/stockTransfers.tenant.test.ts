// Cross-tenant isolation tests for the stock-transfers router.
//
// Stock-transfers is a multi-stage workflow (draft → in_transit → completed
// or cancelled) where every stage takes locks on the transfer row plus its
// source/destination warehouse stock. Each transition must refuse to surface
// or touch the other org's transfer, and the create flow must always stamp
// the caller's organizationId regardless of body input.

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
// The cross-tenant tests never reach the per-batch fan-out, but the route
// imports these eagerly so we stub them with safe no-ops.
vi.mock("../../src/lib/batches", () => ({
  applyBatchStockChange: vi.fn(),
  insertBatchMovement: vi.fn(),
  loadBatchMovementsForParents: vi.fn(async () => []),
  parseBatchPicks: vi.fn(() => ({ ok: true as const, rows: [] })),
}));

import stockTransfersRouter from "../../src/routes/stockTransfers";

const ORG_A = 1001;
const ORG_B = 2002;

interface OrgFixture {
  orgId: number;
  fromWarehouseId: number;
  toWarehouseId: number;
  itemId: number;
  // A draft transfer (editable / dispatchable / cancellable).
  draftTransferId: number;
  // An in-transit transfer (completable / cancellable).
  inTransitTransferId: number;
}

async function seedOrg(label: "A" | "B", orgId: number): Promise<OrgFixture> {
  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
  });
  const fromWh = await memDb.seed(tables.warehousesTable, {
    organizationId: orgId,
    name: `WH-FROM-${label}`,
    code: `F-${label}`,
    isVirtual: false,
    isDefault: true,
  });
  const toWh = await memDb.seed(tables.warehousesTable, {
    organizationId: orgId,
    name: `WH-TO-${label}`,
    code: `T-${label}`,
    isVirtual: false,
    isDefault: false,
  });
  const item = await memDb.seed(tables.itemsTable, {
    organizationId: orgId,
    name: `Item ${label}`,
    sku: `SKU-${label}`,
    description: null,
    category: null,
    unit: "ea",
    barcode: null,
    salePrice: "1",
    purchasePrice: "1",
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
  const draft = await memDb.seed(tables.stockTransfersTable, {
    organizationId: orgId,
    transferNumber: `TRF-${label}-1`,
    fromWarehouseId: fromWh.id,
    toWarehouseId: toWh.id,
    status: "draft",
    transferDate: "2026-01-01",
    notes: null,
  });
  await memDb.seed(tables.stockTransferLinesTable, {
    organizationId: orgId,
    stockTransferId: draft.id,
    itemId: item.id,
    quantity: "5",
  });
  const inTransit = await memDb.seed(tables.stockTransfersTable, {
    organizationId: orgId,
    transferNumber: `TRF-${label}-2`,
    fromWarehouseId: fromWh.id,
    toWarehouseId: toWh.id,
    status: "in_transit",
    transferDate: "2026-01-02",
    notes: null,
  });
  await memDb.seed(tables.stockTransferLinesTable, {
    organizationId: orgId,
    stockTransferId: inTransit.id,
    itemId: item.id,
    quantity: "3",
  });
  return {
    orgId,
    fromWarehouseId: fromWh.id as number,
    toWarehouseId: toWh.id as number,
    itemId: item.id as number,
    draftTransferId: draft.id as number,
    inTransitTransferId: inTransit.id as number,
  };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(stockTransfersRouter);
  return app;
}

describe("stock-transfers cross-tenant isolation", () => {
  let app: Express;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeEach(async () => {
    await memDb.reset();
    a = await seedOrg("A", ORG_A);
    b = await seedOrg("B", ORG_B);
    app = buildApp();
  });

  describe("GET /stock-transfers", () => {
    it("only returns the caller's transfers", async () => {
      const res = await request(app)
        .get("/stock-transfers")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ id: number }>)
        .map((r) => r.id)
        .sort((x, y) => x - y);
      expect(ids).toEqual(
        [a.draftTransferId, a.inTransitTransferId].sort((x, y) => x - y),
      );
      expect(ids).not.toContain(b.draftTransferId);
      expect(ids).not.toContain(b.inTransitTransferId);
    });
  });

  describe("GET /stock-transfers/:id", () => {
    it("returns 404 for the other org's transfer", async () => {
      const res = await request(app)
        .get(`/stock-transfers/${b.draftTransferId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /stock-transfers/:id", () => {
    it("returns 404 and never mutates the other org's draft", async () => {
      const before = JSON.stringify(
        (await memDb.rowsOf("stock_transfers"))
          .find((r) => r.id === b.draftTransferId),
      );
      const res = await request(app)
        .patch(`/stock-transfers/${b.draftTransferId}`)
        .set("x-test-org-id", String(ORG_A))
        .send({ notes: "Hacked" });
      expect(res.status).toBe(404);
      const after = JSON.stringify(
        (await memDb.rowsOf("stock_transfers"))
          .find((r) => r.id === b.draftTransferId),
      );
      expect(after).toBe(before);
    });
  });

  describe("DELETE /stock-transfers/:id", () => {
    it("returns 404 and never deletes the other org's transfer", async () => {
      const beforeCount = (await memDb.rowsOf("stock_transfers"))
        .filter((r) => r.organizationId === ORG_B).length;
      const res = await request(app)
        .delete(`/stock-transfers/${b.draftTransferId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
      const afterCount = (await memDb.rowsOf("stock_transfers"))
        .filter((r) => r.organizationId === ORG_B).length;
      expect(afterCount).toBe(beforeCount);
    });
  });

  describe("POST /stock-transfers/:id/dispatch", () => {
    it("returns 404 and never flips the other org's draft to in_transit", async () => {
      const before = JSON.stringify(
        (await memDb.rowsOf("stock_transfers"))
          .find((r) => r.id === b.draftTransferId),
      );
      const res = await request(app)
        .post(`/stock-transfers/${b.draftTransferId}/dispatch`)
        .set("x-test-org-id", String(ORG_A))
        .send({});
      expect(res.status).toBe(404);
      const after = JSON.stringify(
        (await memDb.rowsOf("stock_transfers"))
          .find((r) => r.id === b.draftTransferId),
      );
      expect(after).toBe(before);
    });
  });

  describe("POST /stock-transfers/:id/complete", () => {
    it("returns 404 and never flips the other org's transfer to completed", async () => {
      const before = JSON.stringify(
        (await memDb.rowsOf("stock_transfers"))
          .find((r) => r.id === b.inTransitTransferId),
      );
      const res = await request(app)
        .post(`/stock-transfers/${b.inTransitTransferId}/complete`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
      const after = JSON.stringify(
        (await memDb.rowsOf("stock_transfers"))
          .find((r) => r.id === b.inTransitTransferId),
      );
      expect(after).toBe(before);
    });
  });

  describe("POST /stock-transfers/:id/cancel", () => {
    it("returns 404 and never cancels the other org's draft", async () => {
      const before = JSON.stringify(
        (await memDb.rowsOf("stock_transfers"))
          .find((r) => r.id === b.draftTransferId),
      );
      const res = await request(app)
        .post(`/stock-transfers/${b.draftTransferId}/cancel`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
      const after = JSON.stringify(
        (await memDb.rowsOf("stock_transfers"))
          .find((r) => r.id === b.draftTransferId),
      );
      expect(after).toBe(before);
    });
  });

  describe("POST /stock-transfers", () => {
    it("rejects when warehouses belong to the other org", async () => {
      const beforeCount = (await memDb.rowsOf("stock_transfers"))
        .filter((r) => r.organizationId === ORG_B).length;
      const res = await request(app)
        .post("/stock-transfers")
        .set("x-test-org-id", String(ORG_A))
        .send({
          fromWarehouseId: b.fromWarehouseId,
          toWarehouseId: b.toWarehouseId,
          transferDate: "2026-04-01",
          lines: [{ itemId: a.itemId, quantity: 1 }],
        });
      expect(res.status).toBe(400);
      // No transfer was created.
      expect(
        (await memDb.rowsOf("stock_transfers"))
          .filter((r) => r.organizationId === ORG_B).length,
      ).toBe(beforeCount);
    });

    it("stamps the caller's orgId regardless of body input", async () => {
      const res = await request(app)
        .post("/stock-transfers")
        .set("x-test-org-id", String(ORG_A))
        .send({
          fromWarehouseId: a.fromWarehouseId,
          toWarehouseId: a.toWarehouseId,
          transferDate: "2026-04-01",
          lines: [{ itemId: a.itemId, quantity: 1 }],
          organizationId: ORG_B,
        });
      expect(res.status).toBe(201);
      const created = (await memDb.rowsOf("stock_transfers"))
        .find((r) => r.id === res.body.transfer.id);
      expect(created?.organizationId).toBe(ORG_A);
    });
  });
});
