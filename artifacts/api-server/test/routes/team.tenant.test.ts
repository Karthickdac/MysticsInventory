// Cross-tenant isolation tests for the /team router.
//
// Each org seeds: org row, owner user/member, plus a "victim" member
// (extra user/member) so that PATCH/DELETE /team/members/:id has a
// real target. Each org also has a pending invitation.

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

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: null }),
}));

import teamRouter from "../../src/routes/team";

const ORG_A = 1001;
const ORG_B = 2002;

interface OrgFixture {
  orgId: number;
  ownerUserId: number;
  ownerMemberId: number;
  victimUserId: number;
  victimMemberId: number;
  invitationId: number;
  invitationToken: string;
}

async function seedOrg(label: "A" | "B", orgId: number): Promise<OrgFixture> {
  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
  });
  const ownerUser = await memDb.seed(tables.usersTable, {
    id: orgId * 10,
    clerkUserId: `user_test_${orgId}`,
    email: `owner-${label.toLowerCase()}@example.com`,
    name: `Owner ${label}`,
  });
  const ownerMember = await memDb.seed(tables.organizationMembersTable, {
    organizationId: orgId,
    userId: ownerUser.id,
    role: "owner",
    createdAt: new Date(2026, 0, 1),
  });
  const victimUser = await memDb.seed(tables.usersTable, {
    clerkUserId: `victim_${label}`,
    email: `victim-${label.toLowerCase()}@example.com`,
    name: `Victim ${label}`,
  });
  const victimMember = await memDb.seed(tables.organizationMembersTable, {
    organizationId: orgId,
    userId: victimUser.id,
    role: "member",
    createdAt: new Date(2026, 0, 2),
  });
  const token = `tok_${label.toLowerCase()}_pending`;
  const inv = await memDb.seed(tables.teamInvitationsTable, {
    organizationId: orgId,
    email: `invitee-${label.toLowerCase()}@example.com`,
    role: "member",
    token,
    invitedByUserId: ownerUser.id,
    expiresAt: new Date(Date.now() + 86_400_000),
    acceptedAt: null,
    createdAt: new Date(2026, 0, 3),
  });
  return {
    orgId,
    ownerUserId: ownerUser.id as number,
    ownerMemberId: ownerMember.id as number,
    victimUserId: victimUser.id as number,
    victimMemberId: victimMember.id as number,
    invitationId: inv.id as number,
    invitationToken: token,
  };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(teamRouter);
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

describe("team cross-tenant isolation", () => {
  let app: Express;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeEach(async () => {
    await memDb.reset();
    a = await seedOrg("A", ORG_A);
    b = await seedOrg("B", ORG_B);
    app = buildApp();
  });

  describe("auth", () => {
    it("rejects requests without x-test-org-id", async () => {
      const res = await request(app).get("/team/members");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /team/members", () => {
    it("returns only the caller's members", async () => {
      const res = await request(app)
        .get("/team/members")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const emails = (res.body as Array<{ email: string }>).map((m) => m.email);
      expect(emails).toContain("owner-a@example.com");
      expect(emails).toContain("victim-a@example.com");
      expect(emails).not.toContain("owner-b@example.com");
      expect(emails).not.toContain("victim-b@example.com");
    });

    it("ORG_B sees only its own members", async () => {
      const res = await request(app)
        .get("/team/members")
        .set("x-test-org-id", String(ORG_B));
      expect(res.status).toBe(200);
      const emails = (res.body as Array<{ email: string }>).map((m) => m.email);
      expect(emails).toContain("owner-b@example.com");
      expect(emails).not.toContain("owner-a@example.com");
    });
  });

  describe("GET /team/invitations/list", () => {
    it("returns only the caller's pending invitations", async () => {
      const res = await request(app)
        .get("/team/invitations/list")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const emails = (res.body as Array<{ email: string }>).map(
        (m) => m.email,
      );
      expect(emails).toEqual(["invitee-a@example.com"]);
    });
  });

  describe("DELETE /team/invitations/:id", () => {
    it("ORG_A cannot revoke ORG_B's invitation", async () => {
      const res = await request(app)
        .delete(`/team/invitations/${b.invitationId}`)
        .set("x-test-org-id", String(ORG_A));
      // The route returns 204 even if the row didn't exist (no-op
      // delete) but the row must still be present in the DB.
      expect([204, 404]).toContain(res.status);
      const remaining = (await memDb
        .rowsOf(tables.teamInvitationsTable.__table))
        .find((r) => r.id === b.invitationId);
      expect(remaining).toBeDefined();
    });

    it("ORG_B can revoke its own invitation", async () => {
      const res = await request(app)
        .delete(`/team/invitations/${b.invitationId}`)
        .set("x-test-org-id", String(ORG_B));
      expect(res.status).toBe(204);
      const remaining = (await memDb
        .rowsOf(tables.teamInvitationsTable.__table))
        .find((r) => r.id === b.invitationId);
      expect(remaining).toBeUndefined();
    });
  });

  describe("PATCH /team/members/:id", () => {
    it("ORG_A cannot change the role of an ORG_B member", async () => {
      const res = await request(app)
        .patch(`/team/members/${b.victimMemberId}`)
        .set("x-test-org-id", String(ORG_A))
        .send({ role: "admin" });
      expect(res.status).toBe(404);
      const row = (await memDb
        .rowsOf(tables.organizationMembersTable.__table))
        .find((r) => r.id === b.victimMemberId);
      expect(row?.role).toBe("member");
    });
  });

  describe("DELETE /team/members/:id", () => {
    it("ORG_A cannot remove an ORG_B member", async () => {
      const res = await request(app)
        .delete(`/team/members/${b.victimMemberId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
      const row = (await memDb
        .rowsOf(tables.organizationMembersTable.__table))
        .find((r) => r.id === b.victimMemberId);
      expect(row).toBeDefined();
    });

    it("ORG_B can remove its own member", async () => {
      const res = await request(app)
        .delete(`/team/members/${b.victimMemberId}`)
        .set("x-test-org-id", String(ORG_B));
      expect(res.status).toBe(204);
      const row = (await memDb
        .rowsOf(tables.organizationMembersTable.__table))
        .find((r) => r.id === b.victimMemberId);
      expect(row).toBeUndefined();
    });
  });

  // Sanity: a and b share no member IDs, and the seeded fixtures are
  // distinct so leakage would actually be observable.
  it("seeded fixtures are disjoint", () => {
    expect(a.ownerMemberId).not.toBe(b.ownerMemberId);
    expect(a.invitationId).not.toBe(b.invitationId);
  });
});
