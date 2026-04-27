import { Router, type IRouter } from "express";
import { eq, and, isNull } from "drizzle-orm";
import crypto from "node:crypto";
import { z } from "zod";
import { getAuth } from "@clerk/express";
import {
  db,
  organizationMembersTable,
  teamInvitationsTable,
  usersTable,
} from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import { validateBody } from "../lib/validate";

const router: IRouter = Router();

function serializeMember(row: {
  id: number;
  userId: number;
  email: string;
  name: string | null;
  role: string;
  createdAt: Date;
}) {
  return {
    id: row.id,
    userId: row.userId,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeInvitation(row: typeof teamInvitationsTable.$inferSelect) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    token: row.token,
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function requireOwner(organizationId: number, userId: number): Promise<boolean> {
  const rows = await db
    .select({ role: organizationMembersTable.role })
    .from(organizationMembersTable)
    .where(
      and(
        eq(organizationMembersTable.organizationId, organizationId),
        eq(organizationMembersTable.userId, userId),
      ),
    )
    .limit(1);
  return rows[0]?.role === "owner";
}

const createInvitationSchema = z.object({
  email: z.string().email(),
  role: z.enum(["member", "admin", "owner"]).default("member"),
});

const updateRoleSchema = z.object({
  role: z.enum(["member", "admin", "owner"]),
});

const acceptInvitationSchema = z.object({
  token: z.string().min(8).max(128),
});

router.get("/team/members", tenantMiddleware, async (req, res, next) => {
  try {
    const t = req.tenant!;
    const rows = await db
      .select({
        id: organizationMembersTable.id,
        userId: organizationMembersTable.userId,
        email: usersTable.email,
        name: usersTable.name,
        role: organizationMembersTable.role,
        createdAt: organizationMembersTable.createdAt,
      })
      .from(organizationMembersTable)
      .innerJoin(usersTable, eq(usersTable.id, organizationMembersTable.userId))
      .where(eq(organizationMembersTable.organizationId, t.organizationId))
      .orderBy(organizationMembersTable.createdAt);
    res.json(rows.map(serializeMember));
  } catch (err) {
    next(err);
  }
});

router.get("/team/invitations/list", tenantMiddleware, async (req, res, next) => {
  try {
    const t = req.tenant!;
    const rows = await db
      .select()
      .from(teamInvitationsTable)
      .where(
        and(
          eq(teamInvitationsTable.organizationId, t.organizationId),
          isNull(teamInvitationsTable.acceptedAt),
        ),
      )
      .orderBy(teamInvitationsTable.createdAt);
    res.json(rows.map(serializeInvitation));
  } catch (err) {
    next(err);
  }
});

router.post(
  "/team/invitations",
  tenantMiddleware,
  validateBody(createInvitationSchema),
  async (req, res, next) => {
    try {
      const t = req.tenant!;
      if (!(await requireOwner(t.organizationId, t.userId))) {
        res.status(403).json({ error: "Only owners can invite members" });
        return;
      }
      const b = req.body as z.infer<typeof createInvitationSchema>;
      const token = crypto.randomBytes(24).toString("hex");
      const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      const inserted = await db
        .insert(teamInvitationsTable)
        .values({
          organizationId: t.organizationId,
          email: b.email.toLowerCase(),
          role: b.role,
          token,
          invitedByUserId: t.userId,
          expiresAt,
        })
        .returning();
      res.status(201).json(serializeInvitation(inserted[0]!));
    } catch (err) {
      next(err);
    }
  },
);

router.delete("/team/invitations/:id", tenantMiddleware, async (req, res, next) => {
  try {
    const t = req.tenant!;
    if (!(await requireOwner(t.organizationId, t.userId))) {
      res.status(403).json({ error: "Only owners can revoke invitations" });
      return;
    }
    const id = Number(req.params.id);
    await db
      .delete(teamInvitationsTable)
      .where(
        and(
          eq(teamInvitationsTable.id, id),
          eq(teamInvitationsTable.organizationId, t.organizationId),
        ),
      );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.post(
  "/team/invitations/accept",
  validateBody(acceptInvitationSchema),
  async (req, res, next) => {
    try {
      const auth = getAuth(req);
      if (!auth.userId) {
        res.status(401).json({ error: "Sign in to accept the invitation" });
        return;
      }
      const userRows = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.clerkUserId, auth.userId))
        .limit(1);
      const user = userRows[0];
      if (!user) {
        res.status(400).json({ error: "Complete onboarding before accepting an invitation" });
        return;
      }
      const b = req.body as z.infer<typeof acceptInvitationSchema>;
      const invRows = await db
        .select()
        .from(teamInvitationsTable)
        .where(eq(teamInvitationsTable.token, b.token))
        .limit(1);
      const inv = invRows[0];
      if (!inv || inv.acceptedAt) {
        res.status(404).json({ error: "Invitation is invalid or already used" });
        return;
      }
      if (inv.expiresAt.getTime() < Date.now()) {
        res.status(400).json({ error: "Invitation has expired" });
        return;
      }
      if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
        res.status(400).json({
          error: "Invitation was sent to a different email address",
        });
        return;
      }

      const existing = await db
        .select({ id: organizationMembersTable.id })
        .from(organizationMembersTable)
        .where(
          and(
            eq(organizationMembersTable.userId, user.id),
            eq(organizationMembersTable.organizationId, inv.organizationId),
          ),
        )
        .limit(1);
      let memberId: number;
      if (existing[0]) {
        memberId = existing[0].id;
        await db
          .update(organizationMembersTable)
          .set({ role: inv.role })
          .where(eq(organizationMembersTable.id, memberId));
      } else {
        const created = await db
          .insert(organizationMembersTable)
          .values({
            userId: user.id,
            organizationId: inv.organizationId,
            role: inv.role,
          })
          .returning();
        memberId = created[0]!.id;
      }
      await db
        .update(teamInvitationsTable)
        .set({ acceptedAt: new Date() })
        .where(eq(teamInvitationsTable.id, inv.id));

      res.json(
        serializeMember({
          id: memberId,
          userId: user.id,
          email: user.email,
          name: user.name,
          role: inv.role,
          createdAt: new Date(),
        }),
      );
    } catch (err) {
      next(err);
    }
  },
);

router.patch(
  "/team/members/:id",
  tenantMiddleware,
  validateBody(updateRoleSchema),
  async (req, res, next) => {
    try {
      const t = req.tenant!;
      if (!(await requireOwner(t.organizationId, t.userId))) {
        res.status(403).json({ error: "Only owners can change member roles" });
        return;
      }
      const id = Number(req.params.id);
      const b = req.body as z.infer<typeof updateRoleSchema>;
      const rows = await db
        .update(organizationMembersTable)
        .set({ role: b.role })
        .where(
          and(
            eq(organizationMembersTable.id, id),
            eq(organizationMembersTable.organizationId, t.organizationId),
          ),
        )
        .returning();
      const m = rows[0];
      if (!m) {
        res.status(404).json({ error: "Member not found" });
        return;
      }
      const userRows = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, m.userId))
        .limit(1);
      const u = userRows[0]!;
      res.json(
        serializeMember({
          id: m.id,
          userId: m.userId,
          email: u.email,
          name: u.name,
          role: m.role,
          createdAt: m.createdAt,
        }),
      );
    } catch (err) {
      next(err);
    }
  },
);

router.delete("/team/members/:id", tenantMiddleware, async (req, res, next) => {
  try {
    const t = req.tenant!;
    if (!(await requireOwner(t.organizationId, t.userId))) {
      res.status(403).json({ error: "Only owners can remove members" });
      return;
    }
    const id = Number(req.params.id);
    const rows = await db
      .select()
      .from(organizationMembersTable)
      .where(
        and(
          eq(organizationMembersTable.id, id),
          eq(organizationMembersTable.organizationId, t.organizationId),
        ),
      )
      .limit(1);
    const m = rows[0];
    if (!m) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    if (m.userId === t.userId) {
      res.status(400).json({ error: "You cannot remove yourself" });
      return;
    }
    await db
      .delete(organizationMembersTable)
      .where(eq(organizationMembersTable.id, id));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
