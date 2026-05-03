// Cross-tenant isolation tests for the /payment-links + sales-order
// payment-link routes.

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

vi.mock("../../src/lib/razorpay", () => ({
  createPaymentLink: vi.fn(async () => ({
    id: "plink_test",
    short_url: "https://rzp.io/i/test",
    currency: "INR",
    expire_by: null,
  })),
  cancelPaymentLink: vi.fn(async () => undefined),
  RazorpayNotConfiguredError: class extends Error {},
}));

import paymentLinksRouter from "../../src/routes/paymentLinks";
import * as razorpayLib from "../../src/lib/razorpay";

const createPaymentLinkMock = vi.mocked(razorpayLib.createPaymentLink);
const cancelPaymentLinkMock = vi.mocked(razorpayLib.cancelPaymentLink);

const ORG_A = 1001;
const ORG_B = 2002;

interface OrgFixture {
  orgId: number;
  customerId: number;
  salesOrderId: number;
  paymentLinkId: number;
}

async function seedOrg(label: "A" | "B", orgId: number): Promise<OrgFixture> {
  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
  });
  await memDb.seed(tables.organizationMembersTable, {
    organizationId: orgId,
    userId: orgId * 10,
    role: "owner",
  });
  const customer = await memDb.seed(tables.customersTable, {
    organizationId: orgId,
    name: `Customer ${label}`,
    email: `customer-${label.toLowerCase()}@example.com`,
    phone: `+919999${orgId}`,
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
  const link = await memDb.seed(tables.paymentLinksTable, {
    organizationId: orgId,
    salesOrderId: so.id,
    razorpayLinkId: `plink_existing_${label}`,
    shortUrl: `https://rzp.io/i/${label.toLowerCase()}-existing`,
    amount: "118.00",
    currency: "INR",
    status: "created",
    description: `Existing ${label}`,
    expiresAt: null,
    createdByUserId: orgId * 10,
    createdAt: new Date(2026, 0, 1),
  });
  return {
    orgId,
    customerId: customer.id as number,
    salesOrderId: so.id as number,
    paymentLinkId: link.id as number,
  };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(paymentLinksRouter);
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

describe("paymentLinks cross-tenant isolation", () => {
  let app: Express;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeEach(async () => {
    await memDb.reset();
    cancelPaymentLinkMock.mockClear();
    createPaymentLinkMock.mockClear();
    a = await seedOrg("A", ORG_A);
    b = await seedOrg("B", ORG_B);
    app = buildApp();
  });

  describe("auth", () => {
    it("rejects requests without x-test-org-id", async () => {
      const res = await request(app).get(
        `/sales-orders/${a.salesOrderId}/payment-links`,
      );
      expect(res.status).toBe(401);
    });
  });

  describe("GET /sales-orders/:id/payment-links", () => {
    it("ORG_A cannot see ORG_B's payment links", async () => {
      const res = await request(app)
        .get(`/sales-orders/${b.salesOrderId}/payment-links`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("ORG_B sees its own payment links", async () => {
      const res = await request(app)
        .get(`/sales-orders/${b.salesOrderId}/payment-links`)
        .set("x-test-org-id", String(ORG_B));
      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ id: number }>).map((r) => r.id);
      expect(ids).toContain(b.paymentLinkId);
    });
  });

  describe("POST /sales-orders/:id/payment-link", () => {
    it("ORG_A cannot generate a payment link against ORG_B's order", async () => {
      const res = await request(app)
        .post(`/sales-orders/${b.salesOrderId}/payment-link`)
        .set("x-test-org-id", String(ORG_A))
        .send({ amount: 50 });
      expect(res.status).toBe(404);
      expect(createPaymentLinkMock).not.toHaveBeenCalled();
      // No new link row should have been inserted under ORG_B.
      const bLinks = (await memDb
        .rowsOf(tables.paymentLinksTable.__table))
        .filter((r) => r.organizationId === ORG_B);
      expect(bLinks.length).toBe(1);
    });
  });

  describe("POST /payment-links/:id/cancel", () => {
    it("ORG_A cannot cancel ORG_B's payment link", async () => {
      const res = await request(app)
        .post(`/payment-links/${b.paymentLinkId}/cancel`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
      expect(cancelPaymentLinkMock).not.toHaveBeenCalled();
      const bLink = (await memDb
        .rowsOf(tables.paymentLinksTable.__table))
        .find((r) => r.id === b.paymentLinkId);
      expect(bLink?.status).toBe("created");
    });

    it("ORG_B can cancel its own payment link", async () => {
      const res = await request(app)
        .post(`/payment-links/${b.paymentLinkId}/cancel`)
        .set("x-test-org-id", String(ORG_B));
      expect(res.status).toBe(200);
      expect(cancelPaymentLinkMock).toHaveBeenCalledWith(
        `plink_existing_B`,
      );
      const bLink = (await memDb
        .rowsOf(tables.paymentLinksTable.__table))
        .find((r) => r.id === b.paymentLinkId);
      expect(bLink?.status).toBe("cancelled");
    });
  });
});
