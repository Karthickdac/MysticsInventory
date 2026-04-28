import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  db,
  salesOrdersTable,
  salesOrderLinesTable,
  customersTable,
  itemsTable,
  organizationsTable,
} from "@workspace/db";
import { toNum } from "./numeric";
import { gstStateCodeFromGstin, gstStateCodeFromName } from "./gstStates";

// ─────────────────────────────────────────────────────────────────────
// Period handling. GSTR returns are filed for a calendar month or a
// quarter (QRMP scheme). We accept "YYYY-MM" for monthly filers and
// "YYYY-Qn" (n = 1..4, where Q1 = Apr–Jun) for quarterly filers, and
// resolve bounds in Asia/Kolkata so that an invoice timestamped
// 2026-04-30T22:00:00Z (which is 2026-05-01 03:30 IST) lands in May.
// ─────────────────────────────────────────────────────────────────────

const MONTH_RE = /^(\d{4})-(\d{2})$/u;
const QUARTER_RE = /^(\d{4})-Q([1-4])$/u;

export interface ResolvedPeriod {
  /** Original input, e.g. "2026-04" or "2026-Q1". */
  period: string;
  /** "month" or "quarter" — drives filing-period serialization. */
  kind: "month" | "quarter";
  /** ISO date (YYYY-MM-DD) for the first day of the period in IST. */
  fromDate: string;
  /** ISO date (YYYY-MM-DD) for the last day of the period in IST. */
  toDate: string;
  /** Indian financial-year label, e.g. "2026-27" for Apr-Mar. */
  fyLabel: string;
  /** Last calendar month of the period as 1-12. Used to build fp. */
  endMonth: number;
  /** Calendar year of the end month. */
  endYear: number;
}

const QUARTER_START_MONTHS: Record<string, number> = {
  "1": 4, // Apr
  "2": 7, // Jul
  "3": 10, // Oct
  "4": 1, // Jan (of next calendar year)
};

export function parsePeriod(input: string | undefined): ResolvedPeriod {
  const raw = (input ?? "").trim();
  const qm = raw.match(QUARTER_RE);
  if (qm) return resolveQuarter(Number(qm[1]), qm[2]!);
  const m = raw.match(MONTH_RE);
  if (!m) {
    throw new Error("period must be YYYY-MM or YYYY-Qn (Q1-Q4)");
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error("month must be 1-12");
  return resolveMonthRange(year, month, year, month, `${m[1]}-${m[2]}`, "month");
}

function resolveQuarter(fyStartYear: number, q: string): ResolvedPeriod {
  // Indian quarters relative to a financial year (Apr-Mar):
  //   Q1: Apr–Jun (fyStartYear), Q2: Jul–Sep (fyStartYear),
  //   Q3: Oct–Dec (fyStartYear), Q4: Jan–Mar (fyStartYear+1).
  const startMonth = QUARTER_START_MONTHS[q]!;
  const startYear = q === "4" ? fyStartYear + 1 : fyStartYear;
  const endMonth = startMonth + 2 > 12 ? startMonth + 2 - 12 : startMonth + 2;
  const endYear =
    startMonth + 2 > 12 ? startYear + 1 : startYear;
  return resolveMonthRange(
    startYear,
    startMonth,
    endYear,
    endMonth,
    `${fyStartYear}-Q${q}`,
    "quarter",
  );
}

function resolveMonthRange(
  startYear: number,
  startMonth: number,
  endYear: number,
  endMonth: number,
  label: string,
  kind: "month" | "quarter",
): ResolvedPeriod {
  const fromDate = `${startYear}-${String(startMonth).padStart(2, "0")}-01`;
  const nextMonthUtc = new Date(Date.UTC(endYear, endMonth, 1));
  const lastDayUtc = new Date(nextMonthUtc.getTime() - 24 * 60 * 60 * 1000);
  const toDate = lastDayUtc.toISOString().slice(0, 10);
  const fyStart = startMonth >= 4 ? startYear : startYear - 1;
  const fyEndShort = String((fyStart + 1) % 100).padStart(2, "0");
  return {
    period: label,
    kind,
    fromDate,
    toDate,
    fyLabel: `${fyStart}-${fyEndShort}`,
    endMonth,
    endYear,
  };
}

// GSTN GSTR-1 / 3B "fp" (filing period) is MMYYYY of the last calendar
// month in the return period. Quarterly filers use the quarter's
// closing month (Jun=06, Sep=09, Dec=12, Mar=03).
export function gstnFilingPeriod(period: ResolvedPeriod): string {
  return `${String(period.endMonth).padStart(2, "0")}${period.endYear}`;
}

// ─────────────────────────────────────────────────────────────────────
// Aggregation queries.
// ─────────────────────────────────────────────────────────────────────

interface InvoiceRow {
  orderId: number;
  orderNumber: string;
  orderDate: string;
  status: string;
  total: number;
  taxTotal: number;
  subtotal: number;
  customerId: number;
  customerName: string;
  customerGstin: string | null;
  customerStateCode: number | null;
  customerStateName: string | null;
}

interface InvoiceLineRow {
  orderId: number;
  itemId: number;
  itemName: string;
  hsnCode: string | null;
  unit: string;
  quantity: number;
  taxRate: number;
  lineSubtotal: number;
  lineTax: number;
}

async function loadInvoices(
  orgId: number,
  period: ResolvedPeriod,
): Promise<{ invoices: InvoiceRow[]; lines: InvoiceLineRow[] }> {
  const rawInvoices = await db
    .select({
      id: salesOrdersTable.id,
      orderNumber: salesOrdersTable.orderNumber,
      orderDate: salesOrdersTable.orderDate,
      status: salesOrdersTable.status,
      subtotal: salesOrdersTable.subtotal,
      taxTotal: salesOrdersTable.taxTotal,
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
        gte(salesOrdersTable.orderDate, period.fromDate),
        lte(salesOrdersTable.orderDate, period.toDate),
        sql`${salesOrdersTable.status} NOT IN ('draft', 'cancelled')`,
      ),
    );

  const invoices: InvoiceRow[] = rawInvoices.map((r) => {
    const stateCode =
      gstStateCodeFromGstin(r.customerGstin) ??
      gstStateCodeFromName(r.placeOfSupply);
    return {
      orderId: r.id,
      orderNumber: r.orderNumber,
      orderDate: r.orderDate,
      status: r.status,
      subtotal: toNum(r.subtotal),
      taxTotal: toNum(r.taxTotal),
      total: toNum(r.total),
      customerId: r.customerId,
      customerName: r.customerName,
      customerGstin: r.customerGstin,
      customerStateCode: stateCode,
      customerStateName: r.placeOfSupply,
    };
  });

  if (invoices.length === 0) return { invoices, lines: [] };

  const orderIds = invoices.map((i) => i.orderId);
  const rawLines = await db
    .select({
      orderId: salesOrderLinesTable.salesOrderId,
      itemId: salesOrderLinesTable.itemId,
      itemName: itemsTable.name,
      hsnCode: itemsTable.hsnCode,
      unit: itemsTable.unit,
      quantity: salesOrderLinesTable.quantity,
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

  const lines: InvoiceLineRow[] = rawLines.map((r) => ({
    orderId: r.orderId,
    itemId: r.itemId,
    itemName: r.itemName,
    hsnCode: r.hsnCode,
    unit: r.unit,
    quantity: toNum(r.quantity),
    taxRate: toNum(r.taxRate),
    lineSubtotal: toNum(r.lineSubtotal),
    lineTax: toNum(r.lineTax),
  }));

  return { invoices, lines };
}

async function loadOrgStateCode(orgId: number): Promise<number | null> {
  const [org] = await db
    .select({
      gstNumber: organizationsTable.gstNumber,
      state: organizationsTable.state,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId))
    .limit(1);
  if (!org) return null;
  return (
    gstStateCodeFromGstin(org.gstNumber) ?? gstStateCodeFromName(org.state)
  );
}

// Split a line's tax into IGST vs CGST/SGST based on whether the
// supplier and the recipient are in the same state. We do this on the
// already-totalled lineTax to avoid recomputing rate * subtotal in
// floating-point and disagreeing with the stored invoice total.
function splitTax(
  lineTax: number,
  sameState: boolean,
): { igst: number; cgst: number; sgst: number } {
  if (sameState) {
    const half = round2(lineTax / 2);
    // Push any half-cent rounding into CGST so CGST + SGST = lineTax.
    return { igst: 0, cgst: half, sgst: round2(lineTax - half) };
  }
  return { igst: round2(lineTax), cgst: 0, sgst: 0 };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────
// GSTR-1 — outward supplies, sectioned per the GSTN spec.
// ─────────────────────────────────────────────────────────────────────

export interface Gstr1B2bInvoice {
  invoiceNumber: string;
  invoiceDate: string;
  invoiceValue: number;
  placeOfSupply: string | null;
  reverseCharge: "Y" | "N";
  invoiceType: "Regular" | "Credit Note";
  buyerName: string;
  buyerGstin: string;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  rate: number;
}

export interface Gstr1B2cLargeInvoice {
  invoiceNumber: string;
  invoiceDate: string;
  invoiceValue: number;
  placeOfSupply: string | null;
  rate: number;
  taxableValue: number;
  igst: number;
}

export interface Gstr1B2cSmallSummary {
  /** "Same state" if intra-state, else the state code padded to 2. */
  placeOfSupply: string;
  rate: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
}

export interface Gstr1CreditNote {
  noteNumber: string;
  noteDate: string;
  originalInvoiceNumber: string | null;
  buyerName: string;
  buyerGstin: string | null;
  /** True ⇒ inter-state supply (POS state ≠ supplier state). */
  interState: boolean;
  /** Place-of-supply state code, "01"-"38" or empty. */
  placeOfSupply: string;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  rate: number;
  noteValue: number;
}

export interface Gstr1Report {
  period: ResolvedPeriod;
  orgGstin: string | null;
  b2b: Gstr1B2bInvoice[];
  b2cLarge: Gstr1B2cLargeInvoice[];
  b2cSmall: Gstr1B2cSmallSummary[];
  creditNotes: Gstr1CreditNote[];
  totals: {
    invoiceCount: number;
    taxableValue: number;
    igst: number;
    cgst: number;
    sgst: number;
    invoiceValue: number;
  };
}

const B2C_LARGE_THRESHOLD = 250000;

export async function computeGstr1(
  orgId: number,
  period: ResolvedPeriod,
): Promise<Gstr1Report> {
  const [org] = await db
    .select({ gstNumber: organizationsTable.gstNumber })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId))
    .limit(1);
  const orgStateCode = await loadOrgStateCode(orgId);
  const { invoices, lines } = await loadInvoices(orgId, period);
  const linesByOrder = new Map<number, InvoiceLineRow[]>();
  for (const l of lines) {
    const arr = linesByOrder.get(l.orderId) ?? [];
    arr.push(l);
    linesByOrder.set(l.orderId, arr);
  }

  const b2b: Gstr1B2bInvoice[] = [];
  const b2cLarge: Gstr1B2cLargeInvoice[] = [];
  const b2cSmallMap = new Map<string, Gstr1B2cSmallSummary>();
  const creditNotes: Gstr1CreditNote[] = [];
  const totals = {
    invoiceCount: 0,
    taxableValue: 0,
    igst: 0,
    cgst: 0,
    sgst: 0,
    invoiceValue: 0,
  };

  for (const inv of invoices) {
    const orderLines = linesByOrder.get(inv.orderId) ?? [];
    const sameState =
      orgStateCode != null &&
      inv.customerStateCode != null &&
      orgStateCode === inv.customerStateCode;
    const isCreditNote = inv.status === "returned";

    // Group lines by tax rate so that a single invoice can produce
    // multiple GSTR rows if it mixes 5% and 18% items.
    const byRate = new Map<
      number,
      { taxable: number; igst: number; cgst: number; sgst: number }
    >();
    for (const l of orderLines) {
      const split = splitTax(l.lineTax, sameState);
      const cur = byRate.get(l.taxRate) ?? {
        taxable: 0,
        igst: 0,
        cgst: 0,
        sgst: 0,
      };
      cur.taxable += l.lineSubtotal;
      cur.igst += split.igst;
      cur.cgst += split.cgst;
      cur.sgst += split.sgst;
      byRate.set(l.taxRate, cur);
    }

    const placeOfSupply =
      inv.customerStateCode != null
        ? `${String(inv.customerStateCode).padStart(2, "0")}-${
            inv.customerStateName ?? ""
          }`
        : inv.customerStateName;

    totals.invoiceCount += 1;
    totals.invoiceValue += inv.total;

    for (const [rate, agg] of byRate) {
      totals.taxableValue += agg.taxable;
      totals.igst += agg.igst;
      totals.cgst += agg.cgst;
      totals.sgst += agg.sgst;

      if (isCreditNote) {
        creditNotes.push({
          noteNumber: inv.orderNumber,
          noteDate: inv.orderDate,
          originalInvoiceNumber: null,
          buyerName: inv.customerName,
          buyerGstin: inv.customerGstin,
          interState: !sameState,
          placeOfSupply: placeOfSupply ?? "",
          taxableValue: round2(agg.taxable),
          igst: round2(agg.igst),
          cgst: round2(agg.cgst),
          sgst: round2(agg.sgst),
          rate,
          noteValue: round2(agg.taxable + agg.igst + agg.cgst + agg.sgst),
        });
        continue;
      }

      if (inv.customerGstin) {
        b2b.push({
          invoiceNumber: inv.orderNumber,
          invoiceDate: inv.orderDate,
          invoiceValue: inv.total,
          placeOfSupply,
          reverseCharge: "N",
          invoiceType: "Regular",
          buyerName: inv.customerName,
          buyerGstin: inv.customerGstin,
          taxableValue: round2(agg.taxable),
          igst: round2(agg.igst),
          cgst: round2(agg.cgst),
          sgst: round2(agg.sgst),
          rate,
        });
        continue;
      }

      // Unregistered (B2C). Inter-state + invoice > threshold ⇒ B2C-Large.
      if (!sameState && inv.total > B2C_LARGE_THRESHOLD) {
        b2cLarge.push({
          invoiceNumber: inv.orderNumber,
          invoiceDate: inv.orderDate,
          invoiceValue: inv.total,
          placeOfSupply,
          rate,
          taxableValue: round2(agg.taxable),
          igst: round2(agg.igst),
        });
        continue;
      }

      // B2C-Small: aggregate by (placeOfSupply, rate).
      const key = `${placeOfSupply ?? ""}::${rate}`;
      const prev = b2cSmallMap.get(key) ?? {
        placeOfSupply: placeOfSupply ?? "",
        rate,
        taxableValue: 0,
        igst: 0,
        cgst: 0,
        sgst: 0,
      };
      prev.taxableValue = round2(prev.taxableValue + agg.taxable);
      prev.igst = round2(prev.igst + agg.igst);
      prev.cgst = round2(prev.cgst + agg.cgst);
      prev.sgst = round2(prev.sgst + agg.sgst);
      b2cSmallMap.set(key, prev);
    }
  }

  return {
    period,
    orgGstin: org?.gstNumber ?? null,
    b2b: b2b.sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber)),
    b2cLarge: b2cLarge.sort((a, b) =>
      a.invoiceNumber.localeCompare(b.invoiceNumber),
    ),
    b2cSmall: Array.from(b2cSmallMap.values()).sort(
      (a, b) =>
        a.placeOfSupply.localeCompare(b.placeOfSupply) || a.rate - b.rate,
    ),
    creditNotes: creditNotes.sort((a, b) =>
      a.noteNumber.localeCompare(b.noteNumber),
    ),
    totals: {
      invoiceCount: totals.invoiceCount,
      taxableValue: round2(totals.taxableValue),
      igst: round2(totals.igst),
      cgst: round2(totals.cgst),
      sgst: round2(totals.sgst),
      invoiceValue: round2(totals.invoiceValue),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// GSTR-3B — summary return.
// ─────────────────────────────────────────────────────────────────────

export interface Gstr3bReport {
  period: ResolvedPeriod;
  orgGstin: string | null;
  // 3.1(a) Outward taxable supplies (other than zero-rated, nil-rated, exempt)
  outwardTaxable: {
    taxableValue: number;
    igst: number;
    cgst: number;
    sgst: number;
    cess: number;
  };
  // 3.1(c) Other outward supplies (Nil-rated, exempted)
  outwardNilExempt: {
    taxableValue: number;
  };
  // Eligible ITC (left empty for now — we don't track purchase-side
  // GST split yet, only line-level tax totals).
  itc: {
    igst: number;
    cgst: number;
    sgst: number;
    cess: number;
  };
  totals: {
    totalTaxableSupplies: number;
    totalTax: number;
  };
}

export async function computeGstr3b(
  orgId: number,
  period: ResolvedPeriod,
): Promise<Gstr3bReport> {
  const [org] = await db
    .select({ gstNumber: organizationsTable.gstNumber })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId))
    .limit(1);
  const orgStateCode = await loadOrgStateCode(orgId);
  const { invoices, lines } = await loadInvoices(orgId, period);
  const customerByOrder = new Map<number, InvoiceRow>();
  for (const i of invoices) customerByOrder.set(i.orderId, i);

  let taxable = 0;
  let igst = 0;
  let cgst = 0;
  let sgst = 0;
  let nilExempt = 0;

  for (const l of lines) {
    const inv = customerByOrder.get(l.orderId);
    if (!inv) continue;
    if (inv.status === "returned") {
      // Credit notes reduce outward supplies.
      const sameState =
        orgStateCode != null &&
        inv.customerStateCode != null &&
        orgStateCode === inv.customerStateCode;
      if (l.taxRate === 0) {
        nilExempt -= l.lineSubtotal;
      } else {
        taxable -= l.lineSubtotal;
        const split = splitTax(l.lineTax, sameState);
        igst -= split.igst;
        cgst -= split.cgst;
        sgst -= split.sgst;
      }
      continue;
    }
    if (l.taxRate === 0) {
      nilExempt += l.lineSubtotal;
      continue;
    }
    const sameState =
      orgStateCode != null &&
      inv.customerStateCode != null &&
      orgStateCode === inv.customerStateCode;
    const split = splitTax(l.lineTax, sameState);
    taxable += l.lineSubtotal;
    igst += split.igst;
    cgst += split.cgst;
    sgst += split.sgst;
  }

  return {
    period,
    orgGstin: org?.gstNumber ?? null,
    outwardTaxable: {
      taxableValue: round2(taxable),
      igst: round2(igst),
      cgst: round2(cgst),
      sgst: round2(sgst),
      cess: 0,
    },
    outwardNilExempt: { taxableValue: round2(nilExempt) },
    itc: { igst: 0, cgst: 0, sgst: 0, cess: 0 },
    totals: {
      totalTaxableSupplies: round2(taxable + nilExempt),
      totalTax: round2(igst + cgst + sgst),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// HSN summary — per HSN per rate.
// ─────────────────────────────────────────────────────────────────────

export interface HsnSummaryRow {
  hsnCode: string;
  description: string;
  unit: string;
  rate: number;
  totalQuantity: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  totalValue: number;
}

export interface HsnSummaryReport {
  period: ResolvedPeriod;
  orgGstin: string | null;
  rows: HsnSummaryRow[];
  totals: {
    taxableValue: number;
    igst: number;
    cgst: number;
    sgst: number;
    totalValue: number;
  };
}

export async function computeHsnSummary(
  orgId: number,
  period: ResolvedPeriod,
): Promise<HsnSummaryReport> {
  const [org] = await db
    .select({ gstNumber: organizationsTable.gstNumber })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId))
    .limit(1);
  const orgStateCode = await loadOrgStateCode(orgId);
  const { invoices, lines } = await loadInvoices(orgId, period);
  const invByOrder = new Map<number, InvoiceRow>();
  for (const i of invoices) invByOrder.set(i.orderId, i);

  const rows = new Map<string, HsnSummaryRow>();
  for (const l of lines) {
    const inv = invByOrder.get(l.orderId);
    if (!inv) continue;
    const sign = inv.status === "returned" ? -1 : 1;
    const sameState =
      orgStateCode != null &&
      inv.customerStateCode != null &&
      orgStateCode === inv.customerStateCode;
    const split = splitTax(l.lineTax, sameState);
    const hsn = (l.hsnCode ?? "").trim() || "0";
    const key = `${hsn}::${l.taxRate}::${l.unit}`;
    const cur = rows.get(key) ?? {
      hsnCode: hsn,
      description: l.itemName,
      unit: l.unit.toUpperCase(),
      rate: l.taxRate,
      totalQuantity: 0,
      taxableValue: 0,
      igst: 0,
      cgst: 0,
      sgst: 0,
      cess: 0,
      totalValue: 0,
    };
    cur.totalQuantity += sign * l.quantity;
    cur.taxableValue += sign * l.lineSubtotal;
    cur.igst += sign * split.igst;
    cur.cgst += sign * split.cgst;
    cur.sgst += sign * split.sgst;
    cur.totalValue +=
      sign * (l.lineSubtotal + split.igst + split.cgst + split.sgst);
    rows.set(key, cur);
  }

  const sorted = Array.from(rows.values())
    .map((r) => ({
      ...r,
      totalQuantity: round2(r.totalQuantity),
      taxableValue: round2(r.taxableValue),
      igst: round2(r.igst),
      cgst: round2(r.cgst),
      sgst: round2(r.sgst),
      totalValue: round2(r.totalValue),
    }))
    .sort((a, b) => a.hsnCode.localeCompare(b.hsnCode) || a.rate - b.rate);

  const totals = sorted.reduce(
    (acc, r) => {
      acc.taxableValue += r.taxableValue;
      acc.igst += r.igst;
      acc.cgst += r.cgst;
      acc.sgst += r.sgst;
      acc.totalValue += r.totalValue;
      return acc;
    },
    { taxableValue: 0, igst: 0, cgst: 0, sgst: 0, totalValue: 0 },
  );

  return {
    period,
    orgGstin: org?.gstNumber ?? null,
    rows: sorted,
    totals: {
      taxableValue: round2(totals.taxableValue),
      igst: round2(totals.igst),
      cgst: round2(totals.cgst),
      sgst: round2(totals.sgst),
      totalValue: round2(totals.totalValue),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// CSV serializers. We emit the canonical column shapes that match the
// GSTN offline-tool templates as closely as possible, so a CA can
// paste rows into the official spreadsheet without re-keying.
// ─────────────────────────────────────────────────────────────────────

function csvEscape(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/gu, '""')}"`;
  return s;
}

function csvRow(values: Array<string | number | null | undefined>): string {
  return values.map(csvEscape).join(",");
}

export function gstr1ToCsv(report: Gstr1Report): string {
  const lines: string[] = [];
  lines.push("Section,Period,Org GSTIN");
  lines.push(
    csvRow(["Header", report.period.period, report.orgGstin]),
  );
  lines.push("");
  lines.push("# B2B");
  lines.push(
    "GSTIN/UIN of Recipient,Receiver Name,Invoice Number,Invoice Date,Invoice Value,Place Of Supply,Reverse Charge,Invoice Type,Rate,Taxable Value,Integrated Tax,Central Tax,State/UT Tax",
  );
  for (const r of report.b2b) {
    lines.push(
      csvRow([
        r.buyerGstin,
        r.buyerName,
        r.invoiceNumber,
        r.invoiceDate,
        r.invoiceValue,
        r.placeOfSupply,
        r.reverseCharge,
        r.invoiceType,
        r.rate,
        r.taxableValue,
        r.igst,
        r.cgst,
        r.sgst,
      ]),
    );
  }
  lines.push("");
  lines.push("# B2CL (Inter-state, > Rs 2.5L)");
  lines.push(
    "Invoice Number,Invoice Date,Invoice Value,Place Of Supply,Rate,Taxable Value,Integrated Tax",
  );
  for (const r of report.b2cLarge) {
    lines.push(
      csvRow([
        r.invoiceNumber,
        r.invoiceDate,
        r.invoiceValue,
        r.placeOfSupply,
        r.rate,
        r.taxableValue,
        r.igst,
      ]),
    );
  }
  lines.push("");
  lines.push("# B2CS");
  lines.push(
    "Type,Place Of Supply,Rate,Taxable Value,Integrated Tax,Central Tax,State/UT Tax",
  );
  for (const r of report.b2cSmall) {
    lines.push(
      csvRow([
        "OE",
        r.placeOfSupply,
        r.rate,
        r.taxableValue,
        r.igst,
        r.cgst,
        r.sgst,
      ]),
    );
  }
  lines.push("");
  lines.push("# Credit Notes");
  lines.push(
    "Note Number,Note Date,Receiver GSTIN,Receiver Name,Note Value,Rate,Taxable Value,Integrated Tax,Central Tax,State/UT Tax",
  );
  for (const r of report.creditNotes) {
    lines.push(
      csvRow([
        r.noteNumber,
        r.noteDate,
        r.buyerGstin,
        r.buyerName,
        r.noteValue,
        r.rate,
        r.taxableValue,
        r.igst,
        r.cgst,
        r.sgst,
      ]),
    );
  }
  return lines.join("\n");
}

export function gstr3bToCsv(report: Gstr3bReport): string {
  const lines: string[] = [];
  lines.push("Period,Org GSTIN");
  lines.push(csvRow([report.period.period, report.orgGstin]));
  lines.push("");
  lines.push("Section,Description,Taxable Value,IGST,CGST,SGST,Cess");
  lines.push(
    csvRow([
      "3.1(a)",
      "Outward taxable supplies",
      report.outwardTaxable.taxableValue,
      report.outwardTaxable.igst,
      report.outwardTaxable.cgst,
      report.outwardTaxable.sgst,
      report.outwardTaxable.cess,
    ]),
  );
  lines.push(
    csvRow([
      "3.1(c)",
      "Other outward supplies (Nil-rated / exempted)",
      report.outwardNilExempt.taxableValue,
      0,
      0,
      0,
      0,
    ]),
  );
  lines.push(
    csvRow([
      "4(A)",
      "ITC available",
      "",
      report.itc.igst,
      report.itc.cgst,
      report.itc.sgst,
      report.itc.cess,
    ]),
  );
  return lines.join("\n");
}

export function hsnSummaryToCsv(report: HsnSummaryReport): string {
  const lines: string[] = [];
  lines.push("Period,Org GSTIN");
  lines.push(csvRow([report.period.period, report.orgGstin]));
  lines.push("");
  lines.push(
    "HSN,Description,UQC,Total Quantity,Rate,Taxable Value,Integrated Tax,Central Tax,State/UT Tax,Cess,Total Value",
  );
  for (const r of report.rows) {
    lines.push(
      csvRow([
        r.hsnCode,
        r.description,
        r.unit,
        r.totalQuantity,
        r.rate,
        r.taxableValue,
        r.igst,
        r.cgst,
        r.sgst,
        r.cess,
        r.totalValue,
      ]),
    );
  }
  lines.push("");
  lines.push(
    csvRow([
      "TOTAL",
      "",
      "",
      "",
      "",
      report.totals.taxableValue,
      report.totals.igst,
      report.totals.cgst,
      report.totals.sgst,
      0,
      report.totals.totalValue,
    ]),
  );
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────
// GSTN-prescribed JSON (offline-tool format). Keys follow the GSTR-1
// JSON schema published by GSTN: https://tutorial.gst.gov.in/.
// ─────────────────────────────────────────────────────────────────────

export function gstr1ToGstnJson(report: Gstr1Report): unknown {
  // Group B2B invoices by buyer GSTIN per the offline-tool schema.
  const b2bByCtin = new Map<
    string,
    Array<{
      inum: string;
      idt: string;
      val: number;
      pos: string;
      rchrg: string;
      inv_typ: string;
      itms: Array<{
        num: number;
        itm_det: {
          rt: number;
          txval: number;
          iamt: number;
          camt: number;
          samt: number;
          csamt: number;
        };
      }>;
    }>
  >();
  // Group rows of the same invoice together so multi-rate invoices
  // emit a single inv element with multiple itms entries.
  const b2bGrouped = new Map<
    string,
    {
      ctin: string;
      inv: Map<string, {
        inum: string;
        idt: string;
        val: number;
        pos: string;
        rchrg: string;
        inv_typ: string;
        itms: Gstr1B2bInvoice[];
      }>;
    }
  >();
  for (const r of report.b2b) {
    const cur =
      b2bGrouped.get(r.buyerGstin) ??
      ({ ctin: r.buyerGstin, inv: new Map() } as const);
    const existing = cur.inv.get(r.invoiceNumber) ?? {
      inum: r.invoiceNumber,
      idt: gstnDate(r.invoiceDate),
      val: r.invoiceValue,
      pos: posCode(r.placeOfSupply),
      rchrg: r.reverseCharge,
      inv_typ: "R",
      itms: [],
    };
    existing.itms.push(r);
    cur.inv.set(r.invoiceNumber, existing);
    b2bGrouped.set(r.buyerGstin, cur);
  }
  for (const [ctin, group] of b2bGrouped) {
    const arr = b2bByCtin.get(ctin) ?? [];
    for (const inv of group.inv.values()) {
      arr.push({
        inum: inv.inum,
        idt: inv.idt,
        val: inv.val,
        pos: inv.pos,
        rchrg: inv.rchrg,
        inv_typ: inv.inv_typ,
        itms: inv.itms.map((row, i) => ({
          num: i + 1,
          itm_det: {
            rt: row.rate,
            txval: row.taxableValue,
            iamt: row.igst,
            camt: row.cgst,
            samt: row.sgst,
            csamt: 0,
          },
        })),
      });
    }
    b2bByCtin.set(ctin, arr);
  }

  return {
    gstin: report.orgGstin,
    fp: gstnFilingPeriod(report.period),
    gt: report.totals.invoiceValue,
    cur_gt: report.totals.invoiceValue,
    b2b: Array.from(b2bByCtin.entries()).map(([ctin, inv]) => ({
      ctin,
      inv,
    })),
    b2cl: groupB2cLargeForJson(report.b2cLarge),
    b2cs: report.b2cSmall.map((r) => ({
      sply_ty: posCode(r.placeOfSupply).startsWith(
        report.orgGstin?.slice(0, 2) ?? "",
      )
        ? "INTRA"
        : "INTER",
      pos: posCode(r.placeOfSupply),
      typ: "OE",
      rt: r.rate,
      txval: r.taxableValue,
      iamt: r.igst,
      camt: r.cgst,
      samt: r.sgst,
      csamt: 0,
    })),
    cdnr: groupCdnrForJson(report.creditNotes.filter((n) => n.buyerGstin)),
    // CDNUR per the GSTN GSTR-1 schema is only for unregistered B2CL
    // (inter-state, aggregate note value > 2.5L) returns and exports.
    // Multi-rate notes collapse to a single nt entry with multiple
    // itms; smaller B2CS returns are netted into b2cs and must NOT
    // appear here.
    cdnur: groupCdnurForJson(
      report.creditNotes.filter((n) => !n.buyerGstin && n.interState),
    ),
  };
}

function groupCdnurForJson(rows: Gstr1CreditNote[]): Array<{
  ntty: string;
  nt_num: string;
  nt_dt: string;
  val: number;
  typ: string;
  itms: Array<{
    num: number;
    itm_det: {
      rt: number;
      txval: number;
      iamt: number;
      camt: number;
      samt: number;
      csamt: number;
    };
  }>;
}> {
  const byNote = new Map<string, Gstr1CreditNote[]>();
  for (const n of rows) {
    const arr = byNote.get(n.noteNumber) ?? [];
    arr.push(n);
    byNote.set(n.noteNumber, arr);
  }
  const out: Array<ReturnType<typeof buildOne>> = [];
  function buildOne(nt_num: string, items: Gstr1CreditNote[]) {
    const aggregate = round2(items.reduce((s, it) => s + it.noteValue, 0));
    return {
      ntty: "C",
      nt_num,
      nt_dt: gstnDate(items[0]!.noteDate),
      val: aggregate,
      typ: "B2CL",
      itms: items.map((it, i) => ({
        num: i + 1,
        itm_det: {
          rt: it.rate,
          txval: it.taxableValue,
          iamt: it.igst,
          camt: it.cgst,
          samt: it.sgst,
          csamt: 0,
        },
      })),
    };
  }
  for (const [nt_num, items] of byNote.entries()) {
    const aggregate = items.reduce((s, it) => s + it.noteValue, 0);
    if (aggregate > B2C_LARGE_THRESHOLD) {
      out.push(buildOne(nt_num, items));
    }
  }
  return out;
}

// Credit notes for registered buyers go under cdnr, grouped by buyer
// GSTIN. Multi-rate notes collapse into one nt entry with multiple
// itms, mirroring the b2b grouping above.
function groupCdnrForJson(rows: Gstr1CreditNote[]): Array<{
  ctin: string;
  nt: Array<{
    ntty: string;
    nt_num: string;
    nt_dt: string;
    rsn: string;
    p_gst: string;
    val: number;
    itms: Array<{
      num: number;
      itm_det: {
        rt: number;
        txval: number;
        iamt: number;
        camt: number;
        samt: number;
        csamt: number;
      };
    }>;
  }>;
}> {
  const byCtin = new Map<string, Map<string, Gstr1CreditNote[]>>();
  for (const n of rows) {
    if (!n.buyerGstin) continue;
    const inner = byCtin.get(n.buyerGstin) ?? new Map<string, Gstr1CreditNote[]>();
    const arr = inner.get(n.noteNumber) ?? [];
    arr.push(n);
    inner.set(n.noteNumber, arr);
    byCtin.set(n.buyerGstin, inner);
  }
  return Array.from(byCtin.entries()).map(([ctin, inner]) => ({
    ctin,
    nt: Array.from(inner.entries()).map(([nt_num, items]) => ({
      ntty: "C",
      nt_num,
      nt_dt: gstnDate(items[0]!.noteDate),
      rsn: "01",
      p_gst: "N",
      val: round2(items.reduce((s, it) => s + it.noteValue, 0)),
      itms: items.map((it, i) => ({
        num: i + 1,
        itm_det: {
          rt: it.rate,
          txval: it.taxableValue,
          iamt: it.igst,
          camt: it.cgst,
          samt: it.sgst,
          csamt: 0,
        },
      })),
    })),
  }));
}

function groupB2cLargeForJson(
  rows: Gstr1B2cLargeInvoice[],
): Array<{
  pos: string;
  inv: Array<{
    inum: string;
    idt: string;
    val: number;
    itms: Array<{
      num: number;
      itm_det: { rt: number; txval: number; iamt: number; csamt: number };
    }>;
  }>;
}> {
  const byPos = new Map<string, Map<string, Gstr1B2cLargeInvoice[]>>();
  for (const r of rows) {
    const pos = posCode(r.placeOfSupply);
    const inner = byPos.get(pos) ?? new Map<string, Gstr1B2cLargeInvoice[]>();
    const arr = inner.get(r.invoiceNumber) ?? [];
    arr.push(r);
    inner.set(r.invoiceNumber, arr);
    byPos.set(pos, inner);
  }
  return Array.from(byPos.entries()).map(([pos, inner]) => ({
    pos,
    inv: Array.from(inner.entries()).map(([inum, items]) => ({
      inum,
      idt: gstnDate(items[0]!.invoiceDate),
      val: items[0]!.invoiceValue,
      itms: items.map((it, i) => ({
        num: i + 1,
        itm_det: { rt: it.rate, txval: it.taxableValue, iamt: it.igst, csamt: 0 },
      })),
    })),
  }));
}

function gstnDate(iso: string): string {
  // GSTN expects DD-MM-YYYY in JSON.
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

function posCode(label: string | null): string {
  if (!label) return "";
  const m = label.match(/^(\d{2})/u);
  if (m) return m[1]!;
  const code = gstStateCodeFromName(label);
  return code != null ? String(code).padStart(2, "0") : "";
}

export function gstr3bToGstnJson(report: Gstr3bReport): unknown {
  return {
    gstin: report.orgGstin,
    ret_period: gstnFilingPeriod(report.period),
    sup_details: {
      osup_det: {
        txval: report.outwardTaxable.taxableValue,
        iamt: report.outwardTaxable.igst,
        camt: report.outwardTaxable.cgst,
        samt: report.outwardTaxable.sgst,
        csamt: report.outwardTaxable.cess,
      },
      osup_nil_exmp: { txval: report.outwardNilExempt.taxableValue },
      osup_zero: { txval: 0, iamt: 0, csamt: 0 },
      osup_nongst: { txval: 0 },
      isup_rev: { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 },
    },
    itc_elg: {
      itc_avl: [
        {
          ty: "OTH",
          iamt: report.itc.igst,
          camt: report.itc.cgst,
          samt: report.itc.sgst,
          csamt: report.itc.cess,
        },
      ],
    },
  };
}

export function hsnSummaryToGstnJson(report: HsnSummaryReport): unknown {
  return {
    gstin: report.orgGstin,
    fp: gstnFilingPeriod(report.period),
    hsn: {
      data: report.rows.map((r, i) => ({
        num: i + 1,
        hsn_sc: r.hsnCode,
        desc: r.description,
        uqc: r.unit,
        qty: r.totalQuantity,
        rt: r.rate,
        txval: r.taxableValue,
        iamt: r.igst,
        camt: r.cgst,
        samt: r.sgst,
        csamt: r.cess,
        val: r.totalValue,
      })),
    },
  };
}
