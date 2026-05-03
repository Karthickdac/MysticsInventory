// Cross-tenant isolation tests for the supplier-payments router.
//
// Mirror of customerPayments.tenant.test.ts: same shape, just on the
// AP side. Exercises the same surface — list, detail, create
// allocations, delete with FOR UPDATE lock + reversal — to catch any
// org-scope drift between the two near-identical handlers.

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

import supplierPaymentsRouter from "../../src/routes/supplierPayments";

const ORG_A = 1001;
const ORG_B = 2002;

interface OrgFixture {
  orgId: number;
  supplierId: number;
  purchaseOrderId: number;
  paymentId: number;
  allocationId: number;
}

async function seedOrg(label: "A" | "B", orgId: number): Promise<OrgFixture> {
  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
  });
  const supplier = await memDb.seed(tables.suppliersTable, {
    organizationId: orgId,
    name: `Supplier ${label}`,
    isJobWorker: false,
    outstandingPayable: "100",
  });
  const po = await memDb.seed(tables.purchaseOrdersTable, {
    organizationId: orgId,
    orderNumber: `PO-${label}-1`,
    supplierId: supplier.id,
    warehouseId: 1,
    status: "ordered",
    orderDate: "2026-01-01",
    subtotal: "100",
    taxTotal: "0",
    total: "100",
    amountPaid: "0",
    balanceDue: "100",
  });
  const payment = await memDb.seed(tables.supplierPaymentsTable, {
    organizationId: orgId,
    supplierId: supplier.id,
    paymentDate: "2026-02-01",
    amount: "40",
    mode: "bank",
    referenceNumber: null,
    notes: null,
    bankAccountLabel: null,
  });
  const allocation = await memDb.seed(tables.supplierPaymentAllocationsTable, {
    organizationId: orgId,
    paymentId: payment.id,
    purchaseOrderId: po.id,
    amount: "40",
  });
  return {
    orgId,
    supplierId: supplier.id as number,
    purchaseOrderId: po.id as number,
    paymentId: payment.id as number,
    allocationId: allocation.id as number,
  };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(supplierPaymentsRouter);
  return app;
}

describe("supplier-payments cross-tenant isolation", () => {
  let app: Express;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeEach(async () => {
    await memDb.reset();
    a = await seedOrg("A", ORG_A);
    b = await seedOrg("B", ORG_B);
    app = buildApp();
  });

  describe("GET /supplier-payments", () => {
    it("only returns the caller's payments", async () => {
      const resA = await request(app)
        .get("/supplier-payments")
        .set("x-test-org-id", String(ORG_A));
      expect(resA.status).toBe(200);
      const idsA = resA.body.map((p: { id: number }) => p.id);
      expect(idsA).toEqual([a.paymentId]);
      expect(idsA).not.toContain(b.paymentId);

      const resB = await request(app)
        .get("/supplier-payments")
        .set("x-test-org-id", String(ORG_B));
      expect(resB.status).toBe(200);
      const idsB = resB.body.map((p: { id: number }) => p.id);
      expect(idsB).toEqual([b.paymentId]);
    });

    it("the date-range + mode filters never bleed across orgs", async () => {
      const res = await request(app)
        .get("/supplier-payments?from=2026-01-01&to=2026-12-31&mode=bank")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const ids = res.body.map((p: { id: number }) => p.id);
      expect(ids).toEqual([a.paymentId]);
      expect(ids).not.toContain(b.paymentId);
    });
  });

  describe("GET /supplier-payments/:id", () => {
    it("returns 404 for the other org's payment", async () => {
      const res = await request(app)
        .get(`/supplier-payments/${b.paymentId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
    });

    it("only includes the caller's allocations on the detail view", async () => {
      const res = await request(app)
        .get(`/supplier-payments/${a.paymentId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const allocIds = res.body.allocations.map((x: { id: number }) => x.id);
      expect(allocIds).toEqual([a.allocationId]);
      expect(allocIds).not.toContain(b.allocationId);
      expect(
        res.body.allocations.map(
          (x: { purchaseOrderNumber: string }) => x.purchaseOrderNumber,
        ),
      ).toEqual([`PO-A-1`]);
    });
  });

  describe("POST /supplier-payments", () => {
    it("rejects an allocation that targets the other org's purchase order", async () => {
      const beforeBPaid = (
        (await memDb.rowsOf("purchase_orders"))
          .find((r) => r.id === b.purchaseOrderId) as { amountPaid: string }
      ).amountPaid;

      const res = await request(app)
        .post("/supplier-payments")
        .set("x-test-org-id", String(ORG_A))
        .send({
          supplierId: a.supplierId,
          amount: 10,
          mode: "bank",
          paymentDate: "2026-03-01",
          allocations: [{ purchaseOrderId: b.purchaseOrderId, amount: 10 }],
        });
      expect(res.status).toBe(400);

      const afterBPaid = (
        (await memDb.rowsOf("purchase_orders"))
          .find((r) => r.id === b.purchaseOrderId) as { amountPaid: string }
      ).amountPaid;
      expect(afterBPaid).toBe(beforeBPaid);
    });

    it("rejects when the caller's supplier doesn't exist in their org", async () => {
      const res = await request(app)
        .post("/supplier-payments")
        .set("x-test-org-id", String(ORG_A))
        .send({
          supplierId: b.supplierId,
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
      const bPoBefore = await snapshot("purchase_orders");
      const bSupBefore = await snapshot("suppliers");

      const res = await request(app)
        .post("/supplier-payments")
        .set("x-test-org-id", String(ORG_A))
        .send({
          supplierId: a.supplierId,
          amount: 25,
          mode: "bank",
          paymentDate: "2026-03-15",
          allocations: [{ purchaseOrderId: a.purchaseOrderId, amount: 25 }],
        });
      expect(res.status).toBe(201);

      expect(await snapshot("purchase_orders")).toBe(bPoBefore);
      expect(await snapshot("suppliers")).toBe(bSupBefore);

      const created = (await memDb.rowsOf("supplier_payments"))
        .find((r) => r.id === res.body.payment.id);
      expect(created?.organizationId).toBe(ORG_A);
    });
  });

  describe("DELETE /supplier-payments/:id", () => {
    it("returns 404 and never touches the other org's data when targeting cross-tenant", async () => {
      const beforeBPayments = (await memDb.rowsOf("supplier_payments")).length;
      const beforeBAllocs = (await memDb.rowsOf("supplier_payment_allocations")).length;
      const beforeBOrder = JSON.stringify(
        (await memDb.rowsOf("purchase_orders"))
          .find((r) => r.id === b.purchaseOrderId),
      );

      const res = await request(app)
        .delete(`/supplier-payments/${b.paymentId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);

      expect((await memDb.rowsOf("supplier_payments")).length).toBe(beforeBPayments);
      expect((await memDb.rowsOf("supplier_payment_allocations")).length).toBe(
        beforeBAllocs,
      );
      const afterBOrder = JSON.stringify(
        (await memDb.rowsOf("purchase_orders"))
          .find((r) => r.id === b.purchaseOrderId),
      );
      expect(afterBOrder).toBe(beforeBOrder);
    });

    it("a same-org delete reverses only the caller's totals", async () => {
      // Snapshot scalars (not row references) so the post-delete
      // view doesn't read back the same row we're about to mutate.
      const aOrderRef = (await memDb.rowsOf("purchase_orders"))
        .find((r) => r.id === a.purchaseOrderId)!;
      const aBalBefore = Number(aOrderRef.balanceDue);
      const aPaidBefore = Number(aOrderRef.amountPaid);
      const bOrderBefore = JSON.stringify(
        (await memDb.rowsOf("purchase_orders"))
          .find((r) => r.id === b.purchaseOrderId),
      );

      const res = await request(app)
        .delete(`/supplier-payments/${a.paymentId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(204);

      const aOrderAfter = (await memDb.rowsOf("purchase_orders"))
        .find((r) => r.id === a.purchaseOrderId);
      expect(Number(aOrderAfter?.balanceDue)).toBe(aBalBefore + 40);
      expect(Number(aOrderAfter?.amountPaid)).toBe(aPaidBefore - 40);
      const bOrderAfter = JSON.stringify(
        (await memDb.rowsOf("purchase_orders"))
          .find((r) => r.id === b.purchaseOrderId),
      );
      expect(bOrderAfter).toBe(bOrderBefore);
    });
  });
});
