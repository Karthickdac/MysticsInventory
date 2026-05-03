// Cross-tenant isolation tests for the public Razorpay webhook.
//
// The route is unauthenticated — it identifies the owning org by
// looking up paymentLinksTable.razorpayLinkId or
// organizationsTable.razorpaySubscriptionId. These tests confirm:
//   * Forged signatures are rejected outright (no DB writes).
//   * A payment_link.paid event for org A's link only mutates org A;
//     org B's rows stay byte-for-byte identical.
//   * A subscription.* event for org A's sub never touches org B.

import crypto from "node:crypto";

process.env.RAZORPAY_WEBHOOK_SECRET = "test_webhook_secret";

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

vi.mock("../../src/lib/razorpay", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/razorpay")>(
    "../../src/lib/razorpay",
  );
  return {
    ...actual,
    fetchPaymentLink: vi.fn(async () => ({
      id: "plink_A_1",
      status: "paid",
      amount: 11800,
      amount_paid: 11800,
    })),
  };
});

import razorpayWebhookRouter from "../../src/routes/razorpayWebhook";

const ORG_A = 1001;
const ORG_B = 2002;

interface OrgFixture {
  orgId: number;
  customerId: number;
  salesOrderId: number;
  paymentLinkId: number;
  razorpayLinkId: string;
  razorpaySubscriptionId: string;
}

async function seedOrg(label: "A" | "B", orgId: number): Promise<OrgFixture> {
  const subId = `sub_${label}`;
  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
    razorpaySubscriptionId: subId,
    subscriptionStatus: "pending",
    currentPeriodEnd: null,
  });
  const customer = await memDb.seed(tables.customersTable, {
    organizationId: orgId,
    name: `Customer ${label}`,
    email: `c-${label.toLowerCase()}@example.com`,
    phone: "+910000000000",
    outstandingBalance: "118.00",
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
  const linkId = `plink_${label}_1`;
  const link = await memDb.seed(tables.paymentLinksTable, {
    organizationId: orgId,
    salesOrderId: so.id,
    razorpayLinkId: linkId,
    razorpayPaymentId: null,
    shortUrl: `https://rzp.io/i/${label}`,
    amount: "118.00",
    currency: "INR",
    status: "created",
    description: `Pay ${label}`,
    paidAt: null,
    cancelledAt: null,
  });
  return {
    orgId,
    customerId: customer.id as number,
    salesOrderId: so.id as number,
    paymentLinkId: link.id as number,
    razorpayLinkId: linkId,
    razorpaySubscriptionId: subId,
  };
}

function sign(rawBody: string): string {
  return crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET!)
    .update(rawBody)
    .digest("hex");
}

function buildApp(): Express {
  const app = express();
  // Mirror the production rawBody capture so verifyWebhookSignature
  // sees the exact bytes the client signed.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    }),
  );
  app.use(razorpayWebhookRouter);
  app.use(
    (err: Error, _req: Request, res: Response, _next: NextFunction): void => {
      res.status(500).json({ error: err.message });
    },
  );
  return app;
}

async function snapshotOrgRows(orgId: number) {
  return {
    paymentLinks: JSON.parse(
      JSON.stringify(
        (await memDb
          .rowsOf(tables.paymentLinksTable.__table))
          .filter((r) => r.organizationId === orgId),
      ),
    ),
    salesOrders: JSON.parse(
      JSON.stringify(
        (await memDb
          .rowsOf(tables.salesOrdersTable.__table))
          .filter((r) => r.organizationId === orgId),
      ),
    ),
    customers: JSON.parse(
      JSON.stringify(
        (await memDb
          .rowsOf(tables.customersTable.__table))
          .filter((r) => r.organizationId === orgId),
      ),
    ),
    customerPayments: (await memDb
      .rowsOf(tables.customerPaymentsTable.__table))
      .filter((r) => r.organizationId === orgId).length,
    organization: JSON.parse(
      JSON.stringify(
        (await memDb
          .rowsOf(tables.organizationsTable.__table))
          .find((r) => r.id === orgId) ?? null,
      ),
    ),
  };
}

describe("razorpay webhook cross-tenant isolation", () => {
  let app: Express;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeEach(async () => {
    await memDb.reset();
    a = await seedOrg("A", ORG_A);
    b = await seedOrg("B", ORG_B);
    app = buildApp();
  });

  describe("signature verification", () => {
    it("rejects a forged signature with 400 and writes nothing", async () => {
      const beforeA = await snapshotOrgRows(ORG_A);
      const beforeB = await snapshotOrgRows(ORG_B);

      const body = {
        event: "payment_link.paid",
        payload: { payment_link: { entity: { id: a.razorpayLinkId } } },
      };
      const res = await request(app)
        .post("/razorpay/webhook")
        .set("x-razorpay-signature", "deadbeef".repeat(8))
        .set("content-type", "application/json")
        .send(JSON.stringify(body));
      expect(res.status).toBe(400);

      expect(await snapshotOrgRows(ORG_A)).toEqual(beforeA);
      expect(await snapshotOrgRows(ORG_B)).toEqual(beforeB);
    });

    it("rejects a missing signature header", async () => {
      const res = await request(app)
        .post("/razorpay/webhook")
        .send({ event: "payment_link.paid" });
      expect(res.status).toBe(400);
    });
  });

  describe("payment_link.paid", () => {
    it("only mutates the link's owning org; the other org is untouched", async () => {
      const beforeB = await snapshotOrgRows(ORG_B);
      const body = {
        event: "payment_link.paid",
        payload: {
          payment_link: { entity: { id: a.razorpayLinkId } },
          payment: { entity: { id: "pay_A_xyz" } },
        },
      };
      const raw = JSON.stringify(body);
      const res = await request(app)
        .post("/razorpay/webhook")
        .set("x-razorpay-signature", sign(raw))
        .set("content-type", "application/json")
        .send(raw);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        event: "payment_link.paid",
        paymentLinkId: a.paymentLinkId,
      });

      // ORG_B's rows are byte-for-byte identical.
      expect(await snapshotOrgRows(ORG_B)).toEqual(beforeB);

      // ORG_A's link is now paid; a customer payment was inserted in A only.
      const aLink = (await memDb
        .rowsOf(tables.paymentLinksTable.__table))
        .find((r) => r.id === a.paymentLinkId);
      expect(aLink?.status).toBe("paid");
      expect(aLink?.razorpayPaymentId).toBe("pay_A_xyz");

      const payments = (await memDb.rowsOf(tables.customerPaymentsTable.__table));
      expect(payments).toHaveLength(1);
      expect(payments[0]!.organizationId).toBe(ORG_A);
      expect(payments[0]!.customerId).toBe(a.customerId);

      const allocations = (await memDb.rowsOf(
        tables.customerPaymentAllocationsTable.__table,
      ));
      expect(allocations).toHaveLength(1);
      expect(allocations[0]!.organizationId).toBe(ORG_A);
      expect(allocations[0]!.salesOrderId).toBe(a.salesOrderId);
    });

    it("ignores webhooks for unknown payment links without writing anything", async () => {
      const beforeA = await snapshotOrgRows(ORG_A);
      const beforeB = await snapshotOrgRows(ORG_B);
      const body = {
        event: "payment_link.paid",
        payload: { payment_link: { entity: { id: "plink_does_not_exist" } } },
      };
      const raw = JSON.stringify(body);
      const res = await request(app)
        .post("/razorpay/webhook")
        .set("x-razorpay-signature", sign(raw))
        .set("content-type", "application/json")
        .send(raw);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ unknownLink: true });
      expect(await snapshotOrgRows(ORG_A)).toEqual(beforeA);
      expect(await snapshotOrgRows(ORG_B)).toEqual(beforeB);
    });
  });

  describe("subscription.activated", () => {
    it("only updates the matching org; the other org's subscription is untouched", async () => {
      const beforeB = await snapshotOrgRows(ORG_B);
      const body = {
        event: "subscription.activated",
        payload: {
          subscription: {
            entity: {
              id: a.razorpaySubscriptionId,
              current_end: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        },
      };
      const raw = JSON.stringify(body);
      const res = await request(app)
        .post("/razorpay/webhook")
        .set("x-razorpay-signature", sign(raw))
        .set("content-type", "application/json")
        .send(raw);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        organizationId: ORG_A,
      });

      expect(await snapshotOrgRows(ORG_B)).toEqual(beforeB);
      const aOrg = (await memDb
        .rowsOf(tables.organizationsTable.__table))
        .find((r) => r.id === ORG_A);
      expect(aOrg?.subscriptionStatus).toBe("active");
    });
  });
});
