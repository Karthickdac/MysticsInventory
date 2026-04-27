import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, organizationsTable, usersTable } from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import { PLANS, getPlan } from "../lib/plans";
import { getRazorpay, verifySubscriptionSignature } from "../lib/razorpay";

const router: IRouter = Router();
router.use(tenantMiddleware);

router.get("/subscription", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orgRows = await db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, t.organizationId))
      .limit(1);
    const o = orgRows[0]!;
    res.json({
      plan: o.plan,
      status: o.subscriptionStatus,
      currentPeriodEnd: o.currentPeriodEnd ? o.currentPeriodEnd.toISOString() : null,
      razorpaySubscriptionId: o.razorpaySubscriptionId,
      isTrialing: o.subscriptionStatus === "trialing",
      trialEndsAt: o.trialEndsAt ? o.trialEndsAt.toISOString() : null,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/subscription/plans", async (_req, res) => {
  res.json(PLANS);
});

router.post("/subscription/checkout", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const planId = String(req.body?.planId ?? "");
    const plan = getPlan(planId);
    if (!plan) {
      res.status(400).json({ error: "Unknown planId" });
      return;
    }
    if (plan.priceMonthlyInPaise === 0) {
      res.status(400).json({ error: "Free plan does not require checkout" });
      return;
    }

    const orgRows = await db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, t.organizationId))
      .limit(1);
    const org = orgRows[0]!;
    const userRows = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, t.userId))
      .limit(1);
    const user = userRows[0]!;

    const keyId = process.env.RAZORPAY_KEY_ID;
    if (!keyId) {
      res.status(500).json({ error: "Razorpay not configured" });
      return;
    }
    const rzp = getRazorpay();

    let razorpayPlanId = plan.razorpayPlanId;
    if (!razorpayPlanId) {
      const created = await rzp.plans.create({
        period: "monthly",
        interval: 1,
        item: {
          name: `Mystics Inventory ${plan.name}`,
          amount: plan.priceMonthlyInPaise,
          currency: plan.currency,
          description: `${plan.name} plan — Mystics Inventory`,
        },
      });
      razorpayPlanId = created.id;
    }

    const subscription = await rzp.subscriptions.create({
      plan_id: razorpayPlanId,
      customer_notify: 1,
      total_count: 12,
      notes: {
        organizationId: String(org.id),
        planId: plan.id,
      },
    });

    await db
      .update(organizationsTable)
      .set({
        razorpaySubscriptionId: subscription.id,
        plan: plan.id,
        subscriptionStatus: "pending",
      })
      .where(eq(organizationsTable.id, org.id));

    res.json({
      razorpayKeyId: keyId,
      subscriptionId: subscription.id,
      planName: plan.name,
      customerName: user.name ?? user.email,
      customerEmail: user.email,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/subscription/verify", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const b = req.body ?? {};
    if (!b.razorpayPaymentId || !b.razorpaySubscriptionId || !b.razorpaySignature) {
      res.status(400).json({ error: "Missing payment fields" });
      return;
    }
    const orgRows = await db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, t.organizationId))
      .limit(1);
    const org = orgRows[0]!;
    if (
      !org.razorpaySubscriptionId ||
      org.razorpaySubscriptionId !== b.razorpaySubscriptionId
    ) {
      res
        .status(400)
        .json({ error: "Subscription does not belong to this organization" });
      return;
    }
    const ok = verifySubscriptionSignature({
      razorpayPaymentId: b.razorpayPaymentId,
      razorpaySubscriptionId: b.razorpaySubscriptionId,
      razorpaySignature: b.razorpaySignature,
    });
    if (!ok) {
      res.status(400).json({ error: "Invalid signature" });
      return;
    }
    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const updated = await db
      .update(organizationsTable)
      .set({
        subscriptionStatus: "active",
        currentPeriodEnd: periodEnd,
      })
      .where(eq(organizationsTable.id, t.organizationId))
      .returning();
    const o = updated[0]!;
    res.json({
      plan: o.plan,
      status: o.subscriptionStatus,
      currentPeriodEnd: o.currentPeriodEnd ? o.currentPeriodEnd.toISOString() : null,
      razorpaySubscriptionId: o.razorpaySubscriptionId,
      isTrialing: false,
      trialEndsAt: o.trialEndsAt ? o.trialEndsAt.toISOString() : null,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
