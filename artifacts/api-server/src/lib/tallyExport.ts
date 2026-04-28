import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  db,
  salesOrdersTable,
  salesOrderLinesTable,
  customersTable,
  itemsTable,
  customerPaymentsTable,
  supplierPaymentsTable,
  suppliersTable,
  purchaseOrdersTable,
  purchaseOrderLinesTable,
  organizationsTable,
} from "@workspace/db";
import { toNum } from "./numeric";
import { gstStateCodeFromGstin, gstStateCodeFromName } from "./gstStates";

// Tally importable XML uses a single ENVELOPE wrapping a series of
// TALLYMESSAGE blocks, each holding one VOUCHER. Tally's import is
// fairly permissive: it only requires that ledger names referenced in
// the voucher already exist (or are created in the same import as
// LEDGER masters). To keep the export drop-in-friendly we DO emit
// LEDGER masters for the parties we touch, plus the standard tax /
// sales / purchase ledgers.

export interface TallyExportOptions {
  fromDate: string;
  toDate: string;
  include: {
    sales: boolean;
    receipts: boolean;
    purchases: boolean;
    payments: boolean;
  };
}

export async function buildTallyXml(
  orgId: number,
  opts: TallyExportOptions,
): Promise<string> {
  const [org] = await db
    .select({
      name: organizationsTable.name,
      gstNumber: organizationsTable.gstNumber,
      state: organizationsTable.state,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId))
    .limit(1);
  if (!org) throw new Error("organization not found");
  const orgStateCode =
    gstStateCodeFromGstin(org.gstNumber) ?? gstStateCodeFromName(org.state);

  const partyLedgers = new Map<string, { name: string; gstin: string | null; group: "Sundry Debtors" | "Sundry Creditors" }>();
  const messages: string[] = [];

  if (opts.include.sales) {
    const rows = await loadSalesInvoices(orgId, opts.fromDate, opts.toDate);
    for (const inv of rows) {
      partyLedgers.set(`C:${inv.customerId}`, {
        name: inv.customerName,
        gstin: inv.customerGstin,
        group: "Sundry Debtors",
      });
      messages.push(buildSalesVoucher(inv, orgStateCode));
    }
  }

  if (opts.include.receipts) {
    const rows = await loadCustomerPayments(orgId, opts.fromDate, opts.toDate);
    for (const p of rows) {
      partyLedgers.set(`C:${p.customerId}`, {
        name: p.customerName,
        gstin: null,
        group: "Sundry Debtors",
      });
      messages.push(buildReceiptVoucher(p));
    }
  }

  if (opts.include.purchases) {
    const rows = await loadPurchaseInvoices(orgId, opts.fromDate, opts.toDate);
    for (const inv of rows) {
      partyLedgers.set(`S:${inv.supplierId}`, {
        name: inv.supplierName,
        gstin: inv.supplierGstin,
        group: "Sundry Creditors",
      });
      messages.push(buildPurchaseVoucher(inv, orgStateCode));
    }
  }

  if (opts.include.payments) {
    const rows = await loadSupplierPayments(orgId, opts.fromDate, opts.toDate);
    for (const p of rows) {
      partyLedgers.set(`S:${p.supplierId}`, {
        name: p.supplierName,
        gstin: null,
        group: "Sundry Creditors",
      });
      messages.push(buildPaymentVoucher(p));
    }
  }

  const ledgerXml: string[] = [];
  // Standard ledgers we reference. Marking them with a known parent
  // keeps Tally happy when the company does not already have them.
  ledgerXml.push(
    buildLedgerMaster("Sales Account", "Sales Accounts"),
    buildLedgerMaster("Purchase Account", "Purchase Accounts"),
    buildLedgerMaster("Output IGST", "Duties & Taxes"),
    buildLedgerMaster("Output CGST", "Duties & Taxes"),
    buildLedgerMaster("Output SGST", "Duties & Taxes"),
    buildLedgerMaster("Input IGST", "Duties & Taxes"),
    buildLedgerMaster("Input CGST", "Duties & Taxes"),
    buildLedgerMaster("Input SGST", "Duties & Taxes"),
    buildLedgerMaster("Cash", "Cash-in-Hand"),
    buildLedgerMaster("Bank", "Bank Accounts"),
  );
  for (const p of partyLedgers.values()) {
    ledgerXml.push(buildPartyLedgerMaster(p.name, p.group, p.gstin));
  }

  // Tally requires masters and vouchers to live in separate IMPORTDATA
  // blocks (REPORTNAME=All Masters vs Vouchers) — mixing them under a
  // single REPORTNAME causes Tally to silently skip the wrong-typed
  // entries on import.
  const company = escapeXml(org.name);
  const blocks: string[] = [];
  if (ledgerXml.length > 0) {
    blocks.push(
      [
        `    <IMPORTDATA>`,
        `      <REQUESTDESC>`,
        `        <REPORTNAME>All Masters</REPORTNAME>`,
        `        <STATICVARIABLES>`,
        `          <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>`,
        `        </STATICVARIABLES>`,
        `      </REQUESTDESC>`,
        `      <REQUESTDATA>`,
        ledgerXml.join("\n"),
        `      </REQUESTDATA>`,
        `    </IMPORTDATA>`,
      ].join("\n"),
    );
  }
  if (messages.length > 0) {
    blocks.push(
      [
        `    <IMPORTDATA>`,
        `      <REQUESTDESC>`,
        `        <REPORTNAME>Vouchers</REPORTNAME>`,
        `        <STATICVARIABLES>`,
        `          <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>`,
        `        </STATICVARIABLES>`,
        `      </REQUESTDESC>`,
        `      <REQUESTDATA>`,
        messages.join("\n"),
        `      </REQUESTDATA>`,
        `    </IMPORTDATA>`,
      ].join("\n"),
    );
  }
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<ENVELOPE>`,
    `  <HEADER>`,
    `    <TALLYREQUEST>Import Data</TALLYREQUEST>`,
    `  </HEADER>`,
    `  <BODY>`,
    blocks.join("\n"),
    `  </BODY>`,
    `</ENVELOPE>`,
  ].join("\n");
}

interface SalesInvoiceRow {
  orderId: number;
  orderNumber: string;
  orderDate: string;
  status: string;
  total: number;
  customerId: number;
  customerName: string;
  customerGstin: string | null;
  customerStateCode: number | null;
  lines: Array<{
    itemName: string;
    hsnCode: string | null;
    unit: string;
    quantity: number;
    unitPrice: number;
    taxRate: number;
    lineSubtotal: number;
    lineTax: number;
  }>;
}

async function loadSalesInvoices(
  orgId: number,
  from: string,
  to: string,
): Promise<SalesInvoiceRow[]> {
  const orders = await db
    .select({
      id: salesOrdersTable.id,
      orderNumber: salesOrdersTable.orderNumber,
      orderDate: salesOrdersTable.orderDate,
      status: salesOrdersTable.status,
      total: salesOrdersTable.total,
      customerId: customersTable.id,
      customerName: customersTable.name,
      customerGstin: customersTable.gstNumber,
      placeOfSupply: customersTable.placeOfSupply,
    })
    .from(salesOrdersTable)
    .innerJoin(customersTable, eq(customersTable.id, salesOrdersTable.customerId))
    .where(
      and(
        eq(salesOrdersTable.organizationId, orgId),
        gte(salesOrdersTable.orderDate, from),
        lte(salesOrdersTable.orderDate, to),
        sql`${salesOrdersTable.status} NOT IN ('draft', 'cancelled')`,
      ),
    );
  if (orders.length === 0) return [];
  const orderIds = orders.map((o) => o.id);
  const lines = await db
    .select({
      orderId: salesOrderLinesTable.salesOrderId,
      itemName: itemsTable.name,
      hsnCode: itemsTable.hsnCode,
      unit: itemsTable.unit,
      quantity: salesOrderLinesTable.quantity,
      unitPrice: salesOrderLinesTable.unitPrice,
      taxRate: salesOrderLinesTable.taxRate,
      lineSubtotal: salesOrderLinesTable.lineSubtotal,
      lineTax: salesOrderLinesTable.lineTax,
    })
    .from(salesOrderLinesTable)
    .innerJoin(itemsTable, eq(itemsTable.id, salesOrderLinesTable.itemId))
    .where(
      sql`${salesOrderLinesTable.salesOrderId} IN (${sql.join(
        orderIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  const byOrder = new Map<number, SalesInvoiceRow["lines"]>();
  for (const l of lines) {
    const arr = byOrder.get(l.orderId) ?? [];
    arr.push({
      itemName: l.itemName,
      hsnCode: l.hsnCode,
      unit: l.unit,
      quantity: toNum(l.quantity),
      unitPrice: toNum(l.unitPrice),
      taxRate: toNum(l.taxRate),
      lineSubtotal: toNum(l.lineSubtotal),
      lineTax: toNum(l.lineTax),
    });
    byOrder.set(l.orderId, arr);
  }
  return orders.map((o) => ({
    orderId: o.id,
    orderNumber: o.orderNumber,
    orderDate: o.orderDate,
    status: o.status,
    total: toNum(o.total),
    customerId: o.customerId,
    customerName: o.customerName,
    customerGstin: o.customerGstin,
    customerStateCode:
      gstStateCodeFromGstin(o.customerGstin) ??
      gstStateCodeFromName(o.placeOfSupply),
    lines: byOrder.get(o.id) ?? [],
  }));
}

interface PurchaseInvoiceRow {
  orderId: number;
  orderNumber: string;
  orderDate: string;
  status: string;
  total: number;
  supplierId: number;
  supplierName: string;
  supplierGstin: string | null;
  supplierStateCode: number | null;
  lines: Array<{
    itemName: string;
    hsnCode: string | null;
    unit: string;
    quantity: number;
    unitPrice: number;
    taxRate: number;
    lineSubtotal: number;
    lineTax: number;
  }>;
}

async function loadPurchaseInvoices(
  orgId: number,
  from: string,
  to: string,
): Promise<PurchaseInvoiceRow[]> {
  const orders = await db
    .select({
      id: purchaseOrdersTable.id,
      orderNumber: purchaseOrdersTable.orderNumber,
      orderDate: purchaseOrdersTable.orderDate,
      status: purchaseOrdersTable.status,
      total: purchaseOrdersTable.total,
      supplierId: suppliersTable.id,
      supplierName: suppliersTable.name,
      supplierGstin: suppliersTable.gstNumber,
    })
    .from(purchaseOrdersTable)
    .innerJoin(suppliersTable, eq(suppliersTable.id, purchaseOrdersTable.supplierId))
    .where(
      and(
        eq(purchaseOrdersTable.organizationId, orgId),
        gte(purchaseOrdersTable.orderDate, from),
        lte(purchaseOrdersTable.orderDate, to),
        sql`${purchaseOrdersTable.status} NOT IN ('draft', 'cancelled')`,
      ),
    );
  if (orders.length === 0) return [];
  const orderIds = orders.map((o) => o.id);
  const lines = await db
    .select({
      orderId: purchaseOrderLinesTable.purchaseOrderId,
      itemName: itemsTable.name,
      hsnCode: itemsTable.hsnCode,
      unit: itemsTable.unit,
      quantity: purchaseOrderLinesTable.quantity,
      unitPrice: purchaseOrderLinesTable.unitPrice,
      taxRate: purchaseOrderLinesTable.taxRate,
      lineSubtotal: purchaseOrderLinesTable.lineSubtotal,
      lineTax: purchaseOrderLinesTable.lineTax,
    })
    .from(purchaseOrderLinesTable)
    .innerJoin(itemsTable, eq(itemsTable.id, purchaseOrderLinesTable.itemId))
    .where(
      sql`${purchaseOrderLinesTable.purchaseOrderId} IN (${sql.join(
        orderIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  const byOrder = new Map<number, PurchaseInvoiceRow["lines"]>();
  for (const l of lines) {
    const arr = byOrder.get(l.orderId) ?? [];
    arr.push({
      itemName: l.itemName,
      hsnCode: l.hsnCode,
      unit: l.unit,
      quantity: toNum(l.quantity),
      unitPrice: toNum(l.unitPrice),
      taxRate: toNum(l.taxRate),
      lineSubtotal: toNum(l.lineSubtotal),
      lineTax: toNum(l.lineTax),
    });
    byOrder.set(l.orderId, arr);
  }
  return orders.map((o) => ({
    orderId: o.id,
    orderNumber: o.orderNumber,
    orderDate: o.orderDate,
    status: o.status,
    total: toNum(o.total),
    supplierId: o.supplierId,
    supplierName: o.supplierName,
    supplierGstin: o.supplierGstin,
    supplierStateCode: gstStateCodeFromGstin(o.supplierGstin),
    lines: byOrder.get(o.id) ?? [],
  }));
}

interface CustomerPaymentRow {
  id: number;
  paymentDate: string;
  amount: number;
  mode: string;
  referenceNumber: string | null;
  bankAccountLabel: string | null;
  customerId: number;
  customerName: string;
}

async function loadCustomerPayments(
  orgId: number,
  from: string,
  to: string,
): Promise<CustomerPaymentRow[]> {
  const rows = await db
    .select({
      id: customerPaymentsTable.id,
      paymentDate: customerPaymentsTable.paymentDate,
      amount: customerPaymentsTable.amount,
      mode: customerPaymentsTable.mode,
      referenceNumber: customerPaymentsTable.referenceNumber,
      bankAccountLabel: customerPaymentsTable.bankAccountLabel,
      customerId: customersTable.id,
      customerName: customersTable.name,
    })
    .from(customerPaymentsTable)
    .innerJoin(
      customersTable,
      eq(customersTable.id, customerPaymentsTable.customerId),
    )
    .where(
      and(
        eq(customerPaymentsTable.organizationId, orgId),
        gte(customerPaymentsTable.paymentDate, from),
        lte(customerPaymentsTable.paymentDate, to),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    paymentDate: r.paymentDate,
    amount: toNum(r.amount),
    mode: r.mode,
    referenceNumber: r.referenceNumber,
    bankAccountLabel: r.bankAccountLabel,
    customerId: r.customerId,
    customerName: r.customerName,
  }));
}

interface SupplierPaymentRow {
  id: number;
  paymentDate: string;
  amount: number;
  mode: string;
  referenceNumber: string | null;
  bankAccountLabel: string | null;
  supplierId: number;
  supplierName: string;
}

async function loadSupplierPayments(
  orgId: number,
  from: string,
  to: string,
): Promise<SupplierPaymentRow[]> {
  const rows = await db
    .select({
      id: supplierPaymentsTable.id,
      paymentDate: supplierPaymentsTable.paymentDate,
      amount: supplierPaymentsTable.amount,
      mode: supplierPaymentsTable.mode,
      referenceNumber: supplierPaymentsTable.referenceNumber,
      bankAccountLabel: supplierPaymentsTable.bankAccountLabel,
      supplierId: suppliersTable.id,
      supplierName: suppliersTable.name,
    })
    .from(supplierPaymentsTable)
    .innerJoin(
      suppliersTable,
      eq(suppliersTable.id, supplierPaymentsTable.supplierId),
    )
    .where(
      and(
        eq(supplierPaymentsTable.organizationId, orgId),
        gte(supplierPaymentsTable.paymentDate, from),
        lte(supplierPaymentsTable.paymentDate, to),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    paymentDate: r.paymentDate,
    amount: toNum(r.amount),
    mode: r.mode,
    referenceNumber: r.referenceNumber,
    bankAccountLabel: r.bankAccountLabel,
    supplierId: r.supplierId,
    supplierName: r.supplierName,
  }));
}

// ─────────────────────────────────────────────────────────────────────
// Voucher builders.
// ─────────────────────────────────────────────────────────────────────

function isoToTallyDate(iso: string): string {
  // Tally expects YYYYMMDD with no separators in DATE fields.
  return iso.replace(/-/gu, "");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function fmtAmount(n: number): string {
  // Tally treats negative ledger amounts as DR and positive as CR (or
  // vice versa depending on the voucher type). We keep the sign that
  // matches the calling site's convention.
  return n.toFixed(2);
}

// Split a tax total into CGST + SGST halves while preserving the
// rupee total to 2-decimal precision (the leftover paisa goes to
// SGST). Mirrors gstReports.splitTax so reports + Tally agree.
function halfTaxSplit(taxTotal: number): { cgst: number; sgst: number } {
  const cgst = Math.round((taxTotal / 2) * 100) / 100;
  const sgst = Math.round((taxTotal - cgst) * 100) / 100;
  return { cgst, sgst };
}

function buildLedgerMaster(name: string, parent: string): string {
  return [
    `        <TALLYMESSAGE xmlns:UDF="TallyUDF">`,
    `          <LEDGER NAME="${escapeXml(name)}" ACTION="Create">`,
    `            <NAME>${escapeXml(name)}</NAME>`,
    `            <PARENT>${escapeXml(parent)}</PARENT>`,
    `          </LEDGER>`,
    `        </TALLYMESSAGE>`,
  ].join("\n");
}

function buildPartyLedgerMaster(
  name: string,
  parent: string,
  gstin: string | null,
): string {
  const gstinLine = gstin
    ? `            <PARTYGSTIN>${escapeXml(gstin)}</PARTYGSTIN>`
    : "";
  return [
    `        <TALLYMESSAGE xmlns:UDF="TallyUDF">`,
    `          <LEDGER NAME="${escapeXml(name)}" ACTION="Create">`,
    `            <NAME>${escapeXml(name)}</NAME>`,
    `            <PARENT>${escapeXml(parent)}</PARENT>`,
    gstinLine,
    `          </LEDGER>`,
    `        </TALLYMESSAGE>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildSalesVoucher(
  inv: SalesInvoiceRow,
  orgStateCode: number | null,
): string {
  const sameState =
    orgStateCode != null &&
    inv.customerStateCode != null &&
    orgStateCode === inv.customerStateCode;
  const taxableTotal = inv.lines.reduce((s, l) => s + l.lineSubtotal, 0);
  const taxTotal = inv.lines.reduce((s, l) => s + l.lineTax, 0);
  const isReturn = inv.status === "returned";
  const voucherType = isReturn ? "Credit Note" : "Sales";
  // Sales accounting: customer is DR (debit ⇒ negative AMOUNT in our
  // helper), Sales + Output Tax are CR (credit ⇒ positive). For a
  // returned sale (Credit Note) every leg flips.
  const sign = isReturn ? -1 : 1;
  const partyAmt = -sign * (taxableTotal + taxTotal);
  const salesAmt = sign * taxableTotal;
  const taxRows: string[] = [];
  if (sameState) {
    const split = halfTaxSplit(taxTotal);
    taxRows.push(ledgerEntry("Output CGST", sign * split.cgst));
    taxRows.push(ledgerEntry("Output SGST", sign * split.sgst));
  } else {
    taxRows.push(ledgerEntry("Output IGST", sign * taxTotal));
  }
  return [
    `        <TALLYMESSAGE xmlns:UDF="TallyUDF">`,
    `          <VOUCHER VCHTYPE="${voucherType}" ACTION="Create">`,
    `            <DATE>${isoToTallyDate(inv.orderDate)}</DATE>`,
    `            <VOUCHERTYPENAME>${voucherType}</VOUCHERTYPENAME>`,
    `            <VOUCHERNUMBER>${escapeXml(inv.orderNumber)}</VOUCHERNUMBER>`,
    `            <PARTYLEDGERNAME>${escapeXml(inv.customerName)}</PARTYLEDGERNAME>`,
    `            <REFERENCE>${escapeXml(inv.orderNumber)}</REFERENCE>`,
    ledgerEntry(inv.customerName, partyAmt),
    ledgerEntry("Sales Account", salesAmt),
    taxRows.join("\n"),
    `          </VOUCHER>`,
    `        </TALLYMESSAGE>`,
  ].join("\n");
}

function buildPurchaseVoucher(
  inv: PurchaseInvoiceRow,
  orgStateCode: number | null,
): string {
  const sameState =
    orgStateCode != null &&
    inv.supplierStateCode != null &&
    orgStateCode === inv.supplierStateCode;
  const taxableTotal = inv.lines.reduce((s, l) => s + l.lineSubtotal, 0);
  const taxTotal = inv.lines.reduce((s, l) => s + l.lineTax, 0);
  // Purchase accounting: supplier is CR (credit ⇒ positive AMOUNT),
  // Purchase + Input Tax are DR (debit ⇒ negative).
  const partyAmt = taxableTotal + taxTotal;
  const purchaseAmt = -taxableTotal;
  const taxRows: string[] = [];
  if (sameState) {
    const split = halfTaxSplit(taxTotal);
    taxRows.push(ledgerEntry("Input CGST", -split.cgst));
    taxRows.push(ledgerEntry("Input SGST", -split.sgst));
  } else {
    taxRows.push(ledgerEntry("Input IGST", -taxTotal));
  }
  return [
    `        <TALLYMESSAGE xmlns:UDF="TallyUDF">`,
    `          <VOUCHER VCHTYPE="Purchase" ACTION="Create">`,
    `            <DATE>${isoToTallyDate(inv.orderDate)}</DATE>`,
    `            <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>`,
    `            <VOUCHERNUMBER>${escapeXml(inv.orderNumber)}</VOUCHERNUMBER>`,
    `            <PARTYLEDGERNAME>${escapeXml(inv.supplierName)}</PARTYLEDGERNAME>`,
    `            <REFERENCE>${escapeXml(inv.orderNumber)}</REFERENCE>`,
    ledgerEntry(inv.supplierName, partyAmt),
    ledgerEntry("Purchase Account", purchaseAmt),
    taxRows.join("\n"),
    `          </VOUCHER>`,
    `        </TALLYMESSAGE>`,
  ].join("\n");
}

function buildReceiptVoucher(p: CustomerPaymentRow): string {
  const bank = p.mode === "cash" ? "Cash" : "Bank";
  const ref = p.referenceNumber ? `RCPT-${p.id}-${p.referenceNumber}` : `RCPT-${p.id}`;
  return [
    `        <TALLYMESSAGE xmlns:UDF="TallyUDF">`,
    `          <VOUCHER VCHTYPE="Receipt" ACTION="Create">`,
    `            <DATE>${isoToTallyDate(p.paymentDate)}</DATE>`,
    `            <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>`,
    `            <VOUCHERNUMBER>${escapeXml(ref)}</VOUCHERNUMBER>`,
    `            <PARTYLEDGERNAME>${escapeXml(p.customerName)}</PARTYLEDGERNAME>`,
    ledgerEntry(bank, -p.amount),
    ledgerEntry(p.customerName, p.amount),
    `          </VOUCHER>`,
    `        </TALLYMESSAGE>`,
  ].join("\n");
}

function buildPaymentVoucher(p: SupplierPaymentRow): string {
  const bank = p.mode === "cash" ? "Cash" : "Bank";
  const ref = p.referenceNumber ? `PAY-${p.id}-${p.referenceNumber}` : `PAY-${p.id}`;
  return [
    `        <TALLYMESSAGE xmlns:UDF="TallyUDF">`,
    `          <VOUCHER VCHTYPE="Payment" ACTION="Create">`,
    `            <DATE>${isoToTallyDate(p.paymentDate)}</DATE>`,
    `            <VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>`,
    `            <VOUCHERNUMBER>${escapeXml(ref)}</VOUCHERNUMBER>`,
    `            <PARTYLEDGERNAME>${escapeXml(p.supplierName)}</PARTYLEDGERNAME>`,
    ledgerEntry(p.supplierName, -p.amount),
    ledgerEntry(bank, p.amount),
    `          </VOUCHER>`,
    `        </TALLYMESSAGE>`,
  ].join("\n");
}

function ledgerEntry(name: string, amount: number): string {
  // Tally convention: AMOUNT carries the sign — negative = debit,
  // positive = credit. ISDEEMEDPOSITIVE is metadata that mirrors that
  // direction (Yes = debit, No = credit). Callers pass `amount` with
  // the same sign convention (positive credit, negative debit), so we
  // emit it verbatim.
  const isDebit = amount < 0;
  return [
    `            <ALLLEDGERENTRIES.LIST>`,
    `              <LEDGERNAME>${escapeXml(name)}</LEDGERNAME>`,
    `              <ISDEEMEDPOSITIVE>${isDebit ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`,
    `              <AMOUNT>${fmtAmount(amount)}</AMOUNT>`,
    `            </ALLLEDGERENTRIES.LIST>`,
  ].join("\n");
}
