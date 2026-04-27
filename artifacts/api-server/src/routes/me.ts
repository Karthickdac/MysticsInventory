import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable, organizationsTable } from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import { serializeOrganization } from "../lib/serializers";

const router: IRouter = Router();

router.get("/me", tenantMiddleware, async (req, res, next) => {
  try {
    const t = req.tenant!;
    const userRows = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, t.userId))
      .limit(1);
    const orgRows = await db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, t.organizationId))
      .limit(1);
    const user = userRows[0]!;
    const org = orgRows[0]!;
    res.json({
      user: {
        id: user.id,
        clerkUserId: user.clerkUserId,
        email: user.email,
        name: user.name,
      },
      organization: serializeOrganization(org),
      role: t.role,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
