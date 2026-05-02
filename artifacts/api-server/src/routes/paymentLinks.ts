import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  paymentLinksTable,
  salesOrdersTable,
  customersTable,
} from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import { serializePaymentLink } from "../lib/serializers";
import {
  cancelPaymentLink,
  createPaymentLink,
  RazorpayNotConfiguredError,
} from "../lib/razorpay";
import { toNum } from "../lib/numeric";
import { logger } from "../lib/logger";

// Statuses where a customer is expected to pay. Mirrors
// PAYABLE_ORDER_STATUSES in customerPayments.ts so payment links and manual
// payments accept the same set of orders.
const PAYABLE_STATUSES = [
  "confirmed",
  "shipped",
  "delivered",
  "invoiced",
] as const;

const router: IRouter = Router();
router.use(tenantMiddleware);

// Resolve the most-recent active (created/expired-but-still-pending) link for
// the order, used by the invoice-email helper. Exported so salesOrders.ts can
// inject the URL into outgoing email bodies.
export async function getActivePaymentLink(
  organizationId: number,
  salesOrderId: number,
) {
  const rows = await db
    .select()
    .from(paymentLinksTable)
    .where(
      and(
        eq(paymentLinksTable.organizationId, organizationId),
        eq(paymentLinksTable.salesOrderId, salesOrderId),
        eq(paymentLinksTable.status, "created"),
      ),
    )
    .orderBy(desc(paymentLinksTable.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

router.post("/sales-orders/:id/payment-link", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "Invalid sales order id" });
      return;
    }

    // Lock the order row, validate, and atomically claim the
    // single-active-link slot. Two concurrent requests can't both pass the
    // existence check this way — the second one reads the first's pending
    // row inside the same transaction.
    const validation = await db.transaction(async (tx) => {
      const orderRows = await tx
        .select({
          order: salesOrdersTable,
          customerName: customersTable.name,
          customerEmail: customersTable.email,
          customerPhone: customersTable.phone,
        })
        .from(salesOrdersTable)
        .innerJoin(
          customersTable,
          eq(customersTable.id, salesOrdersTable.customerId),
        )
        .where(
          and(
            eq(salesOrdersTable.id, id),
            eq(salesOrdersTable.organizationId, t.organizationId),
          ),
        )
        .for("update", { of: salesOrdersTable })
        .limit(1);
      const row = orderRows[0];
      if (!row) {
        return { kind: "not_found" as const };
      }
      const { order, customerName, customerEmail, customerPhone } = row;

      if (!(PAYABLE_STATUSES as readonly string[]).includes(order.status)) {
        return {
          kind: "bad_status" as const,
          status: order.status,
        };
      }

      const balanceDue = toNum(order.balanceDue);
      const requested = req.body?.amount;
      const amount =
        requested === undefined || requested === null
          ? balanceDue
          : toNum(requested);
      if (!Number.isFinite(amount) || amount <= 0) {
        return { kind: "bad_amount" as const };
      }
      if (amount - balanceDue > 0.005) {
        return {
          kind: "exceeds_balance" as const,
          balanceDue,
        };
      }

      const existingRows = await tx
        .select()
        .from(paymentLinksTable)
        .where(
          and(
            eq(paymentLinksTable.organizationId, t.organizationId),
            eq(paymentLinksTable.salesOrderId, id),
            eq(paymentLinksTable.status, "created"),
          ),
        )
        .orderBy(desc(paymentLinksTable.createdAt))
        .limit(1);
      if (existingRows[0]) {
        return {
          kind: "active_exists" as const,
          link: existingRows[0],
        };
      }

      return {
        kind: "ok" as const,
        order,
        customerName,
        customerEmail,
        customerPhone,
        amount,
      };
    });

    if (validation.kind === "not_found") {
      res.status(404).json({ error: "Sales order not found" });
      return;
    }
    if (validation.kind === "bad_status") {
      res.status(400).json({
        error: `Payment links can only be generated for orders in: ${PAYABLE_STATUSES.join(", ")}. Current status: ${validation.status}.`,
      });
      return;
    }
    if (validation.kind === "bad_amount") {
      res.status(400).json({ error: "Amount must be greater than zero." });
      return;
    }
    if (validation.kind === "exceeds_balance") {
      res.status(400).json({
        error: `Amount cannot exceed balance due (${validation.balanceDue.toFixed(2)}).`,
      });
      return;
    }
    if (validation.kind === "active_exists") {
      res.status(409).json({
        error:
          "An active payment link already exists for this order. Cancel it before generating a new one.",
        link: serializePaymentLink(validation.link),
      });
      return;
    }

    const { order, customerName, customerEmail, customerPhone, amount } =
      validation;

    const description =
      typeof req.body?.description === "string" && req.body.description.trim()
        ? String(req.body.description).trim().slice(0, 2048)
        : `Payment for order ${order.orderNumber}`;

    let rzpLink;
    try {
      rzpLink = await createPaymentLink({
        amountInRupees: amount,
        currency: "INR",
        description,
        customer: {
          name: customerName,
          email: customerEmail,
          phone: customerPhone,
        },
        organizationId: t.organizationId,
        salesOrderId: id,
        orderNumber: order.orderNumber,
      });
    } catch (err) {
      if (err instanceof RazorpayNotConfiguredError) {
        res.status(503).json({ error: err.message });
        return;
      }
      const description =
        (err as { error?: { description?: string } }).error?.description ??
        (err instanceof Error ? err.message : "Razorpay request failed");
      logger.warn(
        { err, salesOrderId: id, organizationId: t.organizationId },
        "Razorpay payment-link create failed",
      );
      res.status(502).json({ error: description });
      return;
    }

    let inserted;
    try {
      inserted = await db
        .insert(paymentLinksTable)
        .values({
          organizationId: t.organizationId,
          salesOrderId: id,
          razorpayLinkId: rzpLink.id,
          shortUrl: rzpLink.short_url,
          amount: amount.toFixed(2),
          currency: rzpLink.currency || "INR",
          status: "created",
          description,
          expiresAt: rzpLink.expire_by
            ? new Date(rzpLink.expire_by * 1000)
            : null,
          createdByUserId: t.userId,
        })
        .returning();
    } catch (insertErr) {
      // The (org, sales_order) partial unique index covers status='created'
      // — if a parallel request committed first, postgres raises 23505. We
      // best-effort cancel the orphan Razorpay link so it can't be used.
      const code = (insertErr as { code?: string }).code;
      if (code === "23505") {
        try {
          await cancelPaymentLink(rzpLink.id);
        } catch (cancelErr) {
          logger.warn(
            { err: cancelErr, razorpayLinkId: rzpLink.id },
            "Could not cancel orphan Razorpay link after duplicate-create",
          );
        }
        const existing = await getActivePaymentLink(t.organizationId, id);
        res.status(409).json({
          error:
            "An active payment link already exists for this order. Cancel it before generating a new one.",
          link: existing ? serializePaymentLink(existing) : null,
        });
        return;
      }
      throw insertErr;
    }
    res.status(201).json(serializePaymentLink(inserted[0]!));
  } catch (err) {
    next(err);
  }
});

router.get("/sales-orders/:id/payment-links", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "Invalid sales order id" });
      return;
    }
    const rows = await db
      .select()
      .from(paymentLinksTable)
      .where(
        and(
          eq(paymentLinksTable.organizationId, t.organizationId),
          eq(paymentLinksTable.salesOrderId, id),
        ),
      )
      .orderBy(desc(paymentLinksTable.createdAt));
    res.json(rows.map(serializePaymentLink));
  } catch (err) {
    next(err);
  }
});

router.post("/payment-links/:id/cancel", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "Invalid payment link id" });
      return;
    }

    const rows = await db
      .select()
      .from(paymentLinksTable)
      .where(
        and(
          eq(paymentLinksTable.id, id),
          eq(paymentLinksTable.organizationId, t.organizationId),
        ),
      )
      .limit(1);
    const link = rows[0];
    if (!link) {
      res.status(404).json({ error: "Payment link not found" });
      return;
    }
    if (link.status !== "created") {
      res.status(400).json({
        error: `Only active payment links can be cancelled. Current status: ${link.status}.`,
      });
      return;
    }

    try {
      await cancelPaymentLink(link.razorpayLinkId);
    } catch (err) {
      if (err instanceof RazorpayNotConfiguredError) {
        res.status(503).json({ error: err.message });
        return;
      }
      const description =
        (err as { error?: { description?: string } }).error?.description ??
        (err instanceof Error ? err.message : "Razorpay request failed");
      logger.warn(
        { err, paymentLinkId: id, organizationId: t.organizationId },
        "Razorpay payment-link cancel failed",
      );
      res.status(502).json({ error: description });
      return;
    }

    // Race guard: only flip if still in `created`. If a webhook landed in the
    // meantime we keep its `paid` state.
    const updated = await db
      .update(paymentLinksTable)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(
        and(
          eq(paymentLinksTable.id, id),
          eq(paymentLinksTable.organizationId, t.organizationId),
          eq(paymentLinksTable.status, "created"),
        ),
      )
      .returning();
    if (updated.length === 0) {
      const fresh = await db
        .select()
        .from(paymentLinksTable)
        .where(
          and(
            eq(paymentLinksTable.organizationId, t.organizationId),
            eq(paymentLinksTable.id, id),
          ),
        )
        .limit(1);
      res.json(serializePaymentLink(fresh[0]!));
      return;
    }
    res.json(serializePaymentLink(updated[0]!));
  } catch (err) {
    next(err);
  }
});

export default router;
