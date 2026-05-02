import { and, asc, eq } from "drizzle-orm";
import {
  db,
  supplierPaymentsTable,
  supplierPaymentAllocationsTable,
  suppliersTable,
  purchaseOrdersTable,
} from "@workspace/db";
import { renderSupplierPaymentPdf } from "./supplierPaymentPdf";
import { loadOrgForPdf } from "./orgPdfHelpers";

export interface LoadedSupplierPaymentPdf {
  pdf: Buffer;
  voucherNumber: string;
}

function voucherNumberFor(paymentId: number): string {
  return `PV-${String(paymentId).padStart(6, "0")}`;
}

export async function loadSupplierPaymentPdf(
  organizationId: number,
  paymentId: number,
): Promise<LoadedSupplierPaymentPdf | { notFound: true }> {
  const rows = await db
    .select({
      payment: supplierPaymentsTable,
      supplier: suppliersTable,
    })
    .from(supplierPaymentsTable)
    .innerJoin(
      suppliersTable,
      eq(suppliersTable.id, supplierPaymentsTable.supplierId),
    )
    .where(
      and(
        eq(supplierPaymentsTable.id, paymentId),
        eq(supplierPaymentsTable.organizationId, organizationId),
      ),
    )
    .limit(1);
  const head = rows[0];
  if (!head) return { notFound: true };

  const orgBundle = await loadOrgForPdf(organizationId);
  if (!orgBundle) return { notFound: true };

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
        eq(supplierPaymentAllocationsTable.organizationId, organizationId),
      ),
    )
    .orderBy(asc(supplierPaymentAllocationsTable.id));

  const voucherNumber = voucherNumberFor(head.payment.id);

  const pdf = await renderSupplierPaymentPdf({
    org: orgBundle.docOrg,
    logoBuffer: orgBundle.logoBuffer,
    supplier: {
      name: head.supplier.name,
      company: head.supplier.company,
      email: head.supplier.email,
      phone: head.supplier.phone,
      gstNumber: head.supplier.gstNumber,
      address: head.supplier.address,
    },
    payment: {
      voucherNumber,
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

  return { pdf, voucherNumber };
}
