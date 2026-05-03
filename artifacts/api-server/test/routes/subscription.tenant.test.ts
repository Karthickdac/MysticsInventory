// Cross-tenant isolation tests for the /subscription router.

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
  getRazorpay: () => ({
    plans: { create: vi.fn(async () => ({ id: "plan_test" })) },
    subscriptions: {
      create: vi.fn(async () => ({ id: "sub_test_new" })),
    },
  }),
  verifySubscriptionSignature: () => true,
}));

import subscriptionRouter from "../../src/routes/subscription";

const ORG_A = 1001;
const ORG_B = 2002;

async function seedOrg(label: "A" | "B", orgId: number, plan: string): Promise<void> {
  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
    plan,
    subscriptionStatus: plan === "free" ? "trialing" : "active",
    razorpaySubscriptionId: plan === "free" ? null : `sub_${label}`,
    currentPeriodEnd:
      plan === "free" ? null : new Date(Date.now() + 30 * 86_400_000),
    trialEndsAt: plan === "free" ? new Date(Date.now() + 14 * 86_400_000) : null,
  });
  await memDb.seed(tables.organizationMembersTable, {
    organizationId: orgId,
    userId: orgId * 10,
    role: "owner",
  });
  await memDb.seed(tables.usersTable, {
    id: orgId * 10,
    clerkUserId: `user_test_${orgId}`,
    email: `owner-${label.toLowerCase()}@example.com`,
    name: `Owner ${label}`,
  });
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(subscriptionRouter);
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

describe("subscription cross-tenant isolation", () => {
  let app: Express;

  beforeEach(async () => {
    await memDb.reset();
    await seedOrg("A", ORG_A, "free");
    await seedOrg("B", ORG_B, "growth");
    app = buildApp();
  });

  describe("auth", () => {
    it("rejects requests without x-test-org-id", async () => {
      const res = await request(app).get("/subscription");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /subscription", () => {
    it("returns ORG_A's plan only", async () => {
      const res = await request(app)
        .get("/subscription")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      expect(res.body.plan).toBe("free");
      expect(res.body.razorpaySubscriptionId).toBeNull();
    });

    it("returns ORG_B's plan only", async () => {
      const res = await request(app)
        .get("/subscription")
        .set("x-test-org-id", String(ORG_B));
      expect(res.status).toBe(200);
      expect(res.body.plan).toBe("growth");
      expect(res.body.razorpaySubscriptionId).toBe("sub_B");
    });
  });

  describe("POST /subscription/verify", () => {
    it("rejects when subscription id belongs to a different org", async () => {
      const res = await request(app)
        .post("/subscription/verify")
        .set("x-test-org-id", String(ORG_A))
        .send({
          razorpayPaymentId: "pay_x",
          razorpaySubscriptionId: "sub_B",
          razorpaySignature: "sig",
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/does not belong/iu);
      const orgB = (await memDb
        .rowsOf(tables.organizationsTable.__table))
        .find((r) => r.id === ORG_B);
      // ORG_B's subscription state must be untouched.
      expect(orgB?.subscriptionStatus).toBe("active");
    });

    it("ORG_B can verify its own subscription", async () => {
      const res = await request(app)
        .post("/subscription/verify")
        .set("x-test-org-id", String(ORG_B))
        .send({
          razorpayPaymentId: "pay_y",
          razorpaySubscriptionId: "sub_B",
          razorpaySignature: "sig",
        });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("active");
      // ORG_A must still be in its original `trialing` state.
      const orgA = (await memDb
        .rowsOf(tables.organizationsTable.__table))
        .find((r) => r.id === ORG_A);
      expect(orgA?.subscriptionStatus).toBe("trialing");
    });
  });
});
