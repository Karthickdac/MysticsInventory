// Cross-tenant isolation tests for the suppliers router.
//
// Same shape as customers.tenant.test.ts: identical CRUD surface plus
// the same ilike-based ?search= filter that needs the org scope to
// stay glued on.

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
  inMemoryDrizzleOrmMock,
  memDb,
  tables,
} from "../helpers/inMemoryDb";

vi.mock("@workspace/db", () => createInMemoryDbModuleMock());
vi.mock("drizzle-orm", () => inMemoryDrizzleOrmMock);
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

import suppliersRouter from "../../src/routes/suppliers";

const ORG_A = 1001;
const ORG_B = 2002;

interface OrgFixture {
  orgId: number;
  supplierId: number;
  sharedNameSupplierId: number;
}

function seedOrg(label: "A" | "B", orgId: number): OrgFixture {
  memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
  });
  const supplier = memDb.seed(tables.suppliersTable, {
    organizationId: orgId,
    name: `Supplier ${label}`,
    email: `${label.toLowerCase()}@vendor.com`,
    phone: null,
    company: `Vendor ${label}`,
    gstNumber: null,
    address: null,
    notes: null,
    isJobWorker: false,
    outstandingPayable: "0",
  });
  const shared = memDb.seed(tables.suppliersTable, {
    organizationId: orgId,
    name: `Shared Globex ${label}`,
    email: null,
    phone: null,
    company: null,
    gstNumber: null,
    address: null,
    notes: null,
    isJobWorker: false,
    outstandingPayable: "0",
  });
  return {
    orgId,
    supplierId: supplier.id as number,
    sharedNameSupplierId: shared.id as number,
  };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(suppliersRouter);
  return app;
}

describe("suppliers cross-tenant isolation", () => {
  let app: Express;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeEach(() => {
    memDb.reset();
    a = seedOrg("A", ORG_A);
    b = seedOrg("B", ORG_B);
    app = buildApp();
  });

  describe("GET /suppliers", () => {
    it("only returns the caller's suppliers", async () => {
      const res = await request(app)
        .get("/suppliers")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const ids = res.body.map((s: { id: number }) => s.id).sort();
      expect(ids).toEqual([a.supplierId, a.sharedNameSupplierId].sort());
      expect(ids).not.toContain(b.supplierId);
      expect(ids).not.toContain(b.sharedNameSupplierId);
    });

    it("the ?search= filter never crosses org boundaries", async () => {
      const res = await request(app)
        .get("/suppliers?search=Globex")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const ids = res.body.map((s: { id: number }) => s.id);
      expect(ids).toEqual([a.sharedNameSupplierId]);
      expect(ids).not.toContain(b.sharedNameSupplierId);
    });
  });

  describe("GET /suppliers/:id", () => {
    it("returns 404 when fetching the other org's supplier", async () => {
      const resA = await request(app)
        .get(`/suppliers/${b.supplierId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(resA.status).toBe(404);

      const resB = await request(app)
        .get(`/suppliers/${a.supplierId}`)
        .set("x-test-org-id", String(ORG_B));
      expect(resB.status).toBe(404);
    });
  });

  describe("PATCH /suppliers/:id", () => {
    it("returns 404 and never mutates the other org's row", async () => {
      const before = (
        memDb.rowsOf("suppliers").find((r) => r.id === b.supplierId) as {
          name: string;
        }
      ).name;
      const res = await request(app)
        .patch(`/suppliers/${b.supplierId}`)
        .set("x-test-org-id", String(ORG_A))
        .send({ name: "Hacked" });
      expect(res.status).toBe(404);
      const after = (
        memDb.rowsOf("suppliers").find((r) => r.id === b.supplierId) as {
          name: string;
        }
      ).name;
      expect(after).toBe(before);
    });
  });

  describe("DELETE /suppliers/:id", () => {
    it("returns 204 but never removes the other org's row", async () => {
      const beforeBCount = memDb.rowsOf("suppliers").filter(
        (r) => r.organizationId === ORG_B,
      ).length;
      const res = await request(app)
        .delete(`/suppliers/${b.supplierId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(204);
      const afterBCount = memDb.rowsOf("suppliers").filter(
        (r) => r.organizationId === ORG_B,
      ).length;
      expect(afterBCount).toBe(beforeBCount);
      expect(
        memDb.rowsOf("suppliers").some((r) => r.id === b.supplierId),
      ).toBe(true);
    });
  });

  describe("POST /suppliers", () => {
    it("stamps the caller's organizationId regardless of body content", async () => {
      const beforeBCount = memDb.rowsOf("suppliers").filter(
        (r) => r.organizationId === ORG_B,
      ).length;
      const res = await request(app)
        .post("/suppliers")
        .set("x-test-org-id", String(ORG_A))
        .send({ name: "New A Sup", organizationId: ORG_B });
      expect(res.status).toBe(201);
      const newRow = memDb
        .rowsOf("suppliers")
        .find((r) => r.id === res.body.id);
      expect(newRow?.organizationId).toBe(ORG_A);
      const afterBCount = memDb.rowsOf("suppliers").filter(
        (r) => r.organizationId === ORG_B,
      ).length;
      expect(afterBCount).toBe(beforeBCount);
    });
  });
});
