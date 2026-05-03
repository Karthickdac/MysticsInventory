// Cross-tenant isolation tests for the customers router.
//
// Mirrors the structure of jobWorkOrders.tenant.test.ts: two orgs are
// seeded side-by-side and every read/mutation endpoint is checked for
// leakage. The list endpoint is also exercised with the `?search=`
// query parameter to confirm the ilike-based filter still respects the
// org scope.

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

import customersRouter from "../../src/routes/customers";

const ORG_A = 1001;
const ORG_B = 2002;

interface OrgFixture {
  orgId: number;
  customerId: number;
  sharedNameCustomerId: number;
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
    email: `${label.toLowerCase()}@example.com`,
    phone: null,
    company: `Co ${label}`,
    gstNumber: null,
    billingAddress: null,
    shippingAddress: null,
    placeOfSupply: null,
    notes: null,
    outstandingBalance: "0",
  });
  // A second customer with the same shared substring in its name so
  // the search-filter test can assert org B's matching row never
  // appears in org A's response (and vice versa).
  const shared = await memDb.seed(tables.customersTable, {
    organizationId: orgId,
    name: `Shared Acme ${label}`,
    email: null,
    phone: null,
    company: null,
    gstNumber: null,
    billingAddress: null,
    shippingAddress: null,
    placeOfSupply: null,
    notes: null,
    outstandingBalance: "0",
  });
  return {
    orgId,
    customerId: customer.id as number,
    sharedNameCustomerId: shared.id as number,
  };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(customersRouter);
  return app;
}

describe("customers cross-tenant isolation", () => {
  let app: Express;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeEach(async () => {
    await memDb.reset();
    a = await seedOrg("A", ORG_A);
    b = await seedOrg("B", ORG_B);
    app = buildApp();
  });

  describe("GET /customers", () => {
    it("only returns the caller's customers", async () => {
      const resA = await request(app)
        .get("/customers")
        .set("x-test-org-id", String(ORG_A));
      expect(resA.status).toBe(200);
      const idsA = resA.body.map((c: { id: number }) => c.id).sort();
      expect(idsA).toEqual([a.customerId, a.sharedNameCustomerId].sort());
      expect(idsA).not.toContain(b.customerId);
      expect(idsA).not.toContain(b.sharedNameCustomerId);
    });

    it("the ?search= filter never crosses org boundaries", async () => {
      // Both orgs have a "Shared Acme …" row. A search for "Acme"
      // should still only surface the caller's row.
      const res = await request(app)
        .get("/customers?search=Acme")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const ids = res.body.map((c: { id: number }) => c.id);
      expect(ids).toEqual([a.sharedNameCustomerId]);
      expect(ids).not.toContain(b.sharedNameCustomerId);
    });
  });

  describe("GET /customers/:id", () => {
    it("returns 404 when fetching the other org's customer", async () => {
      const resA = await request(app)
        .get(`/customers/${b.customerId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(resA.status).toBe(404);

      const resB = await request(app)
        .get(`/customers/${a.customerId}`)
        .set("x-test-org-id", String(ORG_B));
      expect(resB.status).toBe(404);
    });
  });

  describe("PATCH /customers/:id", () => {
    it("returns 404 and never mutates the other org's row", async () => {
      const before = (
        (await memDb.rowsOf("customers")).find((r) => r.id === b.customerId) as {
          name: string;
        }
      ).name;
      const res = await request(app)
        .patch(`/customers/${b.customerId}`)
        .set("x-test-org-id", String(ORG_A))
        .send({ name: "Hacked" });
      expect(res.status).toBe(404);
      const after = (
        (await memDb.rowsOf("customers")).find((r) => r.id === b.customerId) as {
          name: string;
        }
      ).name;
      expect(after).toBe(before);
    });
  });

  describe("DELETE /customers/:id", () => {
    it("returns 204 but never removes the other org's row", async () => {
      const beforeBCount = (await memDb.rowsOf("customers")).filter(
        (r) => r.organizationId === ORG_B,
      ).length;
      const res = await request(app)
        .delete(`/customers/${b.customerId}`)
        .set("x-test-org-id", String(ORG_A));
      // The route doesn't 404 on absent rows — it just deletes nothing.
      // What we care about is that org B's row survives.
      expect(res.status).toBe(204);
      const afterBCount = (await memDb.rowsOf("customers")).filter(
        (r) => r.organizationId === ORG_B,
      ).length;
      expect(afterBCount).toBe(beforeBCount);
      expect(
        (await memDb.rowsOf("customers")).some((r) => r.id === b.customerId),
      ).toBe(true);
    });
  });

  describe("POST /customers", () => {
    it("stamps the caller's organizationId and never bleeds into the other org", async () => {
      const beforeBCount = (await memDb.rowsOf("customers")).filter(
        (r) => r.organizationId === ORG_B,
      ).length;
      const res = await request(app)
        .post("/customers")
        .set("x-test-org-id", String(ORG_A))
        .send({ name: "New A Cust", organizationId: ORG_B });
      expect(res.status).toBe(201);
      // The handler ignores the incoming organizationId and uses the
      // tenant's. Confirm the new row sits in org A and org B's
      // count is untouched.
      const newRow = (await memDb.rowsOf("customers"))
        .find((r) => r.id === res.body.id);
      expect(newRow?.organizationId).toBe(ORG_A);
      const afterBCount = (await memDb.rowsOf("customers")).filter(
        (r) => r.organizationId === ORG_B,
      ).length;
      expect(afterBCount).toBe(beforeBCount);
    });
  });
});
