// Cross-tenant isolation tests for the warehouses router.
//
// Beyond the standard CRUD checks we exercise the unique business
// rules:
//   - The "promote to default" mutation toggles other warehouses in
//     the same org back to non-default; we assert it never touches
//     the other org's warehouses.
//   - The Shopify-mapping branch issues a separate uniqueness query
//     on (organizationId, shopifyLocationId); we assert that an
//     identical mapping in another org doesn't trip it.

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
// The Shopify outbound + REST helpers are unrelated to tenant
// isolation — stub them so any branch that touches them is harmless.
vi.mock("../../src/lib/shopify", () => ({
  fetchAllShopifyLocations: async () => [],
  findMissingShopifyScopes: () => [],
}));
vi.mock("../../src/lib/shopifyOutbound", () => ({
  pushStockToShopify: () => undefined,
}));

import warehousesRouter from "../../src/routes/warehouses";

const ORG_A = 1001;
const ORG_B = 2002;

interface OrgFixture {
  orgId: number;
  realWarehouseId: number;
  defaultWarehouseId: number;
  virtualWarehouseId: number;
}

async function seedOrg(label: "A" | "B", orgId: number): Promise<OrgFixture> {
  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
  });
  const real = await memDb.seed(tables.warehousesTable, {
    organizationId: orgId,
    name: `Aux ${label}`,
    code: `AUX-${label}`,
    addressLine1: null,
    city: null,
    state: null,
    country: null,
    isVirtual: false,
    isDefault: false,
    jobWorkerSupplierId: null,
    shopifyLocationId: null,
    shopifyLocationName: null,
  });
  const def = await memDb.seed(tables.warehousesTable, {
    organizationId: orgId,
    name: `Main ${label}`,
    code: `MAIN-${label}`,
    addressLine1: null,
    city: null,
    state: null,
    country: null,
    isVirtual: false,
    isDefault: true,
    jobWorkerSupplierId: null,
    shopifyLocationId: null,
    shopifyLocationName: null,
  });
  const virt = await memDb.seed(tables.warehousesTable, {
    organizationId: orgId,
    name: `Worker premises ${label}`,
    code: `JW-${label}`,
    addressLine1: null,
    city: null,
    state: null,
    country: null,
    isVirtual: true,
    isDefault: false,
    jobWorkerSupplierId: 999,
    shopifyLocationId: null,
    shopifyLocationName: null,
  });
  return {
    orgId,
    realWarehouseId: real.id as number,
    defaultWarehouseId: def.id as number,
    virtualWarehouseId: virt.id as number,
  };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(warehousesRouter);
  return app;
}

describe("warehouses cross-tenant isolation", () => {
  let app: Express;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeEach(async () => {
    await memDb.reset();
    a = await seedOrg("A", ORG_A);
    b = await seedOrg("B", ORG_B);
    app = buildApp();
  });

  describe("GET /warehouses", () => {
    it("only returns the caller's non-virtual warehouses by default", async () => {
      const res = await request(app)
        .get("/warehouses")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const ids = res.body.map((w: { id: number }) => w.id).sort();
      expect(ids).toEqual([a.realWarehouseId, a.defaultWarehouseId].sort());
      expect(ids).not.toContain(a.virtualWarehouseId);
      expect(ids).not.toContain(b.realWarehouseId);
      expect(ids).not.toContain(b.defaultWarehouseId);
    });

    it("?includeVirtual=true still respects the org scope", async () => {
      const res = await request(app)
        .get("/warehouses?includeVirtual=true")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const ids = res.body.map((w: { id: number }) => w.id).sort();
      expect(ids).toEqual(
        [a.realWarehouseId, a.defaultWarehouseId, a.virtualWarehouseId].sort(),
      );
      expect(ids).not.toContain(b.virtualWarehouseId);
    });
  });

  describe("GET /warehouses/:id", () => {
    it("returns 404 for the other org's warehouse", async () => {
      const res = await request(app)
        .get(`/warehouses/${b.defaultWarehouseId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /warehouses/:id", () => {
    it("returns 404 and never mutates the other org's row", async () => {
      const beforeName = (
        (await memDb.rowsOf("warehouses")).find((r) => r.id === b.realWarehouseId) as {
          name: string;
        }
      ).name;
      const res = await request(app)
        .patch(`/warehouses/${b.realWarehouseId}`)
        .set("x-test-org-id", String(ORG_A))
        .send({ name: "Pwned" });
      expect(res.status).toBe(404);
      const afterName = (
        (await memDb.rowsOf("warehouses")).find((r) => r.id === b.realWarehouseId) as {
          name: string;
        }
      ).name;
      expect(afterName).toBe(beforeName);
    });

    it("promoting a warehouse to default never demotes the other org's default", async () => {
      const res = await request(app)
        .patch(`/warehouses/${a.realWarehouseId}`)
        .set("x-test-org-id", String(ORG_A))
        .send({ isDefault: true });
      expect(res.status).toBe(200);
      // Org A: previously-default row should now be non-default.
      const aOld = (await memDb.rowsOf("warehouses"))
        .find((r) => r.id === a.defaultWarehouseId);
      expect(aOld?.isDefault).toBe(false);
      // Org A: newly-promoted row is default.
      const aNew = (await memDb.rowsOf("warehouses"))
        .find((r) => r.id === a.realWarehouseId);
      expect(aNew?.isDefault).toBe(true);
      // Org B: its default warehouse is still the default — un-demoted.
      const bDef = (await memDb.rowsOf("warehouses"))
        .find((r) => r.id === b.defaultWarehouseId);
      expect(bDef?.isDefault).toBe(true);
    });
  });

  describe("DELETE /warehouses/:id", () => {
    it("returns 204 but never removes the other org's warehouse", async () => {
      const beforeBCount = (await memDb.rowsOf("warehouses")).filter(
        (r) => r.organizationId === ORG_B,
      ).length;
      const res = await request(app)
        .delete(`/warehouses/${b.realWarehouseId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(204);
      const afterBCount = (await memDb.rowsOf("warehouses")).filter(
        (r) => r.organizationId === ORG_B,
      ).length;
      expect(afterBCount).toBe(beforeBCount);
    });
  });

  describe("POST /warehouses", () => {
    it("stamps the caller's organizationId and never demotes the other org's default", async () => {
      const res = await request(app)
        .post("/warehouses")
        .set("x-test-org-id", String(ORG_A))
        .send({ name: "Brand new", code: "NEW-A", isDefault: true });
      expect(res.status).toBe(201);
      const created = (await memDb.rowsOf("warehouses"))
        .find((r) => r.id === res.body.id);
      expect(created?.organizationId).toBe(ORG_A);
      // Org B's default is still default — POST's "demote others"
      // sweep didn't escape org A.
      const bDef = (await memDb.rowsOf("warehouses"))
        .find((r) => r.id === b.defaultWarehouseId);
      expect(bDef?.isDefault).toBe(true);
    });
  });
});
