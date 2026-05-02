import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  db,
  customerPaymentsTable,
  customerPaymentAllocationsTable,
  customersTable,
  salesOrdersTable,
} from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import {
  serializeCustomerPayment,
  serializeCustomerPaymentAllocation,
} from "../lib/serializers";
import { toNum, toStr } from "../lib/numeric";

const router: IRouter = Router();
router.use(tenantMiddleware);

const PAYMENT_MODES = [
  "cash",
  "bank",
  "upi",
  "cheque",
  "razorpay",
  "other",
] as const;
type PaymentMode = (typeof PAYMENT_MODES)[number];
function isPaymentMode(m: string): m is PaymentMode {
  return (PAYMENT_MODES as readonly string[]).includes(m);
}

const EPSILON = 0.005;

const PAYABLE_ORDER_STATUSES = [
  "confirmed",
  "shipped",
  "delivered",
  "invoiced",
] as const;

router.get("/customer-payments", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const conds = [eq(customerPaymentsTable.organizationId, t.organizationId)];
    if (req.query.customerId) {
      const cid = Number(req.query.customerId);
      if (Number.isFinite(cid)) conds.push(eq(customerPaymentsTable.customerId, cid));
    }
    if (req.query.mode && typeof req.query.mode === "string") {
      conds.push(eq(customerPaymentsTable.mode, req.query.mode));
    }
    if (req.query.from && typeof req.query.from === "string") {
      conds.push(gte(customerPaymentsTable.paymentDate, req.query.from));
    }
    if (req.query.to && typeof req.query.to === "string") {
      conds.push(lte(customerPaymentsTable.paymentDate, req.query.to));
    }
    const rows = await db
      .select({
        payment: customerPaymentsTable,
        customerName: customersTable.name,
      })
      .from(customerPaymentsTable)
      .innerJoin(
        customersTable,
        eq(customersTable.id, customerPaymentsTable.customerId),
      )
      .where(and(...conds))
      .orderBy(
        desc(customerPaymentsTable.paymentDate),
        desc(customerPaymentsTable.id),
      );
    res.json(rows.map((r) => serializeCustomerPayment(r.payment, r.customerName)));
  } catch (err) {
    next(err);
  }
});

async function loadPaymentDetail(
  orgId: number,
  paymentId: number,
): Promise<
  | {
      payment: ReturnType<typeof serializeCustomerPayment>;
      allocations: ReturnType<typeof serializeCustomerPaymentAllocation>[];
    }
  | null
> {
  const rows = await db
    .select({
      payment: customerPaymentsTable,
      customerName: customersTable.name,
    })
    .from(customerPaymentsTable)
    .innerJoin(
      customersTable,
      eq(customersTable.id, customerPaymentsTable.customerId),
    )
    .where(
      and(
        eq(customerPaymentsTable.id, paymentId),
        eq(customerPaymentsTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!rows[0]) return null;
  const allocRows = await db
    .select({
      alloc: customerPaymentAllocationsTable,
      orderNumber: salesOrdersTable.orderNumber,
      orderTotal: salesOrdersTable.total,
      orderBalanceDue: salesOrdersTable.balanceDue,
    })
    .from(customerPaymentAllocationsTable)
    .innerJoin(
      salesOrdersTable,
      eq(salesOrdersTable.id, customerPaymentAllocationsTable.salesOrderId),
    )
    .where(
      and(
        eq(customerPaymentAllocationsTable.paymentId, paymentId),
        eq(customerPaymentAllocationsTable.organizationId, orgId),
      ),
    )
    .orderBy(asc(customerPaymentAllocationsTable.id));
  return {
    payment: serializeCustomerPayment(rows[0].payment, rows[0].customerName),
    allocations: allocRows.map((r) =>
      serializeCustomerPaymentAllocation(
        r.alloc,
        r.orderNumber,
        r.orderTotal,
        r.orderBalanceDue,
      ),
    ),
  };
}

router.get("/customer-payments/:id/receipt.pdf", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "Invalid payment id" });
      return;
    }
    const { loadPaymentReceiptPdf } = await import(
      "../lib/paymentReceiptPdfData"
    );
    const result = await loadPaymentReceiptPdf(t.organizationId, id);
    if ("notFound" in result) {
      res.status(404).json({ error: "Payment not found" });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="receipt-${result.receiptNumber}.pdf"`,
    );
    res.setHeader("Cache-Control", "private, max-age=0, no-store");
    res.setHeader("Content-Length", String(result.pdf.length));
    res.send(result.pdf);
  } catch (err) {
    next(err);
  }
});

router.get("/customer-payments/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const detail = await loadPaymentDetail(t.organizationId, id);
    if (!detail) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

class PaymentValidationError extends Error {
  constructor(public httpMessage: string) {
    super(httpMessage);
  }
}

router.post("/customer-payments", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orgId = t.organizationId;
    const b = req.body ?? {};
    const customerId = Number(b.customerId);
    const amount = toNum(b.amount);
    const mode = String(b.mode ?? "");
    const paymentDate =
      typeof b.paymentDate === "string" && b.paymentDate
        ? b.paymentDate
        : new Date().toISOString().slice(0, 10);

    if (!Number.isFinite(customerId) || customerId <= 0) {
      res.status(400).json({ error: "customerId is required" });
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: "amount must be greater than zero" });
      return;
    }
    if (!isPaymentMode(mode)) {
      res.status(400).json({
        error: `Invalid mode. Allowed: ${PAYMENT_MODES.join(", ")}`,
      });
      return;
    }

    // Aggregate allocations by salesOrderId so duplicate rows in the
    // payload cannot bypass per-row balance validation.
    const aggregated = new Map<number, number>();
    if (Array.isArray(b.allocations)) {
      for (const a of b.allocations) {
        const sid = Number((a as { salesOrderId: unknown }).salesOrderId);
        const amt = toNum((a as { amount: unknown }).amount as never);
        if (!Number.isFinite(sid) || sid <= 0) continue;
        if (!Number.isFinite(amt) || amt <= 0) continue;
        aggregated.set(sid, (aggregated.get(sid) ?? 0) + amt);
      }
    }
    const allocationsInput = Array.from(aggregated, ([salesOrderId, amt]) => ({
      salesOrderId,
      amount: amt,
    }));

    const totalAllocated = allocationsInput.reduce((s, a) => s + a.amount, 0);
    if (totalAllocated - amount > EPSILON) {
      res.status(400).json({
        error: "Allocated amount exceeds payment amount",
      });
      return;
    }

    try {
      const insertedId = await db.transaction(async (tx) => {
        const customerRows = await tx
          .select({ id: customersTable.id })
          .from(customersTable)
          .where(
            and(
              eq(customersTable.id, customerId),
              eq(customersTable.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!customerRows[0]) {
          throw new PaymentValidationError("Invalid customer");
        }

        // Apply each aggregated allocation atomically: only update if the
        // current balance_due is sufficient AND the order is in a payable
        // status. RETURNING tells us whether the row matched both org/id
        // and all preconditions; an empty result aborts the whole txn.
        for (const a of allocationsInput) {
          const updated = await tx
            .update(salesOrdersTable)
            .set({
              amountPaid: sql`${salesOrdersTable.amountPaid} + ${toStr(a.amount)}`,
              balanceDue: sql`${salesOrdersTable.balanceDue} - ${toStr(a.amount)}`,
            })
            .where(
              and(
                eq(salesOrdersTable.id, a.salesOrderId),
                eq(salesOrdersTable.organizationId, orgId),
                eq(salesOrdersTable.customerId, customerId),
                sql`${salesOrdersTable.balanceDue} >= ${toStr(a.amount)}`,
                inArray(
                  salesOrdersTable.status,
                  PAYABLE_ORDER_STATUSES as unknown as string[],
                ),
              ),
            )
            .returning({ id: salesOrdersTable.id });
          if (updated.length === 0) {
            throw new PaymentValidationError(
              `Allocation for order ${a.salesOrderId} is invalid: order must be confirmed/shipped/delivered/invoiced and have sufficient balance due`,
            );
          }
        }

        const paymentRows = await tx
          .insert(customerPaymentsTable)
          .values({
            organizationId: orgId,
            customerId,
            paymentDate,
            amount: toStr(amount),
            mode,
            referenceNumber: b.referenceNumber ?? null,
            notes: b.notes ?? null,
            bankAccountLabel: b.bankAccountLabel ?? null,
          })
          .returning({ id: customerPaymentsTable.id });
        const paymentId = paymentRows[0]!.id;

        if (allocationsInput.length > 0) {
          await tx.insert(customerPaymentAllocationsTable).values(
            allocationsInput.map((a) => ({
              organizationId: orgId,
              paymentId,
              salesOrderId: a.salesOrderId,
              amount: toStr(a.amount),
            })),
          );
        }

        // The full received amount reduces the customer's outstanding
        // balance, even when part of it is unallocated (advance).
        await tx
          .update(customersTable)
          .set({
            outstandingBalance: sql`${customersTable.outstandingBalance} - ${toStr(amount)}`,
          })
          .where(
            and(
              eq(customersTable.id, customerId),
              eq(customersTable.organizationId, orgId),
            ),
          );

        return paymentId;
      });

      const detail = await loadPaymentDetail(orgId, insertedId);
      res.status(201).json(detail);
    } catch (err) {
      if (err instanceof PaymentValidationError) {
        res.status(400).json({ error: err.httpMessage });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.delete("/customer-payments/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orgId = t.organizationId;
    const id = Number(req.params.id);

    const result = await db.transaction(async (tx) => {
      // Lock the payment row first. Concurrent deletes block here; the
      // second one sees no rows after the first commits and exits cleanly.
      const lockedPayment = await tx
        .execute(
          sql`SELECT id, customer_id, amount FROM ${customerPaymentsTable}
              WHERE id = ${id} AND organization_id = ${orgId}
              FOR UPDATE`,
        )
        .then((r) =>
          (r.rows ?? r) as Array<{
            id: number;
            customer_id: number;
            amount: string;
          }>,
        );
      const payment = lockedPayment[0];
      if (!payment) return { ok: false as const };

      // Capture allocations (org-scoped) BEFORE deleting them so we can
      // reverse the running totals.
      const allocs = await tx
        .select({
          salesOrderId: customerPaymentAllocationsTable.salesOrderId,
          amount: customerPaymentAllocationsTable.amount,
        })
        .from(customerPaymentAllocationsTable)
        .where(
          and(
            eq(customerPaymentAllocationsTable.paymentId, id),
            eq(customerPaymentAllocationsTable.organizationId, orgId),
          ),
        );

      for (const a of allocs) {
        await tx
          .update(salesOrdersTable)
          .set({
            amountPaid: sql`${salesOrdersTable.amountPaid} - ${a.amount}`,
            balanceDue: sql`${salesOrdersTable.balanceDue} + ${a.amount}`,
          })
          .where(
            and(
              eq(salesOrdersTable.id, a.salesOrderId),
              eq(salesOrdersTable.organizationId, orgId),
            ),
          );
      }

      await tx
        .update(customersTable)
        .set({
          outstandingBalance: sql`${customersTable.outstandingBalance} + ${payment.amount}`,
        })
        .where(
          and(
            eq(customersTable.id, payment.customer_id),
            eq(customersTable.organizationId, orgId),
          ),
        );

      // Cascade FK on customer_payments → customer_payment_allocations
      // removes the allocation rows for us.
      await tx
        .delete(customerPaymentsTable)
        .where(
          and(
            eq(customerPaymentsTable.id, id),
            eq(customerPaymentsTable.organizationId, orgId),
          ),
        );

      return { ok: true as const };
    });

    if (!result.ok) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
