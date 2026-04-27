import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, organizationsTable } from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import { serializeOrganization } from "../lib/serializers";

const router: IRouter = Router();

router.use(tenantMiddleware);

router.get("/organizations/current", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const rows = await db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, t.organizationId))
      .limit(1);
    res.json(serializeOrganization(rows[0]!));
  } catch (err) {
    next(err);
  }
});

router.patch("/organizations/current", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const body = req.body ?? {};
    const updates: Record<string, unknown> = {};
    for (const k of [
      "name",
      "currency",
      "timezone",
      "gstNumber",
      "addressLine1",
      "addressLine2",
      "city",
      "state",
      "postalCode",
      "country",
      "logoUrl",
      "invoiceFooter",
    ]) {
      if (k in body) updates[k] = body[k];
    }
    const updated = await db
      .update(organizationsTable)
      .set(updates)
      .where(eq(organizationsTable.id, t.organizationId))
      .returning();
    res.json(serializeOrganization(updated[0]!));
  } catch (err) {
    next(err);
  }
});

export default router;
