import { Router, type IRouter } from "express";
import { eq, and, isNull, sql } from "drizzle-orm";
import crypto from "node:crypto";
import { z } from "zod";
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

async function getCallerRole(
  organizationId: number,
  userId: number,
): Promise<string | null> {
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
  return rows[0]?.role ?? null;
}

async function canManageTeam(
  organizationId: number,
  userId: number,
): Promise<boolean> {
  const role = await getCallerRole(organizationId, userId);
  return role === "owner" || role === "admin";
}

async function countOwners(organizationId: number): Promise<number> {
  const rows = await db
    .select({ id: organizationMembersTable.id })
    .from(organizationMembersTable)
    .where(
      and(
        eq(organizationMembersTable.organizationId, organizationId),
        eq(organizationMembersTable.role, "owner"),
      ),
    );
  return rows.length;
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
      if (!(await canManageTeam(t.organizationId, t.userId))) {
        res.status(403).json({ error: "Only owners or admins can invite members" });
        return;
      }
      const b = req.body as z.infer<typeof createInvitationSchema>;
      // Only owners can mint another owner — admins shouldn't be able to
      // promote someone above themselves.
      if (b.role === "owner") {
        const callerRole = await getCallerRole(t.organizationId, t.userId);
        if (callerRole !== "owner") {
          res.status(403).json({ error: "Only owners can invite another owner" });
          return;
        }
      }
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
    if (!(await canManageTeam(t.organizationId, t.userId))) {
      res.status(403).json({ error: "Only owners or admins can revoke invitations" });
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
      const sessionUserId = req.session?.userId;
      if (!sessionUserId) {
        res.status(401).json({ error: "Sign in to accept the invitation" });
        return;
      }
      const userRows = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, sessionUserId))
        .limit(1);
      const user = userRows[0];
      if (!user) {
        res.status(401).json({ error: "Sign in to accept the invitation" });
        return;
      }
      const b = req.body as z.infer<typeof acceptInvitationSchema>;
      const invRows = await db
        .select()
        // org-scope-allow: an invitee accepts an invitation BEFORE they're a
        // member of the target org. The token (a random secret) is what
        // identifies the invitation; we then verify it matches the user's
        // email below.
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
          .where(
            and(
              eq(organizationMembersTable.organizationId, inv.organizationId),
              eq(organizationMembersTable.id, memberId),
            ),
          );
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
        .where(
          and(
            eq(teamInvitationsTable.id, inv.id),
            eq(teamInvitationsTable.organizationId, inv.organizationId),
          ),
        );

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
      if (!(await canManageTeam(t.organizationId, t.userId))) {
        res.status(403).json({ error: "Only owners or admins can change member roles" });
        return;
      }
      const id = Number(req.params.id);
      const b = req.body as z.infer<typeof updateRoleSchema>;

      // Look up the target row up front so we can enforce safety
      // properties (last-owner, owner-only-promotes-owner) before
      // mutating anything.
      const existingRows = await db
        .select()
        .from(organizationMembersTable)
        .where(
          and(
            eq(organizationMembersTable.id, id),
            eq(organizationMembersTable.organizationId, t.organizationId),
          ),
        )
        .limit(1);
      const existing = existingRows[0];
      if (!existing) {
        res.status(404).json({ error: "Member not found" });
        return;
      }

      const callerRole = await getCallerRole(t.organizationId, t.userId);

      // Only owners can change anyone's role to or from "owner".
      // Admins can shuffle between member <-> admin.
      if (
        (b.role === "owner" || existing.role === "owner") &&
        callerRole !== "owner"
      ) {
        res.status(403).json({
          error: "Only owners can promote to or demote from owner",
        });
        return;
      }

      // The last-owner check + the actual update must be atomic:
      // two concurrent demotes could both pass an unlocked count,
      // leaving the org with zero owners. Lock the org's owner rows
      // FOR UPDATE so any concurrent demote/remove serializes
      // behind us.
      type TxResult =
        | { ok: true; row: typeof organizationMembersTable.$inferSelect | undefined }
        | { ok: false; lastOwner: true };
      const result: TxResult = await db.transaction(async (tx) => {
        if (existing.role === "owner" && b.role !== "owner") {
          const ownerRows = await tx.execute<{ id: number }>(sql`
            SELECT id FROM organization_members
             WHERE organization_id = ${t.organizationId}
               AND role = 'owner'
             FOR UPDATE
          `);
          if (ownerRows.rows.length <= 1) {
            return { ok: false, lastOwner: true } as const;
          }
        }
        const updated = await tx
          .update(organizationMembersTable)
          .set({ role: b.role })
          .where(
            and(
              eq(organizationMembersTable.id, id),
              eq(organizationMembersTable.organizationId, t.organizationId),
            ),
          )
          .returning();
        return { ok: true, row: updated[0] } as const;
      });
      if (!result.ok) {
        res.status(400).json({
          error: "Cannot demote the last owner. Promote another member to owner first.",
        });
        return;
      }
      const m = result.row;
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
    if (!(await canManageTeam(t.organizationId, t.userId))) {
      res.status(403).json({ error: "Only owners or admins can remove members" });
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
    // Only owners can remove other owners.
    const callerRole = await getCallerRole(t.organizationId, t.userId);
    if (m.role === "owner" && callerRole !== "owner") {
      res.status(403).json({ error: "Only owners can remove another owner" });
      return;
    }
    // Atomic last-owner check + delete (see PATCH route for rationale).
    const lastOwner = await db.transaction(async (tx) => {
      if (m.role === "owner") {
        const ownerRows = await tx.execute<{ id: number }>(sql`
          SELECT id FROM organization_members
           WHERE organization_id = ${t.organizationId}
             AND role = 'owner'
           FOR UPDATE
        `);
        if (ownerRows.rows.length <= 1) {
          return true;
        }
      }
      await tx
        .delete(organizationMembersTable)
        .where(
          and(
            eq(organizationMembersTable.id, id),
            eq(organizationMembersTable.organizationId, t.organizationId),
          ),
        );
      return false;
    });
    if (lastOwner) {
      res.status(400).json({
        error: "Cannot remove the last owner. Promote another member to owner first.",
      });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
