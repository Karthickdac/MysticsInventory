// Cross-tenant isolation tests for the /shiprocket router.

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
  };
});

vi.mock("../../src/lib/encryption", () => ({
  encryptString: (s: string) => `enc:${s}`,
  decryptString: (s: string) => s.replace(/^enc:/u, ""),
}));

vi.mock("../../src/lib/shiprocket", () => ({
  shiprocketLogin: vi.fn(async (email: string) => ({
    token: `tok_for_${email}`,
    expiresAt: new Date(Date.now() + 10 * 86_400_000),
  })),
  createShiprocketOrder: vi.fn(),
  assignShiprocketAwb: vi.fn(),
  generateShiprocketLabel: vi.fn(),
  listShiprocketCouriers: vi.fn(async () => []),
  buildShiprocketTrackingUrl: (awb: string) => `https://track/${awb}`,
  ShiprocketAuthError: class extends Error {},
  ShiprocketApiError: class extends Error {
    status = 400;
    body: unknown;
  },
  ShiprocketNotConnectedError: class extends Error {},
  ShiprocketTokenExpiredError: class extends Error {},
}));

vi.mock("../../src/lib/shiprocketSync", () => ({
  syncShiprocketTrackingForOrg: vi.fn(async () => ({ updated: 0 })),
}));

import shiprocketRouter from "../../src/routes/shiprocket";

const ORG_A = 1001;
const ORG_B = 2002;

interface OrgFixture {
  orgId: number;
  shipmentId: number;
}

async function seedOrg(label: "A" | "B", orgId: number, connected: boolean): Promise<OrgFixture> {
  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
    postalCode: "560001",
    shiprocketEmail: connected ? `sr-${label.toLowerCase()}@example.com` : null,
    shiprocketTokenEncrypted: connected ? `enc:tok_${label}` : null,
    shiprocketTokenExpiresAt: connected
      ? new Date(Date.now() + 86_400_000)
      : null,
    shiprocketLastSyncedAt: connected ? new Date(2026, 0, 1) : null,
    shiprocketPickupPincode: connected ? "560001" : null,
  });
  await memDb.seed(tables.organizationMembersTable, {
    organizationId: orgId,
    userId: orgId * 10,
    role: "owner",
  });
  const customer = await memDb.seed(tables.customersTable, {
    organizationId: orgId,
    name: `Customer ${label}`,
    billingAddress: "1 MG Road",
    shippingAddress: "1 MG Road",
    placeOfSupply: "Maharashtra",
    outstandingBalance: "0",
  });
  const so = await memDb.seed(tables.salesOrdersTable, {
    organizationId: orgId,
    orderNumber: `SO-${label}-1`,
    customerId: customer.id,
    status: "shipped",
    orderDate: "2026-05-01",
    subtotal: "100",
    taxTotal: "18",
    total: "118",
    amountPaid: "0",
    balanceDue: "118",
  });
  const ship = await memDb.seed(tables.shipmentsTable, {
    organizationId: orgId,
    salesOrderId: so.id,
    shipmentNumber: `SHIP-${label}-1`,
    shipDate: "2026-05-01",
    awb: null,
    courierName: null,
    labelUrl: null,
    trackingUrl: null,
    trackingStatus: null,
  });
  return { orgId, shipmentId: ship.id as number };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(shiprocketRouter);
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

describe("shiprocket cross-tenant isolation", () => {
  let app: Express;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeEach(async () => {
    await memDb.reset();
    a = await seedOrg("A", ORG_A, false); // not connected
    b = await seedOrg("B", ORG_B, true); // connected
    app = buildApp();
  });

  describe("auth", () => {
    it("rejects requests without x-test-org-id", async () => {
      const res = await request(app).get("/shiprocket/connection");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /shiprocket/connection", () => {
    it("ORG_A reports not connected", async () => {
      const res = await request(app)
        .get("/shiprocket/connection")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
      expect(res.body.email).toBeNull();
    });

    it("ORG_B sees its own credentials only", async () => {
      const res = await request(app)
        .get("/shiprocket/connection")
        .set("x-test-org-id", String(ORG_B));
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      expect(res.body.email).toBe("sr-b@example.com");
      expect(res.body.pickupPincode).toBe("560001");
    });
  });

  describe("POST /shiprocket/connection", () => {
    it("only updates the caller's org row", async () => {
      const res = await request(app)
        .post("/shiprocket/connection")
        .set("x-test-org-id", String(ORG_A))
        .send({
          email: "sr-a@example.com",
          password: "secret",
          pickupPincode: "400001",
        });
      expect(res.status).toBe(200);
      const orgs = (await memDb.rowsOf(tables.organizationsTable.__table));
      const aOrg = orgs.find((r) => r.id === ORG_A);
      const bOrg = orgs.find((r) => r.id === ORG_B);
      expect(aOrg?.shiprocketEmail).toBe("sr-a@example.com");
      expect(aOrg?.shiprocketPickupPincode).toBe("400001");
      // ORG_B unchanged.
      expect(bOrg?.shiprocketEmail).toBe("sr-b@example.com");
      expect(bOrg?.shiprocketPickupPincode).toBe("560001");
    });
  });

  describe("DELETE /shiprocket/connection", () => {
    it("only wipes the caller's org row", async () => {
      const res = await request(app)
        .delete("/shiprocket/connection")
        .set("x-test-org-id", String(ORG_B));
      expect(res.status).toBe(204);
      const orgs = (await memDb.rowsOf(tables.organizationsTable.__table));
      const bOrg = orgs.find((r) => r.id === ORG_B);
      expect(bOrg?.shiprocketEmail).toBeNull();
      expect(bOrg?.shiprocketTokenEncrypted).toBeNull();
    });
  });

  describe("POST /shipments/:id/shiprocket/couriers", () => {
    it("ORG_A cannot probe ORG_B's shipment", async () => {
      const res = await request(app)
        .post(`/shipments/${b.shipmentId}/shiprocket/couriers`)
        .set("x-test-org-id", String(ORG_A))
        .send({ deliveryPincode: "110001", weightKg: 1 });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /shipments/:id/shiprocket/book", () => {
    it("ORG_A cannot book ORG_B's shipment", async () => {
      const res = await request(app)
        .post(`/shipments/${b.shipmentId}/shiprocket/book`)
        .set("x-test-org-id", String(ORG_A))
        .send({});
      expect(res.status).toBe(404);
      const bShip = (await memDb
        .rowsOf(tables.shipmentsTable.__table))
        .find((r) => r.id === b.shipmentId);
      expect(bShip?.awb).toBeNull();
    });
  });

  it("seeded fixtures are disjoint", () => {
    expect(a.shipmentId).not.toBe(b.shipmentId);
  });
});
