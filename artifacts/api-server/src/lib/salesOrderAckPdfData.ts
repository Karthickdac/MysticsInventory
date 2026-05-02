import { and, asc, eq } from "drizzle-orm";
import {
  db,
  salesOrdersTable,
  salesOrderLinesTable,
  customersTable,
  itemsTable,
} from "@workspace/db";
import { renderSalesOrderAckPdf } from "./salesOrderPdf";
import { loadOrgForPdf } from "./orgPdfHelpers";

export interface LoadedSalesOrderAckPdf {
  pdf: Buffer;
  orderNumber: string;
}

export async function loadSalesOrderAckPdf(
  organizationId: number,
  orderId: number,
): Promise<LoadedSalesOrderAckPdf | { notFound: true }> {
  const orderRows = await db
    .select({ order: salesOrdersTable, customer: customersTable })
    .from(salesOrdersTable)
    .innerJoin(
      customersTable,
      eq(customersTable.id, salesOrdersTable.customerId),
    )
    .where(
      and(
        eq(salesOrdersTable.id, orderId),
        eq(salesOrdersTable.organizationId, organizationId),
      ),
    )
    .limit(1);
  const head = orderRows[0];
  if (!head) return { notFound: true };

  const orgBundle = await loadOrgForPdf(organizationId);
  if (!orgBundle) return { notFound: true };

  const lineRows = await db
    .select({
      line: salesOrderLinesTable,
      itemName: itemsTable.name,
      sku: itemsTable.sku,
      hsnCode: itemsTable.hsnCode,
    })
    .from(salesOrderLinesTable)
    .innerJoin(itemsTable, eq(itemsTable.id, salesOrderLinesTable.itemId))
    .where(eq(salesOrderLinesTable.salesOrderId, orderId))
    .orderBy(asc(salesOrderLinesTable.id));

  const pdf = await renderSalesOrderAckPdf({
    org: orgBundle.docOrg,
    logoBuffer: orgBundle.logoBuffer,
    customer: {
      name: head.customer.name,
      company: head.customer.company,
      email: head.customer.email,
      phone: head.customer.phone,
      gstNumber: head.customer.gstNumber,
      billingAddress: head.customer.billingAddress,
      shippingAddress: head.customer.shippingAddress,
      placeOfSupply: head.customer.placeOfSupply,
    },
    order: {
      orderNumber: head.order.orderNumber,
      status: head.order.status,
      orderDate: head.order.orderDate,
      expectedShipDate: head.order.expectedShipDate,
      notes: head.order.notes,
      subtotal: head.order.subtotal,
      taxTotal: head.order.taxTotal,
      total: head.order.total,
    },
    lines: lineRows.map((r) => ({
      itemName: r.itemName,
      sku: r.sku,
      description: r.line.description,
      hsnCode: r.hsnCode,
      quantity: r.line.quantity,
      unitPrice: r.line.unitPrice,
      taxRate: r.line.taxRate,
      lineSubtotal: r.line.lineSubtotal,
      lineTax: r.line.lineTax,
      lineTotal: r.line.lineTotal,
    })),
  });

  return { pdf, orderNumber: head.order.orderNumber };
}
