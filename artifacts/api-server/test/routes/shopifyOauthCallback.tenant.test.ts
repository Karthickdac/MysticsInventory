// Cross-tenant isolation tests for the public Shopify OAuth callback.
//
// The route is unauthenticated — it discovers the owning org by
// looking up the one-time CSRF state row. These tests confirm:
//   * A forged HMAC is rejected with 400, no writes.
//   * A state row whose `shopDomain` doesn't match the `shop` query
//     param is rejected (an attacker can't reuse another org's state
//     against their own store).
//   * A successful callback only updates the org named in the state
//     row; the other org's Shopify creds are untouched.

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

const {
  exchangeCodeForTokenMock,
  getPrimaryLocationIdMock,
  registerWebhooksMock,
} = vi.hoisted(() => ({
  exchangeCodeForTokenMock: vi.fn(async () => ({
    access_token: "shpat_NEW_TOKEN",
    scope:
      "read_products,write_products,read_inventory,write_inventory,read_orders,read_customers,read_locations",
  })),
  getPrimaryLocationIdMock: vi.fn(async () => "loc_new_primary"),
  registerWebhooksMock: vi.fn(async () => undefined),
}));

vi.mock("../../src/lib/shopify", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/shopify")>(
    "../../src/lib/shopify",
  );
  return {
    ...actual,
    exchangeCodeForToken: exchangeCodeForTokenMock,
    getPrimaryLocationId: getPrimaryLocationIdMock,
    registerWebhooks: registerWebhooksMock,
  };
});

import shopifyOauthCallbackRouter from "../../src/routes/shopifyOauthCallback";

const ORG_A = 1001;
const ORG_B = 2002;
const SHOP_A = "a-store.myshopify.com";
const SHOP_B = "b-store.myshopify.com";

async function seedOrg(label: "A" | "B", orgId: number, shopDomain: string) {
  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
    shopifyShopDomain: null,
    shopifyAccessToken: null,
    shopifyScopes: null,
    shopifyLocationId: null,
    shopifyWebhookRegisteredAt: null,
  });
  return await memDb.seed(tables.shopifyOauthStatesTable, {
    organizationId: orgId,
    state: `state_${label}`,
    shopDomain,
    createdAt: new Date(),
  });
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(shopifyOauthCallbackRouter);
  app.use(
    (err: Error, _req: Request, res: Response, _next: NextFunction): void => {
      res.status(500).json({ error: err.message });
    },
  );
  return app;
}

function makeQuery(opts: {
  state: string;
  shop: string;
  code?: string;
  timestamp?: string;
}) {
  const params: Record<string, string> = {
    code: opts.code ?? "auth_code_123",
    shop: opts.shop,
    state: opts.state,
    timestamp: opts.timestamp ?? String(Math.floor(Date.now() / 1000)),
  };
  // Compute Shopify's HMAC over the sorted params (excluding hmac).
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const hmac = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET!)
    .update(message)
    .digest("hex");
  return { ...params, hmac };
}

describe("shopify OAuth callback cross-tenant isolation", () => {
  let app: Express;

  beforeEach(async () => {
    await memDb.reset();
    exchangeCodeForTokenMock.mockClear();
    getPrimaryLocationIdMock.mockClear();
    registerWebhooksMock.mockClear();
    await seedOrg("A", ORG_A, SHOP_A);
    await seedOrg("B", ORG_B, SHOP_B);
    app = buildApp();
  });

  describe("HMAC verification", () => {
    it("rejects a forged HMAC with 400 and writes nothing", async () => {
      const orgsBefore = JSON.parse(
        JSON.stringify((await memDb.rowsOf(tables.organizationsTable.__table))),
      );
      const statesBefore = JSON.parse(
        JSON.stringify((await memDb.rowsOf(tables.shopifyOauthStatesTable.__table))),
      );

      const res = await request(app).get("/shopify/oauth/callback").query({
        code: "auth_code_123",
        shop: SHOP_A,
        state: "state_A",
        timestamp: "1700000000",
        hmac: "deadbeef",
      });
      expect(res.status).toBe(400);
      expect(exchangeCodeForTokenMock).not.toHaveBeenCalled();
      expect(
        JSON.parse(
          JSON.stringify((await memDb.rowsOf(tables.organizationsTable.__table))),
        ),
      ).toEqual(orgsBefore);
      expect(
        JSON.parse(
          JSON.stringify((await memDb.rowsOf(tables.shopifyOauthStatesTable.__table))),
        ),
      ).toEqual(statesBefore);
    });
  });

  describe("state-domain mismatch", () => {
    it("rejects a callback that pairs ORG_A's state with ORG_B's shop", async () => {
      const orgsBefore = JSON.parse(
        JSON.stringify((await memDb.rowsOf(tables.organizationsTable.__table))),
      );
      const query = makeQuery({ state: "state_A", shop: SHOP_B });
      const res = await request(app).get("/shopify/oauth/callback").query(query);
      expect(res.status).toBe(400);
      expect(exchangeCodeForTokenMock).not.toHaveBeenCalled();

      // Neither org's connection was touched.
      expect(
        JSON.parse(
          JSON.stringify((await memDb.rowsOf(tables.organizationsTable.__table))),
        ),
      ).toEqual(orgsBefore);
      // ORG_A's state row survives (was not consumed by an aborted attempt).
      const states = (await memDb.rowsOf(tables.shopifyOauthStatesTable.__table));
      expect(states.find((r) => r.state === "state_A")).toBeDefined();
    });

    it("rejects a callback with a state that does not exist", async () => {
      const query = makeQuery({ state: "state_unknown", shop: SHOP_A });
      const res = await request(app).get("/shopify/oauth/callback").query(query);
      expect(res.status).toBe(400);
      expect(exchangeCodeForTokenMock).not.toHaveBeenCalled();
    });
  });

  describe("successful callback", () => {
    it("only updates the org named in the state row; the other org is untouched", async () => {
      const bBefore = JSON.parse(
        JSON.stringify(
          (await memDb
            .rowsOf(tables.organizationsTable.__table))
            .find((r) => r.id === ORG_B),
        ),
      );

      const query = makeQuery({ state: "state_A", shop: SHOP_A });
      const res = await request(app).get("/shopify/oauth/callback").query(query);
      expect(res.status).toBe(302);

      // ORG_A picked up the new credentials.
      const aOrg = (await memDb
        .rowsOf(tables.organizationsTable.__table))
        .find((r) => r.id === ORG_A);
      expect(aOrg?.shopifyShopDomain).toBe(SHOP_A);
      expect(aOrg?.shopifyAccessToken).toBe("shpat_NEW_TOKEN");
      expect(aOrg?.shopifyLocationId).toBe("loc_new_primary");

      // ORG_B's row is byte-for-byte identical.
      const bAfter = (await memDb
        .rowsOf(tables.organizationsTable.__table))
        .find((r) => r.id === ORG_B);
      expect(JSON.parse(JSON.stringify(bAfter))).toEqual(bBefore);

      // The state row was consumed; ORG_B's state row remains.
      const states = (await memDb.rowsOf(tables.shopifyOauthStatesTable.__table));
      expect(states.find((r) => r.state === "state_A")).toBeUndefined();
      expect(states.find((r) => r.state === "state_B")).toBeDefined();
    });
  });
});
