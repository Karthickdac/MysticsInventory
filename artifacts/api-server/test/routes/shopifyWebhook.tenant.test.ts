// Cross-tenant isolation tests for the public Shopify webhook.
//
// The route is unauthenticated — it identifies the owning org by
// `x-shopify-shop-domain`. These tests confirm:
//   * A forged HMAC is rejected with 401, no writes.
//   * Webhooks for an unknown shop are silently dropped.
//   * An inventory_levels/update payload referencing org A's
//     inventory ids cannot touch org A's stock when the request
//     arrives under org B's shop domain.
//   * app/uninstalled only wipes the matching org's connection.

import crypto from "node:crypto";

process.env.SHOPIFY_API_SECRET = "test_shopify_secret";
process.env.SHOPIFY_API_KEY = "test_shopify_key";
process.env.SHOPIFY_APP_URL = "https://example.test";

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
  const actual = await vi.importActual<typeof import("../../src/lib/tenant")>(
    "../../src/lib/tenant",
  );
  return {
    ...actual,
    getDefaultWarehouseId: async (orgId: number) => {
      const wh = (await memDb
        .rowsOf(tables.warehousesTable.__table))
        .find((r) => r.organizationId === orgId && r.isDefault);
      return wh?.id ?? null;
    },
  };
});

const { importShopifyOrderMock } = vi.hoisted(() => ({
  importShopifyOrderMock: vi.fn(async () => "imported"),
}));
vi.mock("../../src/lib/shopifyOrderImport", () => ({
  importShopifyOrder: importShopifyOrderMock,
}));

vi.mock("../../src/lib/shopify", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/shopify")>(
    "../../src/lib/shopify",
  );
  return {
    ...actual,
    fetchShopifyProducts: vi.fn(async () => []),
  };
});

import shopifyWebhookRouter from "../../src/routes/shopifyWebhook";

const ORG_A = 1001;
const ORG_B = 2002;

const SHOP_A = "a-store.myshopify.com";
const SHOP_B = "b-store.myshopify.com";
// A Shopify "inventory item id" that is mapped only in ORG_A. If
// cross-tenant filtering were broken, an inventory_levels/update
// arriving under ORG_B's shop domain could find ORG_A's row and
// scramble its stock.
const SHARED_INVENTORY_ID = "inv_shared_999";
const SHARED_LOCATION = "loc_shared_42";

interface OrgFixture {
  orgId: number;
  warehouseId: number;
  itemId: number;
  shopDomain: string;
}

async function seedOrg(label: "A" | "B", orgId: number, shopDomain: string): Promise<OrgFixture> {
  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
    shopifyShopDomain: shopDomain,
    shopifyAccessToken: `tok_${label}`,
    shopifyScopes: "read_products,write_products",
    shopifyLocationId: `home_loc_${label}`,
    shopifyLastOrderId: null,
    shopifyLastWebhookAt: null,
  });
  const wh = await memDb.seed(tables.warehousesTable, {
    organizationId: orgId,
    name: `WH ${label}`,
    code: `WH-${label}`,
    isVirtual: false,
    isDefault: true,
    // Only ORG_A's warehouse is mapped to SHARED_LOCATION; ORG_B isn't.
    shopifyLocationId: label === "A" ? SHARED_LOCATION : `home_loc_${label}`,
    shopifyLocationName: label === "A" ? "Shared loc" : `Loc ${label}`,
  });
  const item = await memDb.seed(tables.itemsTable, {
    organizationId: orgId,
    name: `Item ${label}`,
    sku: `SKU-${label}`,
    unit: "ea",
    salePrice: "100",
    purchasePrice: "50",
    taxRate: "0",
    shopifyProductId: `prod_${label}`,
    shopifyVariantId: `var_${label}`,
    // Only ORG_A's item is mapped to SHARED_INVENTORY_ID.
    shopifyInventoryItemId:
      label === "A" ? SHARED_INVENTORY_ID : `inv_${label}`,
  });
  await memDb.seed(tables.itemWarehouseStockTable, {
    organizationId: orgId,
    itemId: item.id,
    warehouseId: wh.id,
    quantity: "10",
  });
  return { orgId, warehouseId: wh.id as number, itemId: item.id as number, shopDomain };
}

function sign(raw: string): string {
  return crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET!)
    .update(raw, "utf8")
    .digest("base64");
}

function buildApp(): Express {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    }),
  );
  app.use(shopifyWebhookRouter);
  app.use(
    (err: Error, _req: Request, res: Response, _next: NextFunction): void => {
      res.status(500).json({ error: err.message });
    },
  );
  return app;
}

describe("shopify webhook cross-tenant isolation", () => {
  let app: Express;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeEach(async () => {
    await memDb.reset();
    importShopifyOrderMock.mockClear();
    a = await seedOrg("A", ORG_A, SHOP_A);
    b = await seedOrg("B", ORG_B, SHOP_B);
    app = buildApp();
  });

  describe("signature verification", () => {
    it("rejects a forged HMAC with 401 and writes nothing", async () => {
      const stockBefore = JSON.parse(
        JSON.stringify((await memDb.rowsOf(tables.itemWarehouseStockTable.__table))),
      );
      const orgsBefore = JSON.parse(
        JSON.stringify((await memDb.rowsOf(tables.organizationsTable.__table))),
      );

      const body = { id: 1, line_items: [] };
      const res = await request(app)
        .post("/webhooks/shopify")
        .set("x-shopify-topic", "orders/create")
        .set("x-shopify-shop-domain", SHOP_B)
        .set("x-shopify-hmac-sha256", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
        .set("content-type", "application/json")
        .send(JSON.stringify(body));
      expect(res.status).toBe(401);
      expect(importShopifyOrderMock).not.toHaveBeenCalled();
      expect(
        JSON.parse(
          JSON.stringify((await memDb.rowsOf(tables.itemWarehouseStockTable.__table))),
        ),
      ).toEqual(stockBefore);
      expect(
        JSON.parse(
          JSON.stringify((await memDb.rowsOf(tables.organizationsTable.__table))),
        ),
      ).toEqual(orgsBefore);
    });

    it("rejects a missing HMAC header", async () => {
      const res = await request(app)
        .post("/webhooks/shopify")
        .set("x-shopify-topic", "orders/create")
        .set("x-shopify-shop-domain", SHOP_B)
        .send({});
      expect(res.status).toBe(401);
    });
  });

  describe("unknown shop", () => {
    it("returns 200 with ignored=unknown_shop and writes nothing", async () => {
      const before = JSON.parse(
        JSON.stringify((await memDb.rowsOf(tables.organizationsTable.__table))),
      );
      const body = { id: 1 };
      const raw = JSON.stringify(body);
      const res = await request(app)
        .post("/webhooks/shopify")
        .set("x-shopify-topic", "orders/create")
        .set("x-shopify-shop-domain", "ghost-store.myshopify.com")
        .set("x-shopify-hmac-sha256", sign(raw))
        .set("content-type", "application/json")
        .send(raw);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ignored: "unknown_shop" });
      expect(importShopifyOrderMock).not.toHaveBeenCalled();
      expect(
        JSON.parse(
          JSON.stringify((await memDb.rowsOf(tables.organizationsTable.__table))),
        ),
      ).toEqual(before);
    });
  });

  describe("orders/create", () => {
    it("invokes the importer with the shop's owning org, not whichever org an id might appear in", async () => {
      const body = { id: 12345, line_items: [{ sku: "SKU-A", quantity: 1 }] };
      const raw = JSON.stringify(body);
      const res = await request(app)
        .post("/webhooks/shopify")
        .set("x-shopify-topic", "orders/create")
        .set("x-shopify-shop-domain", SHOP_B)
        .set("x-shopify-hmac-sha256", sign(raw))
        .set("content-type", "application/json")
        .send(raw);
      expect(res.status).toBe(200);
      expect(importShopifyOrderMock).toHaveBeenCalledTimes(1);
      // First arg is the orgId; it must be ORG_B (matching the shop
      // domain), never ORG_A even though the body referenced "SKU-A".
      const callArgs = importShopifyOrderMock.mock.calls[0]!;
      expect(callArgs[0]).toBe(ORG_B);
      expect(callArgs[1]).toBe(b.warehouseId);
    });
  });

  describe("inventory_levels/update", () => {
    it("a payload referencing ORG_A's inventory id under ORG_B's shop does not touch ORG_A's stock", async () => {
      const aStockBefore = JSON.parse(
        JSON.stringify(
          (await memDb
            .rowsOf(tables.itemWarehouseStockTable.__table))
            .filter((r) => r.organizationId === ORG_A),
        ),
      );

      const body = {
        inventory_item_id: SHARED_INVENTORY_ID,
        location_id: SHARED_LOCATION,
        available: 9999,
      };
      const raw = JSON.stringify(body);
      const res = await request(app)
        .post("/webhooks/shopify")
        .set("x-shopify-topic", "inventory_levels/update")
        .set("x-shopify-shop-domain", SHOP_B)
        .set("x-shopify-hmac-sha256", sign(raw))
        .set("content-type", "application/json")
        .send(raw);
      expect(res.status).toBe(200);

      // ORG_A's stock — bit-for-bit identical.
      const aStockAfter = (await memDb
        .rowsOf(tables.itemWarehouseStockTable.__table))
        .filter((r) => r.organizationId === ORG_A);
      expect(JSON.parse(JSON.stringify(aStockAfter))).toEqual(aStockBefore);

      // No stock_movements rows were inserted for ORG_A.
      const aMoves = (await memDb
        .rowsOf(tables.stockMovementsTable.__table))
        .filter((r) => r.organizationId === ORG_A);
      expect(aMoves).toHaveLength(0);
    });
  });

  describe("app/uninstalled", () => {
    it("only wipes the requesting shop's org; the other org's creds remain", async () => {
      const body = {};
      const raw = JSON.stringify(body);
      const res = await request(app)
        .post("/webhooks/shopify")
        .set("x-shopify-topic", "app/uninstalled")
        .set("x-shopify-shop-domain", SHOP_B)
        .set("x-shopify-hmac-sha256", sign(raw))
        .set("content-type", "application/json")
        .send(raw);
      expect(res.status).toBe(200);

      const aOrg = (await memDb
        .rowsOf(tables.organizationsTable.__table))
        .find((r) => r.id === ORG_A);
      const bOrg = (await memDb
        .rowsOf(tables.organizationsTable.__table))
        .find((r) => r.id === ORG_B);
      // ORG_A's connection survives.
      expect(aOrg?.shopifyShopDomain).toBe(SHOP_A);
      expect(aOrg?.shopifyAccessToken).toBe("tok_A");
      // ORG_B is wiped.
      expect(bOrg?.shopifyShopDomain).toBeNull();
      expect(bOrg?.shopifyAccessToken).toBeNull();

      // ORG_A's item retains its Shopify mapping.
      const aItem = (await memDb
        .rowsOf(tables.itemsTable.__table))
        .find((r) => r.organizationId === ORG_A);
      expect(aItem?.shopifyInventoryItemId).toBe(SHARED_INVENTORY_ID);

      // ORG_A's warehouse mapping is untouched.
      const aWh = (await memDb
        .rowsOf(tables.warehousesTable.__table))
        .find((r) => r.id === a.warehouseId);
      expect(aWh?.shopifyLocationId).toBe(SHARED_LOCATION);
    });
  });
});
