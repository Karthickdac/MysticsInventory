import { and, asc, eq } from "drizzle-orm";
import {
  db,
  customerPaymentsTable,
  customerPaymentAllocationsTable,
  customersTable,
  salesOrdersTable,
} from "@workspace/db";
import { renderPaymentReceiptPdf } from "./paymentReceiptPdf";
import { loadOrgForPdf } from "./orgPdfHelpers";

export interface LoadedPaymentReceiptPdf {
  pdf: Buffer;
  receiptNumber: string;
}

function receiptNumberFor(paymentId: number): string {
  // Customer payments don't carry a user-facing reference number of
  // their own — synthesize a stable one from the row id so the printed
  // receipt and filename agree with the in-app "Payment #<id>" label.
  return `RCPT-${String(paymentId).padStart(6, "0")}`;
}

export async function loadPaymentReceiptPdf(
  organizationId: number,
  paymentId: number,
): Promise<LoadedPaymentReceiptPdf | { notFound: true }> {
  const rows = await db
    .select({
      payment: customerPaymentsTable,
      customer: customersTable,
    })
    .from(customerPaymentsTable)
    .innerJoin(
      customersTable,
      eq(customersTable.id, customerPaymentsTable.customerId),
    )
    .where(
      and(
        eq(customerPaymentsTable.id, paymentId),
        eq(customerPaymentsTable.organizationId, organizationId),
      ),
    )
    .limit(1);
  const head = rows[0];
  if (!head) return { notFound: true };

  const orgBundle = await loadOrgForPdf(organizationId);
  if (!orgBundle) return { notFound: true };

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
        eq(customerPaymentAllocationsTable.organizationId, organizationId),
      ),
    )
    .orderBy(asc(customerPaymentAllocationsTable.id));

  const receiptNumber = receiptNumberFor(head.payment.id);

  const pdf = await renderPaymentReceiptPdf({
    org: orgBundle.docOrg,
    logoBuffer: orgBundle.logoBuffer,
    customer: {
      name: head.customer.name,
      company: head.customer.company,
      email: head.customer.email,
      phone: head.customer.phone,
      gstNumber: head.customer.gstNumber,
      address:
        head.customer.billingAddress ?? head.customer.shippingAddress ?? null,
    },
    payment: {
      receiptNumber,
      paymentDate: head.payment.paymentDate,
      amount: head.payment.amount,
      mode: head.payment.mode,
      referenceNumber: head.payment.referenceNumber,
      bankAccountLabel: head.payment.bankAccountLabel,
      notes: head.payment.notes,
    },
    allocations: allocRows.map((r) => ({
      orderNumber: r.orderNumber,
      orderTotal: r.orderTotal,
      orderBalanceDue: r.orderBalanceDue,
      amount: r.alloc.amount,
    })),
  });

  return { pdf, receiptNumber };
}
