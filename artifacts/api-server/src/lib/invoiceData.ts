import { and, eq, asc } from "drizzle-orm";
import {
  db,
  salesOrdersTable,
  salesOrderLinesTable,
  customersTable,
  organizationsTable,
  itemsTable,
} from "@workspace/db";
import {
  renderInvoicePdf,
  type InvoicePdfEwb,
  type InvoicePdfEinvoice,
  type InvoicePdfLine,
} from "./invoicePdf";
import { buildEwbQrPayload } from "./ewb";
import { fetchLogoBuffer } from "./orgLogo";

const ORDER_INVOICEABLE_STATUSES = new Set([
  "shipped",
  "partially_shipped",
  "delivered",
  "invoiced",
  "paid",
  "returned",
]);

export interface LoadedInvoice {
  pdf: Buffer;
  orderNumber: string;
  customerEmail: string | null;
  customerName: string;
  status: string;
  total: number;
}

export async function loadInvoiceForOrder(
  organizationId: number,
  salesOrderId: number,
): Promise<LoadedInvoice | { notFound: true } | { wrongStatus: string }> {
  const orderRows = await db
    .select()
    .from(salesOrdersTable)
    .where(
      and(
        eq(salesOrdersTable.id, salesOrderId),
        eq(salesOrdersTable.organizationId, organizationId),
      ),
    )
    .limit(1);
  const order = orderRows[0];
  if (!order) return { notFound: true };
  if (!ORDER_INVOICEABLE_STATUSES.has(order.status)) {
    return { wrongStatus: order.status };
  }

  const [orgRows, customerRows, lineRows] = await Promise.all([
    db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId))
      .limit(1),
    db
      .select()
      .from(customersTable)
      .where(
        and(
          eq(customersTable.id, order.customerId),
          eq(customersTable.organizationId, organizationId),
        ),
      )
      .limit(1),
    db
      .select({
        line: salesOrderLinesTable,
        itemName: itemsTable.name,
        sku: itemsTable.sku,
        hsnCode: itemsTable.hsnCode,
      })
      .from(salesOrderLinesTable)
      .innerJoin(itemsTable, eq(itemsTable.id, salesOrderLinesTable.itemId))
      .where(eq(salesOrderLinesTable.salesOrderId, salesOrderId))
      .orderBy(asc(salesOrderLinesTable.id)),
  ]);

  const org = orgRows[0];
  const customer = customerRows[0];
  if (!org || !customer) return { notFound: true };

  const lines: InvoicePdfLine[] = lineRows.map((r) => ({
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
  }));

  const logoBuffer = await fetchLogoBuffer(org.logoUrl, organizationId);

  const einvoice: InvoicePdfEinvoice | null =
    order.irn && order.irpQrPayload && order.irpStatus !== "failed"
      ? {
          irn: order.irn,
          ackNumber: order.irpAckNumber,
          ackDate: order.irpAckDate,
          qrPayload: order.irpQrPayload,
          status: order.irpStatus,
        }
      : null;

  const ewb: InvoicePdfEwb | null = order.ewbNumber
    ? {
        number: order.ewbNumber,
        date: order.ewbDate,
        validUntil: order.ewbValidUntil,
        vehicleNumber: order.ewbVehicleNumber,
        transportMode: order.ewbTransportMode,
        qrPayload: order.ewbQrPayload ?? buildEwbQrPayload(order.ewbNumber),
        status: order.ewbStatus ?? "active",
      }
    : null;

  const pdf = await renderInvoicePdf({
    org: {
      name: org.name,
      gstNumber: org.gstNumber,
      addressLine1: org.addressLine1,
      addressLine2: org.addressLine2,
      city: org.city,
      state: org.state,
      postalCode: org.postalCode,
      country: org.country,
      logoUrl: org.logoUrl,
      invoiceFooter: org.invoiceFooter,
    },
    customer: {
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      company: customer.company,
      gstNumber: customer.gstNumber,
      billingAddress: customer.billingAddress,
      shippingAddress: customer.shippingAddress,
      placeOfSupply: customer.placeOfSupply,
    },
    order: {
      orderNumber: order.orderNumber,
      orderDate: order.orderDate,
      expectedShipDate: order.expectedShipDate,
      notes: order.notes,
      subtotal: order.subtotal,
      taxTotal: order.taxTotal,
      total: order.total,
      amountPaid: order.amountPaid,
      balanceDue: order.balanceDue,
    },
    lines,
    logoBuffer,
    ewb,
    einvoice,
  });

  return {
    pdf,
    orderNumber: order.orderNumber,
    customerEmail: customer.email,
    customerName: customer.name,
    status: order.status,
    total: Number(order.total),
  };
}
