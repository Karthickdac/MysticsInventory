import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { toNum } from "./numeric";
import { rupeesInWords } from "./numberToWords";

export interface InvoicePdfOrg {
  name: string;
  gstNumber: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  logoUrl: string | null;
  invoiceFooter: string | null;
}

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
// is the opaque base64 string returned by the IRP and must be
// rendered verbatim into a QR — the QR is the legally binding part
// of the printed invoice under the e-invoice mandate.
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

function isIntraState(org: InvoicePdfOrg, customer: InvoicePdfCustomer): boolean {
  const orgState = normalizeState(org.state);
  const placeOfSupply = normalizeState(customer.placeOfSupply);
  if (!placeOfSupply || !orgState) return true;
  return placeOfSupply === orgState;
}

function fmtMoney(n: number): string {
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
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
      ({ hsn: key, taxableValue: 0, cgst: 0, sgst: 0, igst: 0 } satisfies HsnSummaryRow);
    row.taxableValue += l.taxableValue;
    row.cgst += l.cgst;
    row.sgst += l.sgst;
    row.igst += l.igst;
    map.set(key, row);
  }
  return Array.from(map.values()).sort((a, b) => a.hsn.localeCompare(b.hsn));
}

function joinAddress(parts: Array<string | null | undefined>): string {
  return parts
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

const PAGE_MARGIN = 36;
const ROW_FONT_SIZE = 9;
const HEADER_FONT_SIZE = 9;
const COLOR_BORDER = "#cccccc";
const COLOR_HEADER_BG = "#f3f4f6";
const COLOR_MUTED = "#666666";

interface Column {
  label: string;
  width: number;
  align?: "left" | "right" | "center";
}

function makeColumns(intra: boolean): Column[] {
  if (intra) {
    return [
      { label: "#", width: 22, align: "right" },
      { label: "Item / Description", width: 150 },
      { label: "HSN", width: 50 },
      { label: "Qty", width: 35, align: "right" },
      { label: "Rate", width: 50, align: "right" },
      { label: "Taxable", width: 60, align: "right" },
      { label: "CGST", width: 55, align: "right" },
      { label: "SGST", width: 55, align: "right" },
      { label: "Total", width: 60, align: "right" },
    ];
  }
  return [
    { label: "#", width: 22, align: "right" },
    { label: "Item / Description", width: 170 },
    { label: "HSN", width: 55 },
    { label: "Qty", width: 40, align: "right" },
    { label: "Rate", width: 55, align: "right" },
    { label: "Taxable", width: 70, align: "right" },
    { label: "IGST", width: 70, align: "right" },
    { label: "Total", width: 75, align: "right" },
  ];
}

function drawTableHeader(
  doc: PDFKit.PDFDocument,
  cols: Column[],
  startX: number,
  y: number,
): number {
  const totalWidth = cols.reduce((s, c) => s + c.width, 0);
  const rowHeight = 20;
  doc.save().rect(startX, y, totalWidth, rowHeight).fill(COLOR_HEADER_BG).restore();
  doc
    .strokeColor(COLOR_BORDER)
    .lineWidth(0.5)
    .rect(startX, y, totalWidth, rowHeight)
    .stroke();
  let x = startX;
  doc.font("Helvetica-Bold").fontSize(HEADER_FONT_SIZE).fillColor("#000");
  for (const col of cols) {
    doc.text(col.label, x + 4, y + 6, {
      width: col.width - 8,
      align: col.align ?? "left",
      lineBreak: false,
    });
    x += col.width;
  }
  return y + rowHeight;
}

function drawTextRow(
  doc: PDFKit.PDFDocument,
  cols: Column[],
  values: string[],
  startX: number,
  y: number,
  itemNameSecondary?: string,
): number {
  doc.font("Helvetica").fontSize(ROW_FONT_SIZE).fillColor("#000");
  const itemColIdx = 1;
  const heights = cols.map((col, i) => {
    return doc.heightOfString(values[i] ?? "", {
      width: col.width - 8,
      align: col.align ?? "left",
    });
  });
  let secondaryHeight = 0;
  if (itemNameSecondary) {
    doc.font("Helvetica").fontSize(ROW_FONT_SIZE - 1);
    secondaryHeight = doc.heightOfString(itemNameSecondary, {
      width: cols[itemColIdx]!.width - 8,
    });
    doc.font("Helvetica").fontSize(ROW_FONT_SIZE);
  }
  const rowHeight = Math.max(...heights, 14) + secondaryHeight + 6;
  let x = startX;
  doc
    .strokeColor(COLOR_BORDER)
    .lineWidth(0.5)
    .rect(
      startX,
      y,
      cols.reduce((s, c) => s + c.width, 0),
      rowHeight,
    )
    .stroke();
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i]!;
    const val = values[i] ?? "";
    doc.font("Helvetica").fontSize(ROW_FONT_SIZE).fillColor("#000");
    doc.text(val, x + 4, y + 4, {
      width: col.width - 8,
      align: col.align ?? "left",
      lineBreak: true,
    });
    if (i === itemColIdx && itemNameSecondary) {
      const itemTextHeight = doc.heightOfString(val, {
        width: col.width - 8,
        align: "left",
      });
      doc
        .font("Helvetica")
        .fontSize(ROW_FONT_SIZE - 1)
        .fillColor(COLOR_MUTED)
        .text(itemNameSecondary, x + 4, y + 4 + itemTextHeight + 1, {
          width: col.width - 8,
          lineBreak: true,
        })
        .fillColor("#000");
    }
    x += col.width;
  }
  return y + rowHeight;
}

function drawTotalsRow(
  doc: PDFKit.PDFDocument,
  cols: Column[],
  values: Array<string | null>,
  startX: number,
  y: number,
  bold = false,
): number {
  const rowHeight = 20;
  const totalWidth = cols.reduce((s, c) => s + c.width, 0);
  if (bold) {
    doc.save().rect(startX, y, totalWidth, rowHeight).fill(COLOR_HEADER_BG).restore();
  }
  doc
    .strokeColor(COLOR_BORDER)
    .lineWidth(0.5)
    .rect(startX, y, totalWidth, rowHeight)
    .stroke();
  doc
    .font(bold ? "Helvetica-Bold" : "Helvetica")
    .fontSize(HEADER_FONT_SIZE)
    .fillColor("#000");
  let x = startX;
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i]!;
    const val = values[i];
    if (val !== null && val !== undefined) {
      doc.text(val, x + 4, y + 6, {
        width: col.width - 8,
        align: col.align ?? "left",
        lineBreak: false,
      });
    }
    x += col.width;
  }
  return y + rowHeight;
}

function ensureRoom(
  doc: PDFKit.PDFDocument,
  needed: number,
  startX: number,
  cols: Column[],
  currentY: number,
): number {
  const limit = doc.page.height - PAGE_MARGIN;
  if (currentY + needed > limit) {
    doc.addPage();
    return drawTableHeader(doc, cols, startX, PAGE_MARGIN);
  }
  return currentY;
}

export async function renderInvoicePdf(
  input: RenderInvoiceInput,
): Promise<Buffer> {
  const { org, customer, order, lines, logoBuffer, einvoice } = input;
  const intra = isIntraState(org, customer);
  const computed = computeLines(lines, intra);
  const summary = summarizeByHsn(computed);

  const doc = new PDFDocument({
    size: "A4",
    margin: PAGE_MARGIN,
    info: {
      Title: `Invoice ${order.orderNumber}`,
      Author: org.name,
      Subject: `Tax invoice for ${customer.name}`,
    },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const pageLeft = PAGE_MARGIN;
  const pageRight = doc.page.width - PAGE_MARGIN;
  const pageWidth = pageRight - pageLeft;

  // ---- Header band ------------------------------------------------------
  let y = PAGE_MARGIN;
  let logoBottom = y;
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, pageLeft, y, { fit: [80, 80] });
      logoBottom = y + 80;
    } catch {
      logoBottom = y;
    }
  }
  const orgBlockX = logoBuffer ? pageLeft + 90 : pageLeft;
  const orgBlockWidth = pageRight - orgBlockX - 200;
  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .fillColor("#000")
    .text(org.name, orgBlockX, y, { width: orgBlockWidth });
  doc.moveDown(0.2);
  doc.font("Helvetica").fontSize(9).fillColor(COLOR_MUTED);
  const orgAddress = joinAddress([
    org.addressLine1,
    org.addressLine2,
    org.city,
    org.state,
    org.postalCode,
    org.country,
  ]);
  if (orgAddress) doc.text(orgAddress, orgBlockX, doc.y, { width: orgBlockWidth });
  if (org.gstNumber) doc.text(`GSTIN: ${org.gstNumber}`, orgBlockX, doc.y, { width: orgBlockWidth });
  doc.fillColor("#000");

  // Right-side invoice meta block
  const metaX = pageRight - 195;
  const metaTop = y;
  doc
    .font("Helvetica-Bold")
    .fontSize(18)
    .fillColor("#111")
    .text("TAX INVOICE", metaX, metaTop, { width: 195, align: "right" });
  const metaPairs: Array<[string, string]> = [
    ["Invoice #", order.orderNumber],
    ["Date", order.orderDate],
  ];
  if (order.expectedShipDate)
    metaPairs.push(["Due / ship by", order.expectedShipDate]);
  if (customer.placeOfSupply)
    metaPairs.push(["Place of supply", customer.placeOfSupply]);
  metaPairs.push(["Tax type", intra ? "Intra-state (CGST + SGST)" : "Inter-state (IGST)"]);
  let metaY = metaTop + 24;
  doc.font("Helvetica").fontSize(9).fillColor("#000");
  for (const [k, v] of metaPairs) {
    doc.font("Helvetica").fillColor(COLOR_MUTED).text(k, metaX, metaY, {
      width: 90,
      align: "right",
      lineBreak: false,
    });
    doc.font("Helvetica-Bold").fillColor("#000").text(v, metaX + 95, metaY, {
      width: 100,
      align: "right",
      lineBreak: false,
    });
    metaY += 13;
  }

  y = Math.max(doc.y, logoBottom, metaY) + 16;

  // ---- Bill-to / Ship-to ------------------------------------------------
  const colWidth = (pageWidth - 12) / 2;
  doc
    .strokeColor(COLOR_BORDER)
    .lineWidth(0.5)
    .rect(pageLeft, y, colWidth, 110)
    .stroke();
  doc
    .strokeColor(COLOR_BORDER)
    .lineWidth(0.5)
    .rect(pageLeft + colWidth + 12, y, colWidth, 110)
    .stroke();
  const drawAddrBox = (label: string, body: string[], x0: number) => {
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(COLOR_MUTED)
      .text(label, x0 + 8, y + 8, { width: colWidth - 16 });
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#000");
    doc.text(body[0] ?? "", x0 + 8, y + 22, { width: colWidth - 16 });
    doc.font("Helvetica").fontSize(9).fillColor("#000");
    let by = doc.y + 2;
    for (const line of body.slice(1)) {
      if (!line) continue;
      doc.text(line, x0 + 8, by, { width: colWidth - 16 });
      by = doc.y;
    }
  };
  const billLines = [
    customer.company || customer.name,
    ...(customer.company && customer.company !== customer.name ? [customer.name] : []),
    ...(customer.billingAddress?.split("\n") ?? []),
    customer.gstNumber ? `GSTIN: ${customer.gstNumber}` : "",
    customer.email ? `Email: ${customer.email}` : "",
    customer.phone ? `Phone: ${customer.phone}` : "",
  ].filter(Boolean) as string[];
  drawAddrBox("BILL TO", billLines, pageLeft);
  const shipLines = [
    customer.company || customer.name,
    ...(customer.shippingAddress?.split("\n") ?? customer.billingAddress?.split("\n") ?? []),
    customer.placeOfSupply ? `Place of supply: ${customer.placeOfSupply}` : "",
  ].filter(Boolean) as string[];
  drawAddrBox("SHIP TO", shipLines, pageLeft + colWidth + 12);
  y += 120;

  // ---- Line table -------------------------------------------------------
  const cols = makeColumns(intra);
  const tableTotalWidth = cols.reduce((s, c) => s + c.width, 0);
  const tableStartX =
    pageLeft + Math.max(0, Math.floor((pageWidth - tableTotalWidth) / 2));
  y = drawTableHeader(doc, cols, tableStartX, y);
  doc.font("Helvetica").fontSize(ROW_FONT_SIZE);
  for (let i = 0; i < computed.length; i++) {
    const c = computed[i]!;
    const itemMain = c.src.itemName;
    const itemSub = [c.src.sku, c.src.description]
      .map((s) => (s ?? "").trim())
      .filter(Boolean)
      .join(" — ");
    const values = intra
      ? [
          String(i + 1),
          itemMain,
          c.hsn || "-",
          fmtQty(c.qty),
          fmtMoney(c.rate),
          fmtMoney(c.taxableValue),
          `${fmtMoney(c.cgst)}\n(${(toNum(c.src.taxRate) / 2).toFixed(1)}%)`,
          `${fmtMoney(c.sgst)}\n(${(toNum(c.src.taxRate) / 2).toFixed(1)}%)`,
          fmtMoney(c.total),
        ]
      : [
          String(i + 1),
          itemMain,
          c.hsn || "-",
          fmtQty(c.qty),
          fmtMoney(c.rate),
          fmtMoney(c.taxableValue),
          `${fmtMoney(c.igst)}\n(${toNum(c.src.taxRate).toFixed(1)}%)`,
          fmtMoney(c.total),
        ];
    y = ensureRoom(doc, 30, tableStartX, cols, y);
    y = drawTextRow(doc, cols, values, tableStartX, y, itemSub || undefined);
  }

  // ---- Totals rows ------------------------------------------------------
  const subtotal = toNum(order.subtotal);
  const taxTotal = toNum(order.taxTotal);
  const total = toNum(order.total);
  const amountPaid = toNum(order.amountPaid);
  const balance = toNum(order.balanceDue);

  const totalsValueColIdx = cols.length - 1;
  const labelColIdx = cols.length - 2;
  const totalsLabelWidth = cols
    .slice(0, labelColIdx + 1)
    .reduce((s, c) => s + c.width, 0);
  const drawTotalLine = (label: string, value: string, bold = false) => {
    y = ensureRoom(doc, 22, tableStartX, cols, y);
    const rowHeight = 20;
    const totalWidth = cols.reduce((s, c) => s + c.width, 0);
    doc
      .strokeColor(COLOR_BORDER)
      .lineWidth(0.5)
      .rect(tableStartX, y, totalWidth, rowHeight)
      .stroke();
    if (bold) {
      doc.save().rect(tableStartX, y, totalWidth, rowHeight).fillOpacity(1).fill(COLOR_HEADER_BG).restore();
      doc
        .strokeColor(COLOR_BORDER)
        .lineWidth(0.5)
        .rect(tableStartX, y, totalWidth, rowHeight)
        .stroke();
    }
    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(HEADER_FONT_SIZE)
      .fillColor("#000")
      .text(label, tableStartX + 4, y + 6, {
        width: totalsLabelWidth - 8,
        align: "right",
        lineBreak: false,
      })
      .text(value, tableStartX + totalsLabelWidth, y + 6, {
        width: cols[totalsValueColIdx]!.width - 8,
        align: "right",
        lineBreak: false,
      });
    y += rowHeight;
  };

  drawTotalLine("Subtotal", fmtMoney(subtotal));
  if (intra) {
    drawTotalLine(
      "CGST",
      fmtMoney(computed.reduce((s, l) => s + l.cgst, 0)),
    );
    drawTotalLine(
      "SGST",
      fmtMoney(computed.reduce((s, l) => s + l.sgst, 0)),
    );
  } else {
    drawTotalLine("IGST", fmtMoney(computed.reduce((s, l) => s + l.igst, 0)));
  }
  drawTotalLine("Total tax", fmtMoney(taxTotal));
  drawTotalLine("Grand total (INR)", fmtMoney(total), true);
  if (amountPaid > 0.005) drawTotalLine("Amount paid", fmtMoney(amountPaid));
  if (Math.abs(balance) > 0.005)
    drawTotalLine("Balance due", fmtMoney(balance), true);

  // ---- Amount in words --------------------------------------------------
  y += 8;
  y = ensureRoom(doc, 36, tableStartX, cols, y);
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(COLOR_MUTED)
    .text("Amount in words", pageLeft, y, { width: pageWidth });
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#000")
    .text(rupeesInWords(total), pageLeft, doc.y + 1, { width: pageWidth });
  y = doc.y + 10;

  // ---- HSN summary ------------------------------------------------------
  if (summary.length > 0) {
    y = ensureRoom(doc, 80, tableStartX, cols, y);
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor("#000")
      .text("HSN-wise summary", pageLeft, y, { width: pageWidth });
    y = doc.y + 4;
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
    for (const row of summary) {
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
      y = drawTextRow(doc, hsnCols, values, pageLeft, y);
      totalTaxable += row.taxableValue;
      totalCgst += row.cgst;
      totalSgst += row.sgst;
      totalIgst += row.igst;
    }
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
    y = drawTotalsRow(doc, hsnCols, totalsRow, pageLeft, y, true);
  }

  // ---- Notes / footer / signature / QR placeholder ----------------------
  y += 14;
  y = ensureRoom(doc, 110, tableStartX, cols, y);
  if (order.notes) {
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(COLOR_MUTED)
      .text("Notes", pageLeft, y, { width: pageWidth });
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#000")
      .text(order.notes, pageLeft, doc.y + 1, { width: pageWidth });
    y = doc.y + 10;
  }
  if (org.invoiceFooter) {
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(COLOR_MUTED)
      .text(org.invoiceFooter, pageLeft, y, { width: pageWidth });
    y = doc.y + 8;
  }

  // QR + compliance summary on the left, signature on the right.
  // Under the GST e-invoice mandate (CGST notification 13/2020), the
  // IRP-signed QR is what makes the printed invoice legally valid —
  // so when both exist, the IRP QR takes the visual slot and the
  // e-way bill is summarised as text beside it. When only an EWB
  // exists (e.g. a B2C transport), we fall back to rendering the
  // EWB QR.
  const sigBoxY = y + 4;
  const qrSize = 70;
  const ewb = input.ewb && input.ewb.status === "active" ? input.ewb : null;
  const fmtDate = (d: Date | null) =>
    d
      ? d.toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        })
      : "—";
  if (einvoice && einvoice.qrPayload) {
    try {
      const qrPng = await QRCode.toBuffer(einvoice.qrPayload, {
        type: "png",
        errorCorrectionLevel: "M",
        margin: 0,
        width: 220,
      });
      doc.image(qrPng, pageLeft, sigBoxY, { width: qrSize, height: qrSize });
    } catch {
      doc
        .strokeColor(COLOR_BORDER)
        .lineWidth(0.5)
        .rect(pageLeft, sigBoxY, qrSize, qrSize)
        .stroke();
    }
    const labelX = pageLeft + qrSize + 6;
    const ackDate =
      typeof einvoice.ackDate === "string"
        ? new Date(einvoice.ackDate)
        : einvoice.ackDate;
    doc
      .font("Helvetica-Bold")
      .fontSize(7)
      .fillColor("#000")
      .text("e-Invoice (IRP)", labelX, sigBoxY, { width: 200 });
    doc
      .font("Helvetica")
      .fontSize(6.5)
      .fillColor(COLOR_MUTED)
      .text(`IRN: ${einvoice.irn}`, labelX, sigBoxY + 11, { width: 200 });
    let lineY = sigBoxY + 28;
    if (einvoice.ackNumber) {
      doc.text(`Ack #: ${einvoice.ackNumber}`, labelX, lineY, { width: 200 });
      lineY += 11;
    }
    if (ackDate) {
      doc.text(`Ack date: ${fmtDate(ackDate)}`, labelX, lineY, { width: 200 });
      lineY += 11;
    }
    if (einvoice.status === "cancelled") {
      doc
        .fillColor("#b91c1c")
        .font("Helvetica-Bold")
        .text("CANCELLED", labelX, lineY, { width: 200 });
      lineY += 11;
    }
    if (ewb) {
      // Both compliance documents present — summarise the EWB as
      // text beside the IRP QR. The EWB QR can still be retrieved
      // from the standalone EWB PDF endpoint when the transporter
      // needs it.
      doc
        .font("Helvetica-Bold")
        .fontSize(6.5)
        .fillColor("#000")
        .text(`EWB: ${ewb.number}`, labelX, lineY + 2, { width: 200 });
      const ewbDate = ewb.date ? new Date(ewb.date) : null;
      const ewbValid = ewb.validUntil ? new Date(ewb.validUntil) : null;
      doc
        .font("Helvetica")
        .fontSize(6.5)
        .fillColor(COLOR_MUTED)
        .text(
          `${fmtDate(ewbDate)} · valid ${fmtDate(ewbValid)} · ${ewb.vehicleNumber ?? "—"}`,
          labelX,
          lineY + 13,
          { width: 200 },
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
        .strokeColor(COLOR_BORDER)
        .lineWidth(0.5)
        .rect(pageLeft, sigBoxY, qrSize, qrSize)
        .stroke();
    }
    const ewbDate = ewb.date ? new Date(ewb.date) : null;
    const ewbValid = ewb.validUntil ? new Date(ewb.validUntil) : null;
    const labelX = pageLeft + qrSize + 8;
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor("#000")
      .text("E-way bill", labelX, sigBoxY, { width: 200 });
    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor(COLOR_MUTED)
      .text(`No.: ${ewb.number}`, labelX, sigBoxY + 11, { width: 200 })
      .text(`Date: ${fmtDate(ewbDate)}`, labelX, sigBoxY + 22, { width: 200 })
      .text(`Valid until: ${fmtDate(ewbValid)}`, labelX, sigBoxY + 33, {
        width: 200,
      })
      .text(`Vehicle: ${ewb.vehicleNumber ?? "—"}`, labelX, sigBoxY + 44, {
        width: 200,
      });
  } else {
    doc
      .strokeColor(COLOR_BORDER)
      .lineWidth(0.5)
      .rect(pageLeft, sigBoxY, qrSize, qrSize)
      .stroke();
    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor(COLOR_MUTED)
      .text("QR will appear after\ne-invoice (IRN) registration.", pageLeft + 4, sigBoxY + 22, {
        width: qrSize - 8,
        align: "center",
      });
  }

  const sigX = pageRight - 200;
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#000")
    .text(`For ${org.name}`, sigX, sigBoxY, { width: 200, align: "right" });
  doc.text("", sigX, sigBoxY + 50, { width: 200 });
  doc
    .strokeColor("#999")
    .lineWidth(0.5)
    .moveTo(sigX, sigBoxY + qrSize - 8)
    .lineTo(pageRight, sigBoxY + qrSize - 8)
    .stroke();
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(COLOR_MUTED)
    .text("Authorised signatory", sigX, sigBoxY + qrSize - 4, {
      width: 200,
      align: "right",
    });

  doc.end();
  return done;
}
