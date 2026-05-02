import QRCode from "qrcode";
import { toNum } from "./numeric";
import { rupeesInWords } from "./numberToWords";
import {
  COLORS,
  FONTS,
  PAGE,
  createPdfDoc,
  drawHeaderBand,
  drawNotesBlock,
  drawPartyBoxes,
  drawSectionTitle,
  drawSignatureBlock,
  drawStatusStamp,
  drawTableHeader,
  drawTextRow,
  drawTotalsLine,
  ensureRoom,
  fmtDate,
  fmtMoney,
  fmtQty,
  paginate,
  type Column,
  type DocOrg,
  type DocParty,
} from "./pdfDesign";

export interface InvoicePdfOrg extends DocOrg {}

export interface InvoicePdfCustomer {
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  gstNumber: string | null;
  billingAddress: string | null;
  shippingAddress: string | null;
  placeOfSupply: string | null;
}

export interface InvoicePdfLine {
  itemName: string;
  sku: string;
  description: string | null;
  hsnCode: string | null;
  quantity: number | string;
  unitPrice: number | string;
  taxRate: number | string;
  lineSubtotal: number | string;
  lineTax: number | string;
  lineTotal: number | string;
}

export interface InvoicePdfOrder {
  orderNumber: string;
  orderDate: string;
  expectedShipDate?: string | null;
  notes?: string | null;
  subtotal: number | string;
  taxTotal: number | string;
  total: number | string;
  amountPaid: number | string;
  balanceDue: number | string;
}

export interface InvoicePdfEwb {
  number: string;
  date: string | Date | null;
  validUntil: string | Date | null;
  vehicleNumber: string | null;
  transportMode: string | null;
  qrPayload: string | null;
  status: string;
}

// IRP-issued e-invoice details. The signed-QR payload, when present,
// is the opaque base64 string returned by the IRP and must be rendered
// verbatim into a QR — the QR is the legally binding part of the
// printed invoice under the e-invoice mandate.
export interface InvoicePdfEinvoice {
  irn: string;
  ackNumber: string | null;
  ackDate: string | Date | null;
  qrPayload: string;
  status: string | null;
}

export interface RenderInvoiceInput {
  org: InvoicePdfOrg;
  customer: InvoicePdfCustomer;
  order: InvoicePdfOrder;
  lines: InvoicePdfLine[];
  logoBuffer?: Buffer | null;
  ewb?: InvoicePdfEwb | null;
  einvoice?: InvoicePdfEinvoice | null;
}

interface ComputedLine {
  src: InvoicePdfLine;
  hsn: string;
  qty: number;
  rate: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
}

function normalizeState(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

function isIntraState(
  org: InvoicePdfOrg,
  customer: InvoicePdfCustomer,
): boolean {
  const orgState = normalizeState(org.state);
  const placeOfSupply = normalizeState(customer.placeOfSupply);
  if (!placeOfSupply || !orgState) return true;
  return placeOfSupply === orgState;
}

function computeLines(
  rawLines: InvoicePdfLine[],
  intra: boolean,
): ComputedLine[] {
  return rawLines.map((l) => {
    const qty = toNum(l.quantity);
    const rate = toNum(l.unitPrice);
    const taxableValue = toNum(l.lineSubtotal);
    const tax = toNum(l.lineTax);
    const total = toNum(l.lineTotal);
    const cgst = intra ? tax / 2 : 0;
    const sgst = intra ? tax / 2 : 0;
    const igst = intra ? 0 : tax;
    return {
      src: l,
      hsn: (l.hsnCode ?? "").trim(),
      qty,
      rate,
      taxableValue,
      cgst,
      sgst,
      igst,
      total,
    };
  });
}

interface HsnSummaryRow {
  hsn: string;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
}

function summarizeByHsn(lines: ComputedLine[]): HsnSummaryRow[] {
  const map = new Map<string, HsnSummaryRow>();
  for (const l of lines) {
    const key = l.hsn || "(unspecified)";
    const row =
      map.get(key) ??
      ({
        hsn: key,
        taxableValue: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
      } satisfies HsnSummaryRow);
    row.taxableValue += l.taxableValue;
    row.cgst += l.cgst;
    row.sgst += l.sgst;
    row.igst += l.igst;
    map.set(key, row);
  }
  return Array.from(map.values()).sort((a, b) => a.hsn.localeCompare(b.hsn));
}

function makeColumns(intra: boolean): Column[] {
  if (intra) {
    return [
      { label: "#", width: 22, align: "right" },
      { label: "Item", width: 168 },
      { label: "HSN", width: 50 },
      { label: "Qty", width: 36, align: "right" },
      { label: "Rate", width: 52, align: "right" },
      { label: "Taxable", width: 60, align: "right" },
      { label: "CGST", width: 52, align: "right" },
      { label: "SGST", width: 52, align: "right" },
      { label: "Total", width: 60, align: "right" },
    ];
  }
  return [
    { label: "#", width: 22, align: "right" },
    { label: "Item", width: 188 },
    { label: "HSN", width: 55 },
    { label: "Qty", width: 40, align: "right" },
    { label: "Rate", width: 56, align: "right" },
    { label: "Taxable", width: 64, align: "right" },
    { label: "IGST", width: 60, align: "right" },
    { label: "Total", width: 67, align: "right" },
  ];
}

function customerToParty(c: InvoicePdfCustomer, useShipping = false): DocParty {
  const addr = useShipping
    ? c.shippingAddress ?? c.billingAddress
    : c.billingAddress;
  const extras: string[] = [];
  if (useShipping && c.placeOfSupply) {
    extras.push(`Place of supply: ${c.placeOfSupply}`);
  }
  return {
    name: c.name,
    company: c.company,
    email: useShipping ? null : c.email,
    phone: useShipping ? null : c.phone,
    gstNumber: useShipping ? null : c.gstNumber,
    addressLines: addr ? addr.split("\n") : [],
    extraLines: extras,
  };
}

export async function renderInvoicePdf(
  input: RenderInvoiceInput,
): Promise<Buffer> {
  const { org, customer, order, lines, logoBuffer, einvoice } = input;
  const intra = isIntraState(org, customer);
  const computed = computeLines(lines, intra);
  const summary = summarizeByHsn(computed);

  const { doc, done, pageLeft, pageRight, pageWidth } = createPdfDoc({
    title: `Invoice ${order.orderNumber}`,
    author: org.name,
    subject: `Tax invoice for ${customer.name}`,
  });

  // ---- Header band ------------------------------------------------------
  const metaPairs: Array<[string, string]> = [
    ["Invoice #", order.orderNumber],
    ["Date", fmtDate(order.orderDate)],
  ];
  if (order.expectedShipDate) {
    metaPairs.push(["Due / ship by", fmtDate(order.expectedShipDate)]);
  }
  if (customer.placeOfSupply) {
    metaPairs.push(["Place of supply", customer.placeOfSupply]);
  }
  metaPairs.push([
    "Tax type",
    intra ? "Intra-state (CGST+SGST)" : "Inter-state (IGST)",
  ]);

  let y = drawHeaderBand({
    doc,
    org,
    logoBuffer: logoBuffer ?? null,
    documentTitle: "TAX INVOICE",
    documentSubtitle: "Original for recipient",
    metaPairs,
    pageLeft,
    pageRight,
  });

  // ---- Bill-to / Ship-to ------------------------------------------------
  y = drawPartyBoxes({
    doc,
    y,
    pageLeft,
    pageWidth,
    left: { label: "Bill to", party: customerToParty(customer, false) },
    right: { label: "Ship to", party: customerToParty(customer, true) },
  });

  // ---- Line table -------------------------------------------------------
  const cols = makeColumns(intra);
  const tableTotalWidth = cols.reduce((s, c) => s + c.width, 0);
  const tableStartX =
    pageLeft + Math.max(0, Math.floor((pageWidth - tableTotalWidth) / 2));
  y = drawTableHeader(doc, cols, tableStartX, y);

  for (let i = 0; i < computed.length; i++) {
    const c = computed[i]!;
    const subtext = [c.src.sku, c.src.description]
      .map((s) => (s ?? "").trim())
      .filter(Boolean)
      .join(" — ");
    const halfRate = (toNum(c.src.taxRate) / 2).toFixed(1);
    const fullRate = toNum(c.src.taxRate).toFixed(1);
    const values = intra
      ? [
          String(i + 1),
          c.src.itemName,
          c.hsn || "—",
          fmtQty(c.qty),
          fmtMoney(c.rate),
          fmtMoney(c.taxableValue),
          `${fmtMoney(c.cgst)}\n@${halfRate}%`,
          `${fmtMoney(c.sgst)}\n@${halfRate}%`,
          fmtMoney(c.total),
        ]
      : [
          String(i + 1),
          c.src.itemName,
          c.hsn || "—",
          fmtQty(c.qty),
          fmtMoney(c.rate),
          fmtMoney(c.taxableValue),
          `${fmtMoney(c.igst)}\n@${fullRate}%`,
          fmtMoney(c.total),
        ];
    y = ensureRoom(doc, 32, tableStartX, cols, y);
    y = drawTextRow({
      doc,
      cols,
      values,
      startX: tableStartX,
      y,
      subtext: subtext ? { colIdx: 1, text: subtext } : undefined,
      shaded: i % 2 === 1,
    });
  }

  // ---- Totals -----------------------------------------------------------
  const subtotal = toNum(order.subtotal);
  const taxTotal = toNum(order.taxTotal);
  const total = toNum(order.total);
  const amountPaid = toNum(order.amountPaid);
  const balance = toNum(order.balanceDue);

  const total_ = (
    label: string,
    value: string,
    opts?: { emphasized?: boolean; muted?: boolean },
  ) => {
    y = ensureRoom(doc, 24, tableStartX, cols, y);
    y = drawTotalsLine({
      doc,
      cols,
      startX: tableStartX,
      y,
      label,
      value,
      emphasized: opts?.emphasized,
      muted: opts?.muted,
    });
  };

  total_("Subtotal", fmtMoney(subtotal));
  if (intra) {
    total_("CGST", fmtMoney(computed.reduce((s, l) => s + l.cgst, 0)));
    total_("SGST", fmtMoney(computed.reduce((s, l) => s + l.sgst, 0)));
  } else {
    total_("IGST", fmtMoney(computed.reduce((s, l) => s + l.igst, 0)));
  }
  if (Math.abs(taxTotal) > 0.005) total_("Total tax", fmtMoney(taxTotal));
  total_("Grand total (INR)", fmtMoney(total), { emphasized: true });
  if (amountPaid > 0.005) {
    total_("Amount paid", fmtMoney(amountPaid), { muted: true });
  }
  if (Math.abs(balance) > 0.005) {
    total_("Balance due", fmtMoney(balance), { emphasized: true });
  }

  // ---- Amount in words --------------------------------------------------
  y += 10;
  if (y > doc.page.height - PAGE.margin - 60) {
    doc.addPage();
    y = PAGE.margin;
  }
  doc
    .font(FONTS.bold)
    .fontSize(8.5)
    .fillColor(COLORS.textMuted)
    .text("AMOUNT IN WORDS", pageLeft, y, {
      width: pageWidth,
      characterSpacing: 0.5,
    });
  doc
    .font(FONTS.italic)
    .fontSize(10)
    .fillColor(COLORS.textPrimary)
    .text(rupeesInWords(total), pageLeft, doc.y + 1, { width: pageWidth });
  y = doc.y + 12;

  // ---- HSN summary ------------------------------------------------------
  if (summary.length > 0) {
    if (y > doc.page.height - PAGE.margin - 120) {
      doc.addPage();
      y = PAGE.margin;
    }
    y = drawSectionTitle(doc, "HSN-wise summary", pageLeft, pageWidth, y);
    const hsnCols: Column[] = intra
      ? [
          { label: "HSN", width: 100 },
          { label: "Taxable value", width: 110, align: "right" },
          { label: "CGST", width: 100, align: "right" },
          { label: "SGST", width: 100, align: "right" },
          { label: "Total tax", width: 113, align: "right" },
        ]
      : [
          { label: "HSN", width: 130 },
          { label: "Taxable value", width: 130, align: "right" },
          { label: "IGST", width: 130, align: "right" },
          { label: "Total tax", width: 133, align: "right" },
        ];
    y = drawTableHeader(doc, hsnCols, pageLeft, y);
    let totalTaxable = 0;
    let totalCgst = 0;
    let totalSgst = 0;
    let totalIgst = 0;
    for (let i = 0; i < summary.length; i++) {
      const row = summary[i]!;
      const values = intra
        ? [
            row.hsn,
            fmtMoney(row.taxableValue),
            fmtMoney(row.cgst),
            fmtMoney(row.sgst),
            fmtMoney(row.cgst + row.sgst),
          ]
        : [
            row.hsn,
            fmtMoney(row.taxableValue),
            fmtMoney(row.igst),
            fmtMoney(row.igst),
          ];
      y = ensureRoom(doc, 22, pageLeft, hsnCols, y);
      y = drawTextRow({
        doc,
        cols: hsnCols,
        values,
        startX: pageLeft,
        y,
        shaded: i % 2 === 1,
      });
      totalTaxable += row.taxableValue;
      totalCgst += row.cgst;
      totalSgst += row.sgst;
      totalIgst += row.igst;
    }
    // Footer total row spanning the whole table
    y = ensureRoom(doc, 24, pageLeft, hsnCols, y);
    const rowH = 22;
    const totW = hsnCols.reduce((s, c) => s + c.width, 0);
    doc
      .save()
      .rect(pageLeft, y, totW, rowH)
      .fill(COLORS.fillTotal)
      .restore();
    let tx = pageLeft;
    doc.font(FONTS.bold).fontSize(9).fillColor(COLORS.textPrimary);
    const totalsRow = intra
      ? [
          "Total",
          fmtMoney(totalTaxable),
          fmtMoney(totalCgst),
          fmtMoney(totalSgst),
          fmtMoney(totalCgst + totalSgst),
        ]
      : [
          "Total",
          fmtMoney(totalTaxable),
          fmtMoney(totalIgst),
          fmtMoney(totalIgst),
        ];
    for (let i = 0; i < hsnCols.length; i++) {
      const col = hsnCols[i]!;
      doc.text(totalsRow[i]!, tx + 5, y + 7, {
        width: col.width - 10,
        align: col.align ?? "left",
        lineBreak: false,
      });
      tx += col.width;
    }
    y += rowH + 8;
  }

  // ---- Notes / footer ---------------------------------------------------
  if (order.notes) {
    if (y > doc.page.height - PAGE.margin - 80) {
      doc.addPage();
      y = PAGE.margin;
    }
    y = drawNotesBlock(doc, "Notes", order.notes, pageLeft, pageWidth, y);
  }
  if (org.invoiceFooter) {
    y = drawNotesBlock(
      doc,
      "Terms & conditions",
      org.invoiceFooter,
      pageLeft,
      pageWidth,
      y,
    );
  }

  // ---- QR / e-invoice / EWB block + signature ---------------------------
  // Reserve space at the bottom for the QR + signature so they sit on
  // the same horizontal band. If room is tight, push to a new page.
  const sigBlockHeight = 100;
  if (y > doc.page.height - PAGE.margin - sigBlockHeight - 24) {
    doc.addPage();
    y = PAGE.margin;
  }
  const sigBoxY = y + 6;
  const qrSize = 78;
  const ewb = input.ewb && input.ewb.status === "active" ? input.ewb : null;

  if (einvoice && einvoice.qrPayload) {
    try {
      const qrPng = await QRCode.toBuffer(einvoice.qrPayload, {
        type: "png",
        errorCorrectionLevel: "M",
        margin: 0,
        width: 240,
      });
      doc.image(qrPng, pageLeft, sigBoxY, { width: qrSize, height: qrSize });
    } catch {
      doc
        .strokeColor(COLORS.border)
        .lineWidth(0.5)
        .rect(pageLeft, sigBoxY, qrSize, qrSize)
        .stroke();
    }
    const labelX = pageLeft + qrSize + 8;
    const ackDate =
      typeof einvoice.ackDate === "string"
        ? new Date(einvoice.ackDate)
        : einvoice.ackDate;
    doc
      .font(FONTS.bold)
      .fontSize(8)
      .fillColor(COLORS.textPrimary)
      .text("e-Invoice (IRP)", labelX, sigBoxY, { width: 220 });
    doc
      .font(FONTS.regular)
      .fontSize(7)
      .fillColor(COLORS.textMuted)
      .text(`IRN: ${einvoice.irn}`, labelX, sigBoxY + 12, { width: 220 });
    let lineY = sigBoxY + 30;
    if (einvoice.ackNumber) {
      doc.text(`Ack #: ${einvoice.ackNumber}`, labelX, lineY, { width: 220 });
      lineY += 11;
    }
    if (ackDate) {
      doc.text(`Ack date: ${fmtDate(ackDate)}`, labelX, lineY, { width: 220 });
      lineY += 11;
    }
    if (einvoice.status === "cancelled") {
      doc
        .fillColor(COLORS.danger)
        .font(FONTS.bold)
        .text("CANCELLED", labelX, lineY, { width: 220 });
      lineY += 11;
    }
    if (ewb) {
      doc
        .font(FONTS.bold)
        .fontSize(7)
        .fillColor(COLORS.textPrimary)
        .text(`EWB ${ewb.number}`, labelX, lineY + 2, { width: 220 });
      const ewbDate = ewb.date ? new Date(ewb.date) : null;
      const ewbValid = ewb.validUntil ? new Date(ewb.validUntil) : null;
      doc
        .font(FONTS.regular)
        .fontSize(7)
        .fillColor(COLORS.textMuted)
        .text(
          `${fmtDate(ewbDate)} · valid ${fmtDate(ewbValid)} · ${ewb.vehicleNumber ?? "—"}`,
          labelX,
          lineY + 13,
          { width: 220 },
        );
    }
  } else if (ewb && ewb.qrPayload) {
    try {
      const qrPng = await QRCode.toBuffer(ewb.qrPayload, {
        type: "png",
        errorCorrectionLevel: "M",
        margin: 0,
        width: qrSize * 2,
      });
      doc.image(qrPng, pageLeft, sigBoxY, { width: qrSize, height: qrSize });
    } catch {
      doc
        .strokeColor(COLORS.border)
        .lineWidth(0.5)
        .rect(pageLeft, sigBoxY, qrSize, qrSize)
        .stroke();
    }
    const ewbDate = ewb.date ? new Date(ewb.date) : null;
    const ewbValid = ewb.validUntil ? new Date(ewb.validUntil) : null;
    const labelX = pageLeft + qrSize + 8;
    doc
      .font(FONTS.bold)
      .fontSize(9)
      .fillColor(COLORS.textPrimary)
      .text("E-way bill", labelX, sigBoxY, { width: 220 });
    doc
      .font(FONTS.regular)
      .fontSize(7.5)
      .fillColor(COLORS.textMuted)
      .text(`No.: ${ewb.number}`, labelX, sigBoxY + 13, { width: 220 })
      .text(`Date: ${fmtDate(ewbDate)}`, labelX, sigBoxY + 25, { width: 220 })
      .text(`Valid until: ${fmtDate(ewbValid)}`, labelX, sigBoxY + 37, {
        width: 220,
      })
      .text(`Vehicle: ${ewb.vehicleNumber ?? "—"}`, labelX, sigBoxY + 49, {
        width: 220,
      });
  } else {
    doc
      .strokeColor(COLORS.border)
      .lineWidth(0.5)
      .dash(2, { space: 2 })
      .rect(pageLeft, sigBoxY, qrSize, qrSize)
      .stroke();
    doc.undash();
    doc
      .font(FONTS.regular)
      .fontSize(7)
      .fillColor(COLORS.textMuted)
      .text(
        "QR will appear after\ne-invoice (IRN)\nregistration.",
        pageLeft + 4,
        sigBoxY + 22,
        {
          width: qrSize - 8,
          align: "center",
        },
      );
  }

  drawSignatureBlock(doc, org.name, pageRight, sigBoxY);

  // ---- Status stamp + footer (post-content) -----------------------------
  if (order.balanceDue !== undefined) {
    const balanceNum = toNum(order.balanceDue);
    const totalNum = toNum(order.total);
    if (totalNum > 0.005 && Math.abs(balanceNum) <= 0.005 && amountPaid > 0.005) {
      drawStatusStamp(doc, "PAID");
    }
  }
  paginate(doc, org, `Tax Invoice ${order.orderNumber}`);

  doc.end();
  return done;
}
