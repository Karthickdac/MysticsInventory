// Cross-tenant isolation tests for the items router.
//
// Items is the broadest inventory router and the easiest place for an
// org-scoping bug to leak: the catalog list, the barcode/sku lookup
// (which is hit by every barcode scanner), the detail/batches/variants
// endpoints, and the per-item mutations all need to refuse to surface
// or touch the other org's rows. We seed two orgs with deliberately
// colliding barcodes/skus so the lookup branch is forced through the
// org filter.

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

import itemsRouter from "../../src/routes/items";

const ORG_A = 1001;
const ORG_B = 2002;

interface OrgFixture {
  orgId: number;
  warehouseId: number;
  itemId: number;
  // an item whose name + sku + barcode collide with the other org's
  // — used by the search/lookup tests.
  collisionItemId: number;
  // a parent + variant pair so we can hit the variant endpoints.
  parentItemId: number;
  variantItemId: number;
}

async function seedOrg(label: "A" | "B", orgId: number): Promise<OrgFixture> {
  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
  });
  const warehouse = await memDb.seed(tables.warehousesTable, {
    organizationId: orgId,
    name: `WH ${label}`,
    code: `WH-${label}`,
    isVirtual: false,
    isDefault: true,
  });
  // A normal item per org.
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
  // Both orgs share the SAME sku (`SHARED-SKU`) and SAME barcode
  // (`BAR-1`) on this row. The lookup endpoint *must* return the
  // caller's row, never the other org's, even though the sku/barcode
  // would otherwise match both.
  const collision = await memDb.seed(tables.itemsTable, {
    organizationId: orgId,
    name: `Acme Widget ${label}`,
    sku: "SHARED-SKU",
    description: null,
    category: null,
    unit: "ea",
    barcode: "BAR-1",
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
  // Parent + variant pair.
  const parent = await memDb.seed(tables.itemsTable, {
    organizationId: orgId,
    name: `Parent ${label}`,
    sku: `PARENT-${label}`,
    description: null,
    category: null,
    unit: "ea",
    barcode: null,
    salePrice: "0",
    purchasePrice: "0",
    hsnCode: null,
    taxRate: "0",
    reorderLevel: "0",
    imageUrl: null,
    hasVariants: true,
    isBundle: false,
    trackBatches: false,
    parentItemId: null,
    variantOptions: { axes: ["Size"] },
    archivedAt: null,
  });
  const variant = await memDb.seed(tables.itemsTable, {
    organizationId: orgId,
    name: `Parent ${label} / S`,
    sku: `PARENT-${label}-S`,
    description: null,
    category: null,
    unit: "ea",
    barcode: null,
    salePrice: "0",
    purchasePrice: "0",
    hsnCode: null,
    taxRate: "0",
    reorderLevel: "0",
    imageUrl: null,
    hasVariants: false,
    isBundle: false,
    trackBatches: false,
    parentItemId: parent.id,
    variantOptions: { Size: "S" },
    archivedAt: null,
  });
  return {
    orgId,
    warehouseId: warehouse.id as number,
    itemId: item.id as number,
    collisionItemId: collision.id as number,
    parentItemId: parent.id as number,
    variantItemId: variant.id as number,
  };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(itemsRouter);
  return app;
}

describe("items cross-tenant isolation", () => {
  let app: Express;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeEach(async () => {
    await memDb.reset();
    a = await seedOrg("A", ORG_A);
    b = await seedOrg("B", ORG_B);
    app = buildApp();
  });

  describe("GET /items", () => {
    it("only returns the caller's items", async () => {
      const res = await request(app)
        .get("/items")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ id: number }>).map((r) => r.id);
      expect(new Set(ids)).toEqual(
        new Set([a.itemId, a.collisionItemId, a.parentItemId, a.variantItemId]),
      );
      expect(ids).not.toContain(b.itemId);
      expect(ids).not.toContain(b.collisionItemId);
    });

    it("?search= filter never crosses org boundaries", async () => {
      // Both orgs have an "Acme Widget …" row. Searching "Acme" as
      // org A should only surface org A's row.
      const res = await request(app)
        .get("/items?search=Acme")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ id: number }>).map((r) => r.id);
      expect(ids).toEqual([a.collisionItemId]);
      expect(ids).not.toContain(b.collisionItemId);
    });
  });

  describe("GET /items/lookup", () => {
    it("a colliding barcode resolves to the caller's row only", async () => {
      // Both orgs have an item with barcode BAR-1. Without org-scoping
      // the lookup would non-deterministically pick the wrong row.
      const resA = await request(app)
        .get("/items/lookup?code=BAR-1")
        .set("x-test-org-id", String(ORG_A));
      expect(resA.status).toBe(200);
      expect(resA.body.id).toBe(a.collisionItemId);

      const resB = await request(app)
        .get("/items/lookup?code=BAR-1")
        .set("x-test-org-id", String(ORG_B));
      expect(resB.status).toBe(200);
      expect(resB.body.id).toBe(b.collisionItemId);
    });

    it("a colliding sku resolves to the caller's row only", async () => {
      const resA = await request(app)
        .get("/items/lookup?code=SHARED-SKU")
        .set("x-test-org-id", String(ORG_A));
      expect(resA.status).toBe(200);
      expect(resA.body.id).toBe(a.collisionItemId);
    });
  });

  describe("GET /items/:id", () => {
    it("returns 404 when fetching the other org's item", async () => {
      const resA = await request(app)
        .get(`/items/${b.itemId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(resA.status).toBe(404);
    });
  });

  describe("GET /items/:id/batches", () => {
    it("returns 404 when fetching the other org's item", async () => {
      const resA = await request(app)
        .get(`/items/${b.itemId}/batches`)
        .set("x-test-org-id", String(ORG_A));
      expect(resA.status).toBe(404);
    });
  });

  describe("PATCH /items/:id", () => {
    it("returns 404 and never mutates the other org's row", async () => {
      const beforeName = (
        (await memDb.rowsOf("items")).find((r) => r.id === b.itemId) as { name: string }
      ).name;
      const res = await request(app)
        .patch(`/items/${b.itemId}`)
        .set("x-test-org-id", String(ORG_A))
        .send({ name: "Hacked" });
      expect(res.status).toBe(404);
      const afterName = (
        (await memDb.rowsOf("items")).find((r) => r.id === b.itemId) as { name: string }
      ).name;
      expect(afterName).toBe(beforeName);
    });
  });

  describe("DELETE /items/:id", () => {
    it("returns 204 but never archives the other org's row", async () => {
      // The route returns 204 even when the row is missing for the
      // caller's org (idempotent UI). We assert that the other org's
      // row remains un-archived.
      const res = await request(app)
        .delete(`/items/${b.itemId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(204);
      const row = (await memDb.rowsOf("items")).find((r) => r.id === b.itemId) as {
        archivedAt: Date | null;
      };
      expect(row.archivedAt).toBeNull();
    });
  });

  describe("DELETE /items/:parentId/variants/:variantId", () => {
    it("returns 404 and never archives the other org's variant", async () => {
      const res = await request(app)
        .delete(`/items/${b.parentItemId}/variants/${b.variantItemId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
      const row = (await memDb.rowsOf("items"))
        .find((r) => r.id === b.variantItemId) as { archivedAt: Date | null };
      expect(row.archivedAt).toBeNull();
    });
  });

  describe("POST /items/:id/variants", () => {
    it("returns 404 and never adds a child to the other org's parent", async () => {
      const beforeBChildren = (await memDb.rowsOf("items"))
        .filter((r) => r.parentItemId === b.parentItemId).length;
      const res = await request(app)
        .post(`/items/${b.parentItemId}/variants`)
        .set("x-test-org-id", String(ORG_A))
        .send({
          variants: [
            {
              sku: "INTRUDER-S",
              name: "Intruder / S",
              variantOptions: { Size: "S" },
            },
          ],
        });
      expect(res.status).toBe(404);
      const afterBChildren = (await memDb.rowsOf("items"))
        .filter((r) => r.parentItemId === b.parentItemId).length;
      expect(afterBChildren).toBe(beforeBChildren);
    });
  });

  describe("POST /items/:id/adjust-stock", () => {
    it("returns 404 and never moves stock for the other org's item", async () => {
      const beforeBStock = (await memDb.rowsOf("item_warehouse_stock"))
        .filter((r) => r.itemId === b.itemId).length;
      const beforeBMovements = (await memDb.rowsOf("stock_movements"))
        .filter((r) => r.itemId === b.itemId).length;
      const res = await request(app)
        .post(`/items/${b.itemId}/adjust-stock`)
        .set("x-test-org-id", String(ORG_A))
        .send({
          warehouseId: b.warehouseId,
          quantity: 10,
          reason: "adjustment",
        });
      expect(res.status).toBe(404);
      expect(
        (await memDb.rowsOf("item_warehouse_stock")).filter((r) => r.itemId === b.itemId)
          .length,
      ).toBe(beforeBStock);
      expect(
        (await memDb.rowsOf("stock_movements")).filter((r) => r.itemId === b.itemId)
          .length,
      ).toBe(beforeBMovements);
    });
  });

  describe("POST /items", () => {
    it("stamps the caller's organizationId regardless of body input", async () => {
      const beforeBCount = (await memDb.rowsOf("items"))
        .filter((r) => r.organizationId === ORG_B).length;
      const res = await request(app)
        .post("/items")
        .set("x-test-org-id", String(ORG_A))
        .send({
          sku: "NEW-A",
          name: "New A",
          unit: "ea",
          organizationId: ORG_B,
        });
      expect(res.status).toBe(201);
      const newRow = (await memDb.rowsOf("items")).find((r) => r.id === res.body.id);
      expect(newRow?.organizationId).toBe(ORG_A);
      // Org B's count is exactly the same — no leakage.
      const afterBCount = (await memDb.rowsOf("items"))
        .filter((r) => r.organizationId === ORG_B).length;
      expect(afterBCount).toBe(beforeBCount);
    });
  });
});
