import { and, eq, asc } from "drizzle-orm";
import dns from "node:dns/promises";
import net from "node:net";
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
  type InvoicePdfLine,
} from "./invoicePdf";
import { logger } from "./logger";

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

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (h === "metadata.google.internal") return true;
  return false;
}

function isBlockedIPv4(addr: string): boolean {
  const m = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return true;
  const o = m.slice(1).map((s) => Number(s));
  if (o.some((n) => n < 0 || n > 255)) return true;
  const [a, b] = o as [number, number, number, number];
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isBlockedIPv6(addr: string): boolean {
  const a = addr.toLowerCase().split("%")[0]!;
  if (a === "::" || a === "::1") return true;
  if (a.startsWith("fe80:") || a.startsWith("fc") || a.startsWith("fd")) return true;
  if (a.startsWith("ff")) return true; // multicast
  // ::ffff:x.x.x.x mapped IPv4
  const mapped = a.match(/^::ffff:([0-9a-f.:]+)$/);
  if (mapped) {
    const inner = mapped[1]!;
    if (inner.includes(".")) return isBlockedIPv4(inner);
  }
  return false;
}

async function isHostSafe(hostname: string): Promise<boolean> {
  if (isBlockedHostname(hostname)) return false;
  // Literal IPs — check directly
  if (net.isIPv4(hostname)) return !isBlockedIPv4(hostname);
  if (net.isIPv6(hostname)) return !isBlockedIPv6(hostname);
  // DNS resolution — block if any resolved address is in a private/reserved range
  try {
    const results = await dns.lookup(hostname, { all: true, verbatim: true });
    if (results.length === 0) return false;
    for (const r of results) {
      if (r.family === 4 && isBlockedIPv4(r.address)) return false;
      if (r.family === 6 && isBlockedIPv6(r.address)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function fetchLogoBuffer(url: string | null): Promise<Buffer | null> {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (!(await isHostSafe(parsed.hostname))) {
    logger.warn({ url }, "Blocked logo URL targeting private/loopback host");
    return null;
  }
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(parsed.toString(), {
      signal: ctrl.signal,
      redirect: "manual",
    });
    clearTimeout(timeout);
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.startsWith("image/png") && !ct.startsWith("image/jpeg")) return null;
    const ab = await r.arrayBuffer();
    if (ab.byteLength > 2 * 1024 * 1024) return null;
    return Buffer.from(ab);
  } catch (err) {
    logger.warn({ err, url }, "Could not fetch organization logo for invoice");
    return null;
  }
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
      .where(eq(customersTable.id, order.customerId))
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

  const logoBuffer = await fetchLogoBuffer(org.logoUrl);

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
