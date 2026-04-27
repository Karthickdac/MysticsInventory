import { Router, type IRouter, type Request } from "express";
import { eq } from "drizzle-orm";
import { db, organizationsTable } from "@workspace/db";
import { verifyWebhookSignature } from "../lib/razorpay";

const router: IRouter = Router();

interface SubscriptionEntity {
  id: string;
  status?: string;
  current_end?: number;
  notes?: { organizationId?: string; planId?: string } | null;
}

interface WebhookPayload {
  event: string;
  payload?: {
    subscription?: { entity?: SubscriptionEntity };
    payment?: { entity?: { subscription_id?: string } };
  };
}

router.post("/razorpay/webhook", async (req, res, next) => {
  try {
    const signature = req.header("x-razorpay-signature") ?? "";
    const raw = (req as Request & { rawBody?: string }).rawBody ?? "";
    if (!verifyWebhookSignature(raw, signature)) {
      res.status(400).json({ error: "Invalid signature" });
      return;
    }

    const body = req.body as WebhookPayload;
    const event = body?.event ?? "";
    const sub: SubscriptionEntity | undefined =
      body?.payload?.subscription?.entity;

    let subscriptionId: string | undefined = sub?.id;
    if (!subscriptionId) {
      subscriptionId = body?.payload?.payment?.entity?.subscription_id;
    }
    if (!subscriptionId) {
      res.json({ ok: true, ignored: true });
      return;
    }

    const orgRows = await db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.razorpaySubscriptionId, subscriptionId))
      .limit(1);
    const org = orgRows[0];
    if (!org) {
      res.json({ ok: true, unknownSubscription: true });
      return;
    }

    const updates: Partial<typeof organizationsTable.$inferInsert> = {};
    switch (event) {
      case "subscription.activated":
      case "subscription.charged": {
        updates.subscriptionStatus = "active";
        if (sub?.current_end) {
          updates.currentPeriodEnd = new Date(sub.current_end * 1000);
        }
        break;
      }
      case "subscription.paused":
      case "subscription.halted": {
        updates.subscriptionStatus = "paused";
        break;
      }
      case "subscription.cancelled":
      case "subscription.completed": {
        updates.subscriptionStatus = "cancelled";
        break;
      }
      case "subscription.pending": {
        updates.subscriptionStatus = "pending";
        break;
      }
      default:
        res.json({ ok: true, eventIgnored: event });
        return;
    }

    await db
      .update(organizationsTable)
      .set(updates)
      .where(eq(organizationsTable.id, org.id));

    res.json({ ok: true, event, organizationId: org.id });
  } catch (err) {
    next(err);
  }
});

export default router;
