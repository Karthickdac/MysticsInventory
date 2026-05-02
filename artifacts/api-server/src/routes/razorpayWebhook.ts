import { Router, type IRouter, type Request } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  organizationsTable,
  paymentLinksTable,
  salesOrdersTable,
  customersTable,
  customerPaymentsTable,
  customerPaymentAllocationsTable,
} from "@workspace/db";
import { fetchPaymentLink, verifyWebhookSignature } from "../lib/razorpay";

const router: IRouter = Router();

interface SubscriptionEntity {
  id: string;
  status?: string;
  current_end?: number;
  notes?: { organizationId?: string; planId?: string } | null;
}

interface PaymentLinkEntity {
  id: string;
  status?: string;
  amount?: number;
  amount_paid?: number;
  notes?: { organizationId?: string; salesOrderId?: string } | null;
}

interface PaymentEntity {
  id?: string;
  subscription_id?: string;
  payment_link_id?: string;
}

interface WebhookPayload {
  event: string;
  payload?: {
    subscription?: { entity?: SubscriptionEntity };
    payment?: { entity?: PaymentEntity };
    payment_link?: { entity?: PaymentLinkEntity };
  };
}

// Sales-order statuses that can still legitimately accept a payment.
// Mirrors PAYABLE_ORDER_STATUSES in customerPayments.ts exactly so the
// webhook applies payments under the same conditions as a manual record.
const PAYABLE_STATUSES = [
  "confirmed",
  "shipped",
  "delivered",
  "invoiced",
];

router.post("/razorpay/webhook", async (req, res, next) => {
  try {
    const signature = req.header("x-razorpay-signature") ?? "";
    const raw = (req as Request & { rawBody?: string }).rawBody ?? "";
    if (!verifyWebhookSignature(raw, signature)) {
      req.log?.warn(
        { hasSignature: Boolean(signature), bodyLength: raw.length },
        "Razorpay webhook signature verification failed",
      );
      res.status(400).json({ error: "Invalid signature" });
      return;
    }

    const body = req.body as WebhookPayload;
    const event = body?.event ?? "";

    // ---- payment_link.* branch -------------------------------------------
    if (event.startsWith("payment_link.")) {
      const linkEntity = body?.payload?.payment_link?.entity;
      const paymentEntity = body?.payload?.payment?.entity;
      const linkId = linkEntity?.id;
      if (!linkId) {
        req.log?.info({ event }, "Razorpay payment_link webhook missing link id; ignoring");
        res.json({ ok: true, ignored: true });
        return;
      }

      const linkRows = await db
        .select()
        // org-scope-allow: webhook arrives without auth context; we look up
        // the link by Razorpay's external id to discover the owning org.
        .from(paymentLinksTable)
        .where(eq(paymentLinksTable.razorpayLinkId, linkId))
        .limit(1);
      const link = linkRows[0];
      if (!link) {
        req.log?.warn(
          { event, linkId },
          "Razorpay webhook for unknown payment link; ignoring",
        );
        res.json({ ok: true, unknownLink: true });
        return;
      }

      if (event === "payment_link.cancelled") {
        if (link.status === "created") {
          await db
            .update(paymentLinksTable)
            .set({ status: "cancelled", cancelledAt: new Date() })
            .where(
              and(
                eq(paymentLinksTable.id, link.id),
                eq(paymentLinksTable.organizationId, link.organizationId),
              ),
            );
        }
        res.json({ ok: true, event, paymentLinkId: link.id });
        return;
      }
      if (event === "payment_link.expired") {
        if (link.status === "created") {
          await db
            .update(paymentLinksTable)
            .set({ status: "expired" })
            .where(
              and(
                eq(paymentLinksTable.id, link.id),
                eq(paymentLinksTable.organizationId, link.organizationId),
              ),
            );
        }
        res.json({ ok: true, event, paymentLinkId: link.id });
        return;
      }
      if (event !== "payment_link.paid") {
        req.log?.info({ event, linkId }, "Razorpay payment_link event ignored");
        res.json({ ok: true, eventIgnored: event });
        return;
      }

      // payment_link.paid — record a customer_payment + allocation idempotently.
      if (link.status === "paid" && link.razorpayPaymentId) {
        req.log?.info(
          { event, paymentLinkId: link.id },
          "Razorpay payment_link.paid duplicate; skipping",
        );
        res.json({ ok: true, event, duplicate: true });
        return;
      }

      // Re-fetch from Razorpay for an authoritative status + amount_paid,
      // so a forged `paid` payload that bypasses signature checks (or a stale
      // event) cannot trigger a write.
      let authoritative: { status?: string; amount_paid?: number; amount?: number };
      try {
        authoritative = await fetchPaymentLink(linkId);
      } catch (err) {
        req.log?.error(
          { err, linkId },
          "Could not re-fetch payment link from Razorpay; aborting",
        );
        res.status(502).json({ error: "Could not verify payment link with Razorpay" });
        return;
      }
      if (authoritative.status !== "paid") {
        req.log?.warn(
          {
            event,
            linkId,
            authoritativeStatus: authoritative.status,
          },
          "Razorpay payment_link.paid received but link not paid per fetch; ignoring",
        );
        res.json({ ok: true, event, notPaid: true });
        return;
      }

      const amountPaidRupees =
        typeof authoritative.amount_paid === "number"
          ? authoritative.amount_paid / 100
          : Number(link.amount);
      const razorpayPaymentId =
        paymentEntity?.id ?? `link_${link.razorpayLinkId}`;

      try {
        await db.transaction(async (tx) => {
          // Claim the link row first. Concurrent webhook deliveries race
          // here — the loser sees zero rows and exits cleanly.
          const claimed = await tx
            .update(paymentLinksTable)
            .set({
              status: "paid",
              paidAt: new Date(),
              razorpayPaymentId,
            })
            .where(
              and(
                eq(paymentLinksTable.id, link.id),
                eq(paymentLinksTable.organizationId, link.organizationId),
                eq(paymentLinksTable.status, "created"),
              ),
            )
            .returning({ id: paymentLinksTable.id });
          if (claimed.length === 0) {
            // Already processed by a previous delivery.
            return;
          }

          // Lock the sales-order row so concurrent payments / manual
          // records can't race the balance check. We then allocate up to
          // whatever balance is still payable, recording any remainder as
          // an unallocated advance — never refusing a real payment.
          const orderRows = await tx
            .select()
            .from(salesOrdersTable)
            .where(
              and(
                eq(salesOrdersTable.id, link.salesOrderId),
                eq(salesOrdersTable.organizationId, link.organizationId),
              ),
            )
            .for("update")
            .limit(1);
          const order = orderRows[0];
          if (!order) {
            // Sales order vanished — record nothing further; the link is
            // already marked paid for audit trail.
            return;
          }

          const currentBalance = Number(order.balanceDue);
          const isPayable =
            currentBalance > 0 && PAYABLE_STATUSES.includes(order.status);
          const allocAmount = isPayable
            ? Math.min(amountPaidRupees, currentBalance)
            : 0;

          if (allocAmount > 0) {
            await tx
              .update(salesOrdersTable)
              .set({
                amountPaid: sql`${salesOrdersTable.amountPaid} + ${allocAmount.toFixed(2)}`,
                balanceDue: sql`${salesOrdersTable.balanceDue} - ${allocAmount.toFixed(2)}`,
              })
              .where(
                and(
                  eq(salesOrdersTable.id, link.salesOrderId),
                  eq(salesOrdersTable.organizationId, link.organizationId),
                ),
              );
          }

          const paymentRows = await tx
            .insert(customerPaymentsTable)
            .values({
              organizationId: link.organizationId,
              customerId: order.customerId,
              paymentDate: new Date().toISOString().slice(0, 10),
              amount: amountPaidRupees.toFixed(2),
              mode: "razorpay",
              referenceNumber: razorpayPaymentId,
              notes: `Razorpay payment link ${link.razorpayLinkId}`,
            })
            .returning({ id: customerPaymentsTable.id });
          const paymentId = paymentRows[0]!.id;

          if (allocAmount > 0) {
            await tx.insert(customerPaymentAllocationsTable).values({
              organizationId: link.organizationId,
              paymentId,
              salesOrderId: link.salesOrderId,
              amount: allocAmount.toFixed(2),
            });
          }

          // Reduce customer outstanding balance by the full received amount,
          // matching manual payment behaviour (unallocated portion is an
          // advance).
          await tx
            .update(customersTable)
            .set({
              outstandingBalance: sql`${customersTable.outstandingBalance} - ${amountPaidRupees.toFixed(2)}`,
            })
            .where(
              and(
                eq(customersTable.id, order.customerId),
                eq(customersTable.organizationId, link.organizationId),
              ),
            );
        });
      } catch (txErr) {
        req.log?.error(
          { err: txErr, linkId, paymentLinkRowId: link.id },
          "Failed to apply Razorpay payment_link.paid",
        );
        res.status(500).json({ error: "Failed to record payment" });
        return;
      }

      req.log?.info(
        {
          event,
          paymentLinkId: link.id,
          salesOrderId: link.salesOrderId,
          organizationId: link.organizationId,
          razorpayPaymentId,
        },
        "Razorpay payment_link.paid applied",
      );
      res.json({ ok: true, event, paymentLinkId: link.id });
      return;
    }

    // ---- subscription.* branch (unchanged behaviour) ---------------------
    const sub: SubscriptionEntity | undefined =
      body?.payload?.subscription?.entity;

    let subscriptionId: string | undefined = sub?.id;
    if (!subscriptionId) {
      subscriptionId = body?.payload?.payment?.entity?.subscription_id;
    }
    if (!subscriptionId) {
      req.log?.info({ event }, "Razorpay webhook had no subscription id; ignoring");
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
      req.log?.warn(
        { event, subscriptionId },
        "Razorpay webhook for unknown subscription; ignoring",
      );
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
        req.log?.info({ event, subscriptionId }, "Razorpay webhook event ignored");
        res.json({ ok: true, eventIgnored: event });
        return;
    }

    // Idempotency: skip the write if this event would not change anything.
    const newStatus = updates.subscriptionStatus ?? org.subscriptionStatus;
    const newPeriodEnd =
      updates.currentPeriodEnd instanceof Date
        ? updates.currentPeriodEnd
        : org.currentPeriodEnd;
    const statusUnchanged = newStatus === org.subscriptionStatus;
    const periodUnchanged =
      (newPeriodEnd?.getTime() ?? null) ===
      (org.currentPeriodEnd?.getTime() ?? null);
    if (statusUnchanged && periodUnchanged) {
      req.log?.info(
        { event, organizationId: org.id, subscriptionId },
        "Razorpay webhook duplicate; no state change",
      );
      res.json({ ok: true, event, organizationId: org.id, duplicate: true });
      return;
    }

    await db
      .update(organizationsTable)
      .set(updates)
      .where(eq(organizationsTable.id, org.id));

    req.log?.info(
      {
        event,
        organizationId: org.id,
        subscriptionId,
        status: newStatus,
      },
      "Razorpay webhook applied",
    );
    res.json({ ok: true, event, organizationId: org.id });
  } catch (err) {
    next(err);
  }
});

export default router;
