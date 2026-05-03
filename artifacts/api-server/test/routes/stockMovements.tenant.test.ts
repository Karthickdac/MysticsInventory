// Cross-tenant isolation tests for the stock-movements router.
//
// The router only exposes a single GET endpoint, but it has a few
// branches that each need org-scoping verified:
//   - the unfiltered list,
//   - filters by ?itemId / ?warehouseId / ?referenceId,
//   - the ?purchaseOrderId branch which fans out to goods_receipts,
//   - the ?salesOrderId branch which fans out to shipments.
// Each branch should silently drop the other org's rows.

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
vi.mock("../../src/lib/tenant", () => ({
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
}));

import stockMovementsRouter from "../../src/routes/stockMovements";

const ORG_A = 1001;
const ORG_B = 2002;

interface OrgFixture {
  orgId: number;
  itemId: number;
  warehouseId: number;
  poId: number;
  goodsReceiptId: number;
  soId: number;
  shipmentId: number;
  // movement IDs
  poMovementId: number;
  grnMovementId: number;
  soMovementId: number;
  shipMovementId: number;
}

async function seedOrg(label: "A" | "B", orgId: number): Promise<OrgFixture> {
  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
  });
  const item = await memDb.seed(tables.itemsTable, {
    organizationId: orgId,
    name: `Item ${label}`,
    sku: `SKU-${label}`,
    hasVariants: false,
    isBundle: false,
    archivedAt: null,
  });
  const warehouse = await memDb.seed(tables.warehousesTable, {
    organizationId: orgId,
    name: `WH ${label}`,
    code: `WH-${label}`,
    isVirtual: false,
    isDefault: true,
  });
  // Both orgs share the same purchase-order id (5) and sales-order id
  // (7). This is the worst-case for the ?purchaseOrderId / ?salesOrderId
  // branches — without org-scoping the secondary lookup would happily
  // return the other org's children.
  const po = await memDb.seed(tables.purchaseOrdersTable, {
    id: orgId === ORG_A ? 5 : 5, // intentional collision
    organizationId: orgId,
    orderNumber: `PO-${label}-1`,
    supplierId: 1,
    warehouseId: warehouse.id,
    status: "open",
  });
  const grn = await memDb.seed(tables.goodsReceiptsTable, {
    organizationId: orgId,
    purchaseOrderId: po.id,
    receiptNumber: `GRN-${label}-1`,
    receivedDate: "2026-01-01",
    status: "received",
  });
  const so = await memDb.seed(tables.salesOrdersTable, {
    id: orgId === ORG_A ? 7 : 7, // intentional collision
    organizationId: orgId,
    orderNumber: `SO-${label}-1`,
    customerId: 1,
    warehouseId: warehouse.id,
    status: "open",
  });
  const ship = await memDb.seed(tables.shipmentsTable, {
    organizationId: orgId,
    salesOrderId: so.id,
    shipmentNumber: `SHIP-${label}-1`,
    status: "shipped",
  });
  // One movement per reference type so each branch has something to
  // either return or filter out.
  const poMov = await memDb.seed(tables.stockMovementsTable, {
    organizationId: orgId,
    itemId: item.id,
    warehouseId: warehouse.id,
    movementType: "in",
    quantity: "10",
    referenceType: "purchase_order",
    referenceId: po.id,
    notes: null,
  });
  const grnMov = await memDb.seed(tables.stockMovementsTable, {
    organizationId: orgId,
    itemId: item.id,
    warehouseId: warehouse.id,
    movementType: "in",
    quantity: "5",
    referenceType: "goods_receipt",
    referenceId: grn.id,
    notes: null,
  });
  const soMov = await memDb.seed(tables.stockMovementsTable, {
    organizationId: orgId,
    itemId: item.id,
    warehouseId: warehouse.id,
    movementType: "out",
    quantity: "3",
    referenceType: "sales_order",
    referenceId: so.id,
    notes: null,
  });
  const shipMov = await memDb.seed(tables.stockMovementsTable, {
    organizationId: orgId,
    itemId: item.id,
    warehouseId: warehouse.id,
    movementType: "out",
    quantity: "2",
    referenceType: "shipment",
    referenceId: ship.id,
    notes: null,
  });
  return {
    orgId,
    itemId: item.id as number,
    warehouseId: warehouse.id as number,
    poId: po.id as number,
    goodsReceiptId: grn.id as number,
    soId: so.id as number,
    shipmentId: ship.id as number,
    poMovementId: poMov.id as number,
    grnMovementId: grnMov.id as number,
    soMovementId: soMov.id as number,
    shipMovementId: shipMov.id as number,
  };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(stockMovementsRouter);
  return app;
}

describe("stock-movements cross-tenant isolation", () => {
  let app: Express;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeEach(async () => {
    await memDb.reset();
    a = await seedOrg("A", ORG_A);
    b = await seedOrg("B", ORG_B);
    app = buildApp();
  });

  it("unfiltered list only returns the caller's movements", async () => {
    const res = await request(app)
      .get("/stock-movements")
      .set("x-test-org-id", String(ORG_A));
    expect(res.status).toBe(200);
    const ids = res.body.map((m: { id: number }) => m.id).sort();
    expect(ids).toEqual(
      [a.poMovementId, a.grnMovementId, a.soMovementId, a.shipMovementId].sort(),
    );
    expect(ids).not.toContain(b.poMovementId);
    expect(ids).not.toContain(b.grnMovementId);
    expect(ids).not.toContain(b.soMovementId);
    expect(ids).not.toContain(b.shipMovementId);
  });

  it("?itemId filter returns nothing when the item belongs to the other org", async () => {
    // Pass org B's item id while authenticating as org A. Because
    // movements are also org-scoped, no rows should come back.
    const res = await request(app)
      .get(`/stock-movements?itemId=${b.itemId}`)
      .set("x-test-org-id", String(ORG_A));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("?purchaseOrderId fan-out never picks up the other org's GRN movements", async () => {
    // Both orgs have a PO with id=5. Caller is org A; if the
    // goods_receipts sub-query forgot the org filter it would return
    // org B's GRN id and pull org B's GRN movement into the result.
    const res = await request(app)
      .get(`/stock-movements?purchaseOrderId=${a.poId}`)
      .set("x-test-org-id", String(ORG_A));
    expect(res.status).toBe(200);
    const ids = res.body.map((m: { id: number }) => m.id).sort();
    expect(ids).toEqual([a.poMovementId, a.grnMovementId].sort());
    expect(ids).not.toContain(b.poMovementId);
    expect(ids).not.toContain(b.grnMovementId);
  });

  it("?salesOrderId fan-out never picks up the other org's shipment movements", async () => {
    const res = await request(app)
      .get(`/stock-movements?salesOrderId=${a.soId}`)
      .set("x-test-org-id", String(ORG_A));
    expect(res.status).toBe(200);
    const ids = res.body.map((m: { id: number }) => m.id).sort();
    expect(ids).toEqual([a.soMovementId, a.shipMovementId].sort());
    expect(ids).not.toContain(b.soMovementId);
    expect(ids).not.toContain(b.shipMovementId);
  });
});
