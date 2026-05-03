// Cross-tenant isolation tests for the customer-payments router.
//
// The router is heavier than the Tier 1 routers — it joins payments
// to customers, owns a multi-step transactional create that touches
// sales orders + customers, and owns a delete that locks the payment
// row via `tx.execute(sql\`SELECT ... FOR UPDATE\`)`. Each branch is
// exercised here with the same two-org fixture so leakage on read,
// create, or delete would surface as a failure.

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

import customerPaymentsRouter from "../../src/routes/customerPayments";

const ORG_A = 1001;
const ORG_B = 2002;

interface OrgFixture {
  orgId: number;
  customerId: number;
  salesOrderId: number;
  paymentId: number;
  allocationId: number;
}

async function seedOrg(label: "A" | "B", orgId: number): Promise<OrgFixture> {
  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
  });
  const customer = await memDb.seed(tables.customersTable, {
    organizationId: orgId,
    name: `Customer ${label}`,
    email: null,
    phone: null,
    company: null,
    gstNumber: null,
    billingAddress: null,
    shippingAddress: null,
    placeOfSupply: null,
    notes: null,
    outstandingBalance: "100",
  });
  const so = await memDb.seed(tables.salesOrdersTable, {
    organizationId: orgId,
    orderNumber: `SO-${label}-1`,
    customerId: customer.id,
    warehouseId: 1,
    status: "confirmed",
    orderDate: "2026-01-01",
    subtotal: "100",
    taxTotal: "0",
    total: "100",
    amountPaid: "0",
    balanceDue: "100",
  });
  const payment = await memDb.seed(tables.customerPaymentsTable, {
    organizationId: orgId,
    customerId: customer.id,
    paymentDate: "2026-02-01",
    amount: "40",
    mode: "bank",
    referenceNumber: null,
    notes: null,
    bankAccountLabel: null,
  });
  const allocation = await memDb.seed(tables.customerPaymentAllocationsTable, {
    organizationId: orgId,
    paymentId: payment.id,
    salesOrderId: so.id,
    amount: "40",
  });
  return {
    orgId,
    customerId: customer.id as number,
    salesOrderId: so.id as number,
    paymentId: payment.id as number,
    allocationId: allocation.id as number,
  };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(customerPaymentsRouter);
  return app;
}

describe("customer-payments cross-tenant isolation", () => {
  let app: Express;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeEach(async () => {
    await memDb.reset();
    a = await seedOrg("A", ORG_A);
    b = await seedOrg("B", ORG_B);
    app = buildApp();
  });

  describe("GET /customer-payments", () => {
    it("only returns the caller's payments", async () => {
      const resA = await request(app)
        .get("/customer-payments")
        .set("x-test-org-id", String(ORG_A));
      expect(resA.status).toBe(200);
      const idsA = resA.body.map((p: { id: number }) => p.id);
      expect(idsA).toEqual([a.paymentId]);
      expect(idsA).not.toContain(b.paymentId);

      const resB = await request(app)
        .get("/customer-payments")
        .set("x-test-org-id", String(ORG_B));
      expect(resB.status).toBe(200);
      const idsB = resB.body.map((p: { id: number }) => p.id);
      expect(idsB).toEqual([b.paymentId]);
      expect(idsB).not.toContain(a.paymentId);
    });

    it("the date-range + mode filters never bleed across orgs", async () => {
      const res = await request(app)
        .get("/customer-payments?from=2026-01-01&to=2026-12-31&mode=bank")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const ids = res.body.map((p: { id: number }) => p.id);
      expect(ids).toEqual([a.paymentId]);
      expect(ids).not.toContain(b.paymentId);
    });
  });

  describe("GET /customer-payments/:id", () => {
    it("returns 404 for the other org's payment", async () => {
      const res = await request(app)
        .get(`/customer-payments/${b.paymentId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
    });

    it("only includes the caller's allocations on the detail view", async () => {
      const res = await request(app)
        .get(`/customer-payments/${a.paymentId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const allocIds = res.body.allocations.map((x: { id: number }) => x.id);
      expect(allocIds).toEqual([a.allocationId]);
      expect(allocIds).not.toContain(b.allocationId);
      // The denormalised order number must be A's, never B's.
      expect(
        res.body.allocations.map(
          (x: { salesOrderNumber: string }) => x.salesOrderNumber,
        ),
      ).toEqual([`SO-A-1`]);
    });
  });

  describe("POST /customer-payments", () => {
    it("rejects an allocation that targets the other org's sales order", async () => {
      const beforeBPaid = (
        (await memDb.rowsOf("sales_orders")).find((r) => r.id === b.salesOrderId) as {
          amountPaid: string;
        }
      ).amountPaid;

      const res = await request(app)
        .post("/customer-payments")
        .set("x-test-org-id", String(ORG_A))
        .send({
          customerId: a.customerId,
          amount: 10,
          mode: "bank",
          paymentDate: "2026-03-01",
          allocations: [{ salesOrderId: b.salesOrderId, amount: 10 }],
        });
      expect(res.status).toBe(400);

      const afterBPaid = (
        (await memDb.rowsOf("sales_orders")).find((r) => r.id === b.salesOrderId) as {
          amountPaid: string;
        }
      ).amountPaid;
      expect(afterBPaid).toBe(beforeBPaid);
    });

    it("rejects when the caller's customer doesn't exist in their org", async () => {
      const res = await request(app)
        .post("/customer-payments")
        .set("x-test-org-id", String(ORG_A))
        .send({
          // Org B's customer.
          customerId: b.customerId,
          amount: 10,
          mode: "bank",
        });
      expect(res.status).toBe(400);
    });

    it("a successful create only mutates the caller's org", async () => {
      const snapshot = async (table: string) =>
        JSON.stringify(
          (await memDb.rowsOf(table)).filter((r) => r.organizationId === ORG_B),
        );
      const bSoBefore = await snapshot("sales_orders");
      const bCustBefore = await snapshot("customers");

      const res = await request(app)
        .post("/customer-payments")
        .set("x-test-org-id", String(ORG_A))
        .send({
          customerId: a.customerId,
          amount: 25,
          mode: "bank",
          paymentDate: "2026-03-15",
          allocations: [{ salesOrderId: a.salesOrderId, amount: 25 }],
        });
      expect(res.status).toBe(201);

      // Org B's sales orders + customers must be untouched.
      expect(await snapshot("sales_orders")).toBe(bSoBefore);
      expect(await snapshot("customers")).toBe(bCustBefore);

      // The new payment row sits in org A.
      const created = (await memDb.rowsOf("customer_payments"))
        .find((r) => r.id === res.body.payment.id);
      expect(created?.organizationId).toBe(ORG_A);
    });
  });

  describe("DELETE /customer-payments/:id", () => {
    it("returns 404 and never touches the other org's data when targeting cross-tenant", async () => {
      const beforeBPayments = (await memDb.rowsOf("customer_payments")).length;
      const beforeBAllocs = (await memDb.rowsOf("customer_payment_allocations")).length;
      const beforeBOrder = JSON.stringify(
        (await memDb.rowsOf("sales_orders")).find((r) => r.id === b.salesOrderId),
      );

      const res = await request(app)
        .delete(`/customer-payments/${b.paymentId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);

      // Nothing was deleted, nothing was reversed.
      expect((await memDb.rowsOf("customer_payments")).length).toBe(beforeBPayments);
      expect((await memDb.rowsOf("customer_payment_allocations")).length).toBe(
        beforeBAllocs,
      );
      const afterBOrder = JSON.stringify(
        (await memDb.rowsOf("sales_orders")).find((r) => r.id === b.salesOrderId),
      );
      expect(afterBOrder).toBe(beforeBOrder);
    });

    it("a same-org delete reverses only the caller's totals", async () => {
      // Snapshot scalars (not row references) so the post-delete view
      // doesn't read back the same row we're about to mutate.
      const aOrderRef = (await memDb.rowsOf("sales_orders"))
        .find((r) => r.id === a.salesOrderId)!;
      const aBalBefore = Number(aOrderRef.balanceDue);
      const aPaidBefore = Number(aOrderRef.amountPaid);
      const bOrderBefore = JSON.stringify(
        (await memDb.rowsOf("sales_orders")).find((r) => r.id === b.salesOrderId),
      );

      const res = await request(app)
        .delete(`/customer-payments/${a.paymentId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(204);

      // Org A's order: balance bumped back up by 40, paid back down.
      const aOrderAfter = (await memDb.rowsOf("sales_orders"))
        .find((r) => r.id === a.salesOrderId);
      expect(Number(aOrderAfter?.balanceDue)).toBe(aBalBefore + 40);
      expect(Number(aOrderAfter?.amountPaid)).toBe(aPaidBefore - 40);
      // Org B's order: untouched bit-for-bit.
      const bOrderAfter = JSON.stringify(
        (await memDb.rowsOf("sales_orders")).find((r) => r.id === b.salesOrderId),
      );
      expect(bOrderAfter).toBe(bOrderBefore);
    });
  });
});
