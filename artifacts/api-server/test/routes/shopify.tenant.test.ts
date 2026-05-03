// Cross-tenant isolation tests for the /shopify router.

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
    getDefaultWarehouseId: async (orgId: number) => {
      const wh = (await memDb
        .rowsOf(tables.warehousesTable.__table))
        .find((r) => r.organizationId === orgId);
      return wh?.id ?? null;
    },
  };
});

vi.mock("../../src/lib/shopify", () => ({
  buildInstallUrl: (shop: string, state: string) =>
    `https://${shop}/admin/oauth/authorize?state=${state}`,
  fetchShopifyProducts: vi.fn(async () => []),
  fetchShopifyOrders: vi.fn(async () => []),
  fetchAllShopifyLocations: vi.fn(async () => []),
  findMissingShopifyScopes: () => [],
  normalizeShopifyDomain: (s: string) => s.trim().toLowerCase() || null,
}));

vi.mock("../../src/lib/shopifyOrderImport", () => ({
  importShopifyOrder: vi.fn(async () => "imported"),
}));

import shopifyRouter from "../../src/routes/shopify";

const ORG_A = 1001;
const ORG_B = 2002;

interface OrgFixture {
  orgId: number;
  warehouseId: number;
}

async function seedOrg(label: "A" | "B", orgId: number, connected: boolean): Promise<OrgFixture> {
  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
    shopifyShopDomain: connected ? `${label.toLowerCase()}-store.myshopify.com` : null,
    shopifyAccessToken: connected ? `tok_${label}` : null,
    shopifyScopes: connected ? "read_products,write_products" : null,
    shopifyLocationId: connected ? `loc_${label}` : null,
    shopifyLastSyncedAt: connected ? new Date() : null,
    shopifyProductCount: connected ? "5" : null,
  });
  await memDb.seed(tables.organizationMembersTable, {
    organizationId: orgId,
    userId: orgId * 10,
    role: "owner",
  });
  const wh = await memDb.seed(tables.warehousesTable, {
    organizationId: orgId,
    name: `WH ${label}`,
    code: `WH-${label}`,
    state: "Maharashtra",
    country: "IN",
    isVirtual: false,
    isDefault: true,
    shopifyLocationId: connected ? `loc_${label}` : null,
    shopifyLocationName: connected ? `Loc ${label}` : null,
  });
  await memDb.seed(tables.itemsTable, {
    organizationId: orgId,
    name: `Item ${label}`,
    sku: `SKU-${label}`,
    unit: "ea",
    salePrice: "100",
    purchasePrice: "50",
    taxRate: "0",
    shopifyProductId: connected ? `prod_${label}` : null,
    shopifyVariantId: connected ? `var_${label}` : null,
    shopifyInventoryItemId: connected ? `inv_${label}` : null,
  });
  return { orgId, warehouseId: wh.id as number };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(shopifyRouter);
  app.use(
    (
      err: Error,
      _req: Request,
      res: Response,
      _next: NextFunction,
    ): void => {
      res.status(500).json({ error: err.message });
    },
  );
  return app;
}

describe("shopify cross-tenant isolation", () => {
  let app: Express;

  beforeEach(async () => {
    await memDb.reset();
    await seedOrg("A", ORG_A, false); // ORG_A NOT connected
    await seedOrg("B", ORG_B, true); // ORG_B connected
    app = buildApp();
  });

  describe("auth", () => {
    it("rejects requests without x-test-org-id", async () => {
      const res = await request(app).get("/shopify/connection");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /shopify/connection", () => {
    it("ORG_A reports not connected", async () => {
      const res = await request(app)
        .get("/shopify/connection")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
      expect(res.body.shopDomain).toBeNull();
    });

    it("ORG_B reports its own connection only", async () => {
      const res = await request(app)
        .get("/shopify/connection")
        .set("x-test-org-id", String(ORG_B));
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      expect(res.body.shopDomain).toBe("b-store.myshopify.com");
      expect(res.body.totalWarehouseCount).toBe(1);
      expect(res.body.mappedWarehouseCount).toBe(1);
    });
  });

  describe("POST /shopify/oauth/install", () => {
    it("creates a state row only for the caller's org", async () => {
      const res = await request(app)
        .post("/shopify/oauth/install")
        .set("x-test-org-id", String(ORG_A))
        .send({ shopDomain: "a-store.myshopify.com" });
      expect(res.status).toBe(200);
      const states = (await memDb.rowsOf(tables.shopifyOauthStatesTable.__table));
      expect(states.length).toBe(1);
      expect(states[0]!.organizationId).toBe(ORG_A);
    });
  });

  describe("DELETE /shopify/connection", () => {
    it("ORG_A wiping has no effect on ORG_B's data", async () => {
      const res = await request(app)
        .delete("/shopify/connection")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(204);
      const orgs = (await memDb.rowsOf(tables.organizationsTable.__table));
      const aOrg = orgs.find((r) => r.id === ORG_A);
      const bOrg = orgs.find((r) => r.id === ORG_B);
      expect(aOrg?.shopifyAccessToken).toBeNull();
      expect(bOrg?.shopifyAccessToken).toBe("tok_B");
      expect(bOrg?.shopifyShopDomain).toBe("b-store.myshopify.com");

      const items = (await memDb.rowsOf(tables.itemsTable.__table));
      const bItem = items.find((r) => r.organizationId === ORG_B);
      expect(bItem?.shopifyProductId).toBe("prod_B");

      const warehouses = (await memDb.rowsOf(tables.warehousesTable.__table));
      const bWh = warehouses.find((r) => r.organizationId === ORG_B);
      expect(bWh?.shopifyLocationId).toBe("loc_B");
    });

    it("ORG_B wipes only its own connection", async () => {
      const res = await request(app)
        .delete("/shopify/connection")
        .set("x-test-org-id", String(ORG_B));
      expect(res.status).toBe(204);
      const items = (await memDb.rowsOf(tables.itemsTable.__table));
      const bItem = items.find((r) => r.organizationId === ORG_B);
      expect(bItem?.shopifyProductId).toBeNull();
      const warehouses = (await memDb.rowsOf(tables.warehousesTable.__table));
      const bWh = warehouses.find((r) => r.organizationId === ORG_B);
      expect(bWh?.shopifyLocationId).toBeNull();
    });
  });

  describe("POST /shopify/sync", () => {
    it("ORG_A (not connected) gets 400", async () => {
      const res = await request(app)
        .post("/shopify/sync")
        .set("x-test-org-id", String(ORG_A))
        .send({});
      expect(res.status).toBe(400);
    });

    it("ORG_B can sync; ORG_A's lastSyncedAt is unchanged", async () => {
      const beforeA = (await memDb
        .rowsOf(tables.organizationsTable.__table))
        .find((r) => r.id === ORG_A);
      const res = await request(app)
        .post("/shopify/sync")
        .set("x-test-org-id", String(ORG_B))
        .send({});
      expect(res.status).toBe(200);
      const afterA = (await memDb
        .rowsOf(tables.organizationsTable.__table))
        .find((r) => r.id === ORG_A);
      expect(afterA?.shopifyLastSyncedAt).toEqual(beforeA?.shopifyLastSyncedAt);
    });
  });
});
