import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, organizationsTable } from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import { getPlan } from "../lib/plans";
import { validateBody } from "../lib/validate";
import { serializeOrganization } from "../lib/serializers";

const router: IRouter = Router();
router.use(tenantMiddleware);

const onboardingSchema = z.object({
  organizationName: z.string().min(1).max(120),
  gstNumber: z.string().max(20).nullable().optional(),
  addressLine1: z.string().max(200).nullable().optional(),
  city: z.string().max(80).nullable().optional(),
  state: z.string().max(80).nullable().optional(),
  postalCode: z.string().max(12).nullable().optional(),
  plan: z.string().min(1),
});

router.post(
  "/onboarding",
  validateBody(onboardingSchema),
  async (req, res, next) => {
    try {
      const t = req.tenant!;
      const b = req.body as z.infer<typeof onboardingSchema>;
      const plan = getPlan(b.plan);
      if (!plan) {
        res.status(400).json({ error: "Unknown plan" });
        return;
      }
      const updated = await db
        .update(organizationsTable)
        .set({
          name: b.organizationName,
          gstNumber: b.gstNumber ?? null,
          addressLine1: b.addressLine1 ?? null,
          city: b.city ?? null,
          state: b.state ?? null,
          postalCode: b.postalCode ?? null,
          plan: plan.id,
          onboardingCompletedAt: new Date(),
        })
        .where(eq(organizationsTable.id, t.organizationId))
        .returning();
      res.json(serializeOrganization(updated[0]!));
    } catch (err) {
      next(err);
    }
  },
);

export default router;
