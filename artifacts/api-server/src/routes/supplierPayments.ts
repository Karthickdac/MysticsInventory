import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  db,
  supplierPaymentsTable,
  supplierPaymentAllocationsTable,
  suppliersTable,
  purchaseOrdersTable,
} from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import {
  serializeSupplierPayment,
  serializeSupplierPaymentAllocation,
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

const PAYABLE_PURCHASE_STATUSES = [
  "ordered",
  "partially_received",
  "received",
  "billed",
] as const;

router.get("/supplier-payments", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const conds = [eq(supplierPaymentsTable.organizationId, t.organizationId)];
    if (req.query.supplierId) {
      const sid = Number(req.query.supplierId);
      if (Number.isFinite(sid)) conds.push(eq(supplierPaymentsTable.supplierId, sid));
    }
    if (req.query.mode && typeof req.query.mode === "string") {
      conds.push(eq(supplierPaymentsTable.mode, req.query.mode));
    }
    if (req.query.from && typeof req.query.from === "string") {
      conds.push(gte(supplierPaymentsTable.paymentDate, req.query.from));
    }
    if (req.query.to && typeof req.query.to === "string") {
      conds.push(lte(supplierPaymentsTable.paymentDate, req.query.to));
    }
    const rows = await db
      .select({
        payment: supplierPaymentsTable,
        supplierName: suppliersTable.name,
      })
      .from(supplierPaymentsTable)
      .innerJoin(
        suppliersTable,
        eq(suppliersTable.id, supplierPaymentsTable.supplierId),
      )
      .where(and(...conds))
      .orderBy(
        desc(supplierPaymentsTable.paymentDate),
        desc(supplierPaymentsTable.id),
      );
    res.json(rows.map((r) => serializeSupplierPayment(r.payment, r.supplierName)));
  } catch (err) {
    next(err);
  }
});

async function loadPaymentDetail(
  orgId: number,
  paymentId: number,
): Promise<
  | {
      payment: ReturnType<typeof serializeSupplierPayment>;
      allocations: ReturnType<typeof serializeSupplierPaymentAllocation>[];
    }
  | null
> {
  const rows = await db
    .select({
      payment: supplierPaymentsTable,
      supplierName: suppliersTable.name,
    })
    .from(supplierPaymentsTable)
    .innerJoin(
      suppliersTable,
      eq(suppliersTable.id, supplierPaymentsTable.supplierId),
    )
    .where(
      and(
        eq(supplierPaymentsTable.id, paymentId),
        eq(supplierPaymentsTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!rows[0]) return null;
  const allocRows = await db
    .select({
      alloc: supplierPaymentAllocationsTable,
      orderNumber: purchaseOrdersTable.orderNumber,
      orderTotal: purchaseOrdersTable.total,
      orderBalanceDue: purchaseOrdersTable.balanceDue,
    })
    .from(supplierPaymentAllocationsTable)
    .innerJoin(
      purchaseOrdersTable,
      eq(
        purchaseOrdersTable.id,
        supplierPaymentAllocationsTable.purchaseOrderId,
      ),
    )
    .where(
      and(
        eq(supplierPaymentAllocationsTable.paymentId, paymentId),
        eq(supplierPaymentAllocationsTable.organizationId, orgId),
      ),
    )
    .orderBy(asc(supplierPaymentAllocationsTable.id));
  return {
    payment: serializeSupplierPayment(rows[0].payment, rows[0].supplierName),
    allocations: allocRows.map((r) =>
      serializeSupplierPaymentAllocation(
        r.alloc,
        r.orderNumber,
        r.orderTotal,
        r.orderBalanceDue,
      ),
    ),
  };
}

router.get("/supplier-payments/:id/voucher.pdf", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "Invalid payment id" });
      return;
    }
    const { loadSupplierPaymentPdf } = await import(
      "../lib/supplierPaymentPdfData"
    );
    const result = await loadSupplierPaymentPdf(t.organizationId, id);
    if ("notFound" in result) {
      res.status(404).json({ error: "Payment not found" });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="voucher-${result.voucherNumber}.pdf"`,
    );
    res.setHeader("Cache-Control", "private, max-age=0, no-store");
    res.setHeader("Content-Length", String(result.pdf.length));
    res.send(result.pdf);
  } catch (err) {
    next(err);
  }
});

router.get("/supplier-payments/:id", async (req, res, next) => {
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

router.post("/supplier-payments", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orgId = t.organizationId;
    const b = req.body ?? {};
    const supplierId = Number(b.supplierId);
    const amount = toNum(b.amount);
    const mode = String(b.mode ?? "");
    const paymentDate =
      typeof b.paymentDate === "string" && b.paymentDate
        ? b.paymentDate
        : new Date().toISOString().slice(0, 10);

    if (!Number.isFinite(supplierId) || supplierId <= 0) {
      res.status(400).json({ error: "supplierId is required" });
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

    // Aggregate allocations by purchaseOrderId so duplicate rows in
    // the payload cannot bypass per-row balance validation.
    const aggregated = new Map<number, number>();
    if (Array.isArray(b.allocations)) {
      for (const a of b.allocations) {
        const pid = Number((a as { purchaseOrderId: unknown }).purchaseOrderId);
        const amt = toNum((a as { amount: unknown }).amount as never);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        if (!Number.isFinite(amt) || amt <= 0) continue;
        aggregated.set(pid, (aggregated.get(pid) ?? 0) + amt);
      }
    }
    const allocationsInput = Array.from(
      aggregated,
      ([purchaseOrderId, amt]) => ({
        purchaseOrderId,
        amount: amt,
      }),
    );

    const totalAllocated = allocationsInput.reduce((s, a) => s + a.amount, 0);
    if (totalAllocated - amount > EPSILON) {
      res.status(400).json({
        error: "Allocated amount exceeds payment amount",
      });
      return;
    }

    try {
      const insertedId = await db.transaction(async (tx) => {
        const supplierRows = await tx
          .select({ id: suppliersTable.id })
          .from(suppliersTable)
          .where(
            and(
              eq(suppliersTable.id, supplierId),
              eq(suppliersTable.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!supplierRows[0]) {
          throw new PaymentValidationError("Invalid supplier");
        }

        // Apply each aggregated allocation atomically: only update if
        // the current balance_due is sufficient AND the order is in a
        // payable status. RETURNING tells us whether the row matched
        // both org/id and all preconditions; an empty result aborts
        // the whole txn.
        for (const a of allocationsInput) {
          const updated = await tx
            .update(purchaseOrdersTable)
            .set({
              amountPaid: sql`${purchaseOrdersTable.amountPaid} + ${toStr(a.amount)}`,
              balanceDue: sql`${purchaseOrdersTable.balanceDue} - ${toStr(a.amount)}`,
            })
            .where(
              and(
                eq(purchaseOrdersTable.id, a.purchaseOrderId),
                eq(purchaseOrdersTable.organizationId, orgId),
                eq(purchaseOrdersTable.supplierId, supplierId),
                sql`${purchaseOrdersTable.balanceDue} >= ${toStr(a.amount)}`,
                inArray(
                  purchaseOrdersTable.status,
                  PAYABLE_PURCHASE_STATUSES as unknown as string[],
                ),
              ),
            )
            .returning({ id: purchaseOrdersTable.id });
          if (updated.length === 0) {
            throw new PaymentValidationError(
              `Allocation for order ${a.purchaseOrderId} is invalid: order must be ordered/partially received/received/billed and have sufficient balance due`,
            );
          }
        }

        const paymentRows = await tx
          .insert(supplierPaymentsTable)
          .values({
            organizationId: orgId,
            supplierId,
            paymentDate,
            amount: toStr(amount),
            mode,
            referenceNumber: b.referenceNumber ?? null,
            notes: b.notes ?? null,
            bankAccountLabel: b.bankAccountLabel ?? null,
          })
          .returning({ id: supplierPaymentsTable.id });
        const paymentId = paymentRows[0]!.id;

        if (allocationsInput.length > 0) {
          await tx.insert(supplierPaymentAllocationsTable).values(
            allocationsInput.map((a) => ({
              organizationId: orgId,
              paymentId,
              purchaseOrderId: a.purchaseOrderId,
              amount: toStr(a.amount),
            })),
          );
        }

        // The full paid amount reduces the supplier's outstanding
        // payable, even when part of it is unallocated (advance).
        await tx
          .update(suppliersTable)
          .set({
            outstandingPayable: sql`${suppliersTable.outstandingPayable} - ${toStr(amount)}`,
          })
          .where(
            and(
              eq(suppliersTable.id, supplierId),
              eq(suppliersTable.organizationId, orgId),
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

router.delete("/supplier-payments/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orgId = t.organizationId;
    const id = Number(req.params.id);

    const result = await db.transaction(async (tx) => {
      // Lock the payment row first. Concurrent deletes block here;
      // the second one sees no rows after the first commits and exits
      // cleanly.
      const lockedPayment = await tx
        .execute(
          sql`SELECT id, supplier_id, amount FROM ${supplierPaymentsTable}
              WHERE id = ${id} AND organization_id = ${orgId}
              FOR UPDATE`,
        )
        .then((r) =>
          (r.rows ?? r) as Array<{
            id: number;
            supplier_id: number;
            amount: string;
          }>,
        );
      const payment = lockedPayment[0];
      if (!payment) return { ok: false as const };

      // Capture allocations (org-scoped) BEFORE deleting them so we
      // can reverse the running totals.
      const allocs = await tx
        .select({
          purchaseOrderId: supplierPaymentAllocationsTable.purchaseOrderId,
          amount: supplierPaymentAllocationsTable.amount,
        })
        .from(supplierPaymentAllocationsTable)
        .where(
          and(
            eq(supplierPaymentAllocationsTable.paymentId, id),
            eq(supplierPaymentAllocationsTable.organizationId, orgId),
          ),
        );

      for (const a of allocs) {
        await tx
          .update(purchaseOrdersTable)
          .set({
            amountPaid: sql`${purchaseOrdersTable.amountPaid} - ${a.amount}`,
            balanceDue: sql`${purchaseOrdersTable.balanceDue} + ${a.amount}`,
          })
          .where(
            and(
              eq(purchaseOrdersTable.id, a.purchaseOrderId),
              eq(purchaseOrdersTable.organizationId, orgId),
            ),
          );
      }

      await tx
        .update(suppliersTable)
        .set({
          outstandingPayable: sql`${suppliersTable.outstandingPayable} + ${payment.amount}`,
        })
        .where(
          and(
            eq(suppliersTable.id, payment.supplier_id),
            eq(suppliersTable.organizationId, orgId),
          ),
        );

      // Cascade FK on supplier_payments → supplier_payment_allocations
      // removes the allocation rows for us.
      await tx
        .delete(supplierPaymentsTable)
        .where(
          and(
            eq(supplierPaymentsTable.id, id),
            eq(supplierPaymentsTable.organizationId, orgId),
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
