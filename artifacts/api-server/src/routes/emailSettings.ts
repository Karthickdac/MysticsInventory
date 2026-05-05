import { Router, type IRouter } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, emailSettingsTable } from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import { validateBody } from "../lib/validate";
import { encryptString } from "../lib/encryption";

const router: IRouter = Router();

function publicSettings(row: typeof emailSettingsTable.$inferSelect) {
  return {
    id: row.id,
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    fromEmail: row.fromEmail,
    fromName: row.fromName,
    // Never return the encrypted password — clients should send a new
    // one if they want to change it.
    hasPassword: row.passwordEncrypted.length > 0,
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get("/email-settings", tenantMiddleware, async (req, res, next) => {
  try {
    const t = req.tenant!;
    if (t.role !== "owner" && t.role !== "admin" && !t.isSuperAdmin) {
      res.status(403).json({
        error: "Only owners or admins can view email settings",
      });
      return;
    }
    const rows = await db
      .select()
      .from(emailSettingsTable)
      .where(eq(emailSettingsTable.organizationId, t.organizationId))
      .limit(1);
    res.json(rows[0] ? publicSettings(rows[0]) : null);
  } catch (err) {
    next(err);
  }
});

const upsertSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.enum(["ssl", "starttls", "none"]),
  username: z.string().trim().min(1).max(255),
  // Optional — when omitted on PUT, keep the existing encrypted value.
  password: z.string().min(1).max(500).optional(),
  fromEmail: z.string().email().max(254),
  fromName: z.string().trim().max(120).nullable().optional(),
});

router.put(
  "/email-settings",
  tenantMiddleware,
  validateBody(upsertSchema),
  async (req, res, next) => {
    try {
      const t = req.tenant!;
      if (t.role !== "owner" && t.role !== "admin" && !t.isSuperAdmin) {
        res.status(403).json({
          error: "Only owners or admins can update email settings",
        });
        return;
      }
      const b = req.body as z.infer<typeof upsertSchema>;
      const existing = await db
        .select()
        .from(emailSettingsTable)
        .where(eq(emailSettingsTable.organizationId, t.organizationId))
        .limit(1);
      const passwordEncrypted = b.password
        ? encryptString(b.password)
        : existing[0]?.passwordEncrypted;
      if (!passwordEncrypted) {
        res.status(400).json({ error: "Password is required" });
        return;
      }
      const values = {
        organizationId: t.organizationId,
        host: b.host,
        port: b.port,
        secure: b.secure,
        username: b.username,
        passwordEncrypted,
        fromEmail: b.fromEmail,
        fromName: b.fromName ?? null,
      };
      let row;
      if (existing[0]) {
        const updated = await db
          .update(emailSettingsTable)
          .set(values)
          .where(
            and(
              eq(emailSettingsTable.id, existing[0].id),
              eq(emailSettingsTable.organizationId, t.organizationId),
            ),
          )
          .returning();
        row = updated[0]!;
      } else {
        const inserted = await db
          .insert(emailSettingsTable)
          .values(values)
          .returning();
        row = inserted[0]!;
      }
      res.json(publicSettings(row));
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  "/email-settings",
  tenantMiddleware,
  async (req, res, next) => {
    try {
      const t = req.tenant!;
      if (t.role !== "owner" && t.role !== "admin" && !t.isSuperAdmin) {
        res.status(403).json({
          error: "Only owners or admins can delete email settings",
        });
        return;
      }
      await db
        .delete(emailSettingsTable)
        .where(eq(emailSettingsTable.organizationId, t.organizationId));
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

export default router;
