// Shared PDF design system used by every business document
// (invoice, purchase order, payment receipts, vouchers, dispatch slips,
// sales acknowledgements, delivery challans). The goal is a single
// place that controls typography, spacing, table rendering and page
// chrome so every printable document looks like it came from the same
// company.

import PDFDocument from "pdfkit";

// ---------------------------------------------------------------------------
// Brand tokens
// ---------------------------------------------------------------------------

export const COLORS = {
  textPrimary: "#0f172a", // slate-900
  textBody: "#1e293b", // slate-800
  textMuted: "#64748b", // slate-500
  textFaint: "#94a3b8", // slate-400
  border: "#e2e8f0", // slate-200
  borderStrong: "#cbd5e1", // slate-300
  fillSubtle: "#f8fafc", // slate-50
  fillRow: "#f1f5f9", // slate-100 — alt-row shading
  fillTotal: "#e2e8f0", // slate-200 — grand total band
  accent: "#0f172a", // slate-900 — title underline
  danger: "#dc2626",
  success: "#16a34a",
  warning: "#d97706",
} as const;

export const FONTS = {
  regular: "Helvetica",
  bold: "Helvetica-Bold",
  italic: "Helvetica-Oblique",
  boldItalic: "Helvetica-BoldOblique",
} as const;

export const PAGE = {
  margin: 36,
  // A4 from PDFKit: 595.28 x 841.89 pt
  innerWidth: 595.28 - 72,
} as const;

// ---------------------------------------------------------------------------
// Common interfaces
// ---------------------------------------------------------------------------

export interface DocOrg {
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

export interface DocParty {
  name: string;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  gstNumber?: string | null;
  addressLines?: string[]; // pre-split by caller
  extraLines?: string[]; // place-of-supply, etc.
}

export type Align = "left" | "right" | "center";

export interface Column {
  label: string;
  width: number;
  align?: Align;
}

// ---------------------------------------------------------------------------
// Document factory
// ---------------------------------------------------------------------------

export interface DocFactoryOptions {
  title: string;
  author: string;
  subject?: string;
}

export interface PdfDocBundle {
  doc: PDFKit.PDFDocument;
  done: Promise<Buffer>;
  pageLeft: number;
  pageRight: number;
  pageWidth: number;
}

export function createPdfDoc(opts: DocFactoryOptions): PdfDocBundle {
  const doc = new PDFDocument({
    size: "A4",
    margin: PAGE.margin,
    bufferPages: true,
    info: {
      Title: opts.title,
      Author: opts.author,
      Subject: opts.subject ?? opts.title,
    },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const pageLeft = PAGE.margin;
  const pageRight = doc.page.width - PAGE.margin;
  const pageWidth = pageRight - pageLeft;
  return { doc, done, pageLeft, pageRight, pageWidth };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function fmtMoney(n: number): string {
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function joinAddress(
  parts: Array<string | null | undefined>,
): string {
  return parts
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

// ---------------------------------------------------------------------------
// Header band — logo + org block on the left, doc title + meta on the right.
// Returns the y coordinate immediately below the header.
// ---------------------------------------------------------------------------

export interface HeaderBandInput {
  doc: PDFKit.PDFDocument;
  org: DocOrg;
  logoBuffer: Buffer | null;
  documentTitle: string; // e.g. "TAX INVOICE", "PURCHASE ORDER"
  documentSubtitle?: string | null; // e.g. "Original for recipient"
  metaPairs: Array<[string, string]>;
  pageLeft: number;
  pageRight: number;
}

export function drawHeaderBand(input: HeaderBandInput): number {
  const { doc, org, logoBuffer, documentTitle, documentSubtitle, metaPairs } =
    input;
  const { pageLeft, pageRight } = input;
  const y = PAGE.margin;

  let logoBottom = y;
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, pageLeft, y, { fit: [80, 70] });
      logoBottom = y + 70;
    } catch {
      logoBottom = y;
    }
  }

  // ---- Org block (left, beside logo) ----
  const orgBlockX = logoBuffer ? pageLeft + 92 : pageLeft;
  const orgBlockWidth = pageRight - orgBlockX - 220;
  doc
    .font(FONTS.bold)
    .fontSize(14)
    .fillColor(COLORS.textPrimary)
    .text(org.name, orgBlockX, y, { width: orgBlockWidth });
  const orgAddress = joinAddress([
    org.addressLine1,
    org.addressLine2,
    org.city,
    org.state,
    org.postalCode,
    org.country,
  ]);
  doc.font(FONTS.regular).fontSize(8.5).fillColor(COLORS.textMuted);
  if (orgAddress) {
    doc.text(orgAddress, orgBlockX, doc.y + 1, { width: orgBlockWidth });
  }
  if (org.gstNumber) {
    doc
      .font(FONTS.regular)
      .fillColor(COLORS.textBody)
      .text(`GSTIN ${org.gstNumber}`, orgBlockX, doc.y + 1, {
        width: orgBlockWidth,
      });
  }
  const orgBottom = doc.y;

  // ---- Document title + meta (right) ----
  const metaWidth = 215;
  const metaX = pageRight - metaWidth;
  doc
    .font(FONTS.bold)
    .fontSize(18)
    .fillColor(COLORS.textPrimary)
    .text(documentTitle, metaX, y, { width: metaWidth, align: "right" });
  let metaY = y + 22;
  if (documentSubtitle) {
    doc
      .font(FONTS.regular)
      .fontSize(8)
      .fillColor(COLORS.textMuted)
      .text(documentSubtitle, metaX, metaY, {
        width: metaWidth,
        align: "right",
      });
    metaY = doc.y + 2;
  }
  // Thin accent rule beneath the title
  doc
    .strokeColor(COLORS.accent)
    .lineWidth(1.2)
    .moveTo(metaX, metaY + 1)
    .lineTo(pageRight, metaY + 1)
    .stroke();
  metaY += 8;

  doc.font(FONTS.regular).fontSize(9).fillColor(COLORS.textBody);
  for (const [k, v] of metaPairs) {
    doc
      .font(FONTS.regular)
      .fillColor(COLORS.textMuted)
      .text(k, metaX, metaY, {
        width: 95,
        align: "right",
        lineBreak: false,
      });
    doc
      .font(FONTS.bold)
      .fillColor(COLORS.textPrimary)
      .text(v, metaX + 100, metaY, {
        width: metaWidth - 100,
        align: "right",
        lineBreak: false,
      });
    metaY += 13;
  }

  // Bottom of header is the lower of org block / meta block, with a
  // subtle rule drawn across the page width.
  const headerBottom = Math.max(orgBottom, logoBottom, metaY) + 12;
  doc
    .strokeColor(COLORS.border)
    .lineWidth(0.5)
    .moveTo(pageLeft, headerBottom)
    .lineTo(pageRight, headerBottom)
    .stroke();
  return headerBottom + 12;
}

// ---------------------------------------------------------------------------
// Party boxes (Bill-to / Ship-to / From / To). Two boxes side-by-side.
// ---------------------------------------------------------------------------

export interface PartyBoxesInput {
  doc: PDFKit.PDFDocument;
  y: number;
  pageLeft: number;
  pageWidth: number;
  left: { label: string; party: DocParty };
  right: { label: string; party: DocParty };
  height?: number;
}

function partyToLines(p: DocParty): string[] {
  const lines: string[] = [];
  const top = p.company || p.name;
  lines.push(top);
  if (p.company && p.name && p.company !== p.name) {
    lines.push(p.name);
  }
  for (const a of p.addressLines ?? []) {
    if (a && a.trim()) lines.push(a.trim());
  }
  if (p.gstNumber) lines.push(`GSTIN ${p.gstNumber}`);
  if (p.email) lines.push(`Email: ${p.email}`);
  if (p.phone) lines.push(`Phone: ${p.phone}`);
  for (const e of p.extraLines ?? []) {
    if (e && e.trim()) lines.push(e.trim());
  }
  return lines;
}

export function drawPartyBoxes(input: PartyBoxesInput): number {
  const { doc, y, pageLeft, pageWidth, left, right } = input;
  const gap = 12;
  const colWidth = (pageWidth - gap) / 2;
  const height = input.height ?? 108;

  const drawBox = (label: string, lines: string[], x0: number) => {
    // Label strip (subtle background)
    doc
      .save()
      .rect(x0, y, colWidth, 18)
      .fill(COLORS.fillSubtle)
      .restore();
    doc
      .strokeColor(COLORS.border)
      .lineWidth(0.5)
      .rect(x0, y, colWidth, height)
      .stroke();
    doc
      .strokeColor(COLORS.border)
      .lineWidth(0.5)
      .moveTo(x0, y + 18)
      .lineTo(x0 + colWidth, y + 18)
      .stroke();
    doc
      .font(FONTS.bold)
      .fontSize(8)
      .fillColor(COLORS.textMuted)
      .text(label, x0 + 8, y + 5, {
        width: colWidth - 16,
        characterSpacing: 0.6,
        lineBreak: false,
      });
    // Body
    let by = y + 24;
    const bodyMax = y + height - 6;
    if (lines[0]) {
      doc
        .font(FONTS.bold)
        .fontSize(10.5)
        .fillColor(COLORS.textPrimary)
        .text(lines[0], x0 + 8, by, { width: colWidth - 16 });
      by = doc.y + 1;
    }
    doc.font(FONTS.regular).fontSize(8.5).fillColor(COLORS.textBody);
    for (const line of lines.slice(1)) {
      if (by > bodyMax) break;
      doc.text(line, x0 + 8, by, { width: colWidth - 16 });
      by = doc.y;
    }
  };

  drawBox(left.label.toUpperCase(), partyToLines(left.party), pageLeft);
  drawBox(
    right.label.toUpperCase(),
    partyToLines(right.party),
    pageLeft + colWidth + gap,
  );
  return y + height + 14;
}

// ---------------------------------------------------------------------------
// Section title — small label + thin underline
// ---------------------------------------------------------------------------

export function drawSectionTitle(
  doc: PDFKit.PDFDocument,
  text: string,
  pageLeft: number,
  pageWidth: number,
  y: number,
): number {
  doc
    .font(FONTS.bold)
    .fontSize(10)
    .fillColor(COLORS.textPrimary)
    .text(text, pageLeft, y, { width: pageWidth, lineBreak: false });
  const bottom = doc.y + 2;
  doc
    .strokeColor(COLORS.border)
    .lineWidth(0.5)
    .moveTo(pageLeft, bottom)
    .lineTo(pageLeft + pageWidth, bottom)
    .stroke();
  return bottom + 6;
}

// ---------------------------------------------------------------------------
// Table primitives
// ---------------------------------------------------------------------------

const ROW_FONT = 9;
const HEADER_FONT = 9;

export function drawTableHeader(
  doc: PDFKit.PDFDocument,
  cols: Column[],
  startX: number,
  y: number,
): number {
  const totalWidth = cols.reduce((s, c) => s + c.width, 0);
  const rowHeight = 22;
  doc
    .save()
    .rect(startX, y, totalWidth, rowHeight)
    .fill(COLORS.textPrimary)
    .restore();
  let x = startX;
  doc.font(FONTS.bold).fontSize(HEADER_FONT).fillColor("#ffffff");
  for (const col of cols) {
    doc.text(col.label, x + 5, y + 7, {
      width: col.width - 10,
      align: col.align ?? "left",
      lineBreak: false,
    });
    x += col.width;
  }
  // Bottom rule under header
  doc
    .strokeColor(COLORS.borderStrong)
    .lineWidth(0.5)
    .moveTo(startX, y + rowHeight)
    .lineTo(startX + totalWidth, y + rowHeight)
    .stroke();
  return y + rowHeight;
}

export interface TableRowInput {
  doc: PDFKit.PDFDocument;
  cols: Column[];
  values: string[];
  startX: number;
  y: number;
  /** Optional secondary text beneath cell at given column index. */
  subtext?: { colIdx: number; text: string };
  /** Subtle alt-row shading — call with i % 2 === 1. */
  shaded?: boolean;
}

export function drawTextRow(input: TableRowInput): number {
  const { doc, cols, values, startX, y, subtext, shaded } = input;
  doc.font(FONTS.regular).fontSize(ROW_FONT).fillColor(COLORS.textBody);

  // Compute row height first so the shading fills the actual rect.
  const heights = cols.map((col, i) =>
    doc.heightOfString(values[i] ?? "", {
      width: col.width - 10,
      align: col.align ?? "left",
    }),
  );
  let subHeight = 0;
  if (subtext) {
    doc.font(FONTS.regular).fontSize(ROW_FONT - 1.5);
    subHeight = doc.heightOfString(subtext.text, {
      width: cols[subtext.colIdx]!.width - 10,
    });
    doc.font(FONTS.regular).fontSize(ROW_FONT);
  }
  const rowHeight = Math.max(...heights, 14) + subHeight + 8;
  const totalWidth = cols.reduce((s, c) => s + c.width, 0);

  if (shaded) {
    doc
      .save()
      .rect(startX, y, totalWidth, rowHeight)
      .fill(COLORS.fillRow)
      .restore();
  }
  // Bottom border on each row, no per-cell vertical rules — easier to
  // scan and visually cleaner.
  doc
    .strokeColor(COLORS.border)
    .lineWidth(0.4)
    .moveTo(startX, y + rowHeight)
    .lineTo(startX + totalWidth, y + rowHeight)
    .stroke();

  let x = startX;
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i]!;
    const val = values[i] ?? "";
    doc
      .font(FONTS.regular)
      .fontSize(ROW_FONT)
      .fillColor(COLORS.textBody)
      .text(val, x + 5, y + 5, {
        width: col.width - 10,
        align: col.align ?? "left",
        lineBreak: true,
      });
    if (subtext && i === subtext.colIdx) {
      const mainHeight = doc.heightOfString(val, {
        width: col.width - 10,
        align: col.align ?? "left",
      });
      doc
        .font(FONTS.regular)
        .fontSize(ROW_FONT - 1.5)
        .fillColor(COLORS.textMuted)
        .text(subtext.text, x + 5, y + 5 + mainHeight + 1, {
          width: col.width - 10,
          lineBreak: true,
        });
    }
    x += col.width;
  }
  return y + rowHeight;
}

// ---------------------------------------------------------------------------
// Totals — right-aligned label + value spanning the table width.
// ---------------------------------------------------------------------------

export interface TotalsLineInput {
  doc: PDFKit.PDFDocument;
  cols: Column[];
  startX: number;
  y: number;
  label: string;
  value: string;
  /** True for grand-total row (filled background, bold). */
  emphasized?: boolean;
  /** True for muted style (e.g. paid amount line). */
  muted?: boolean;
}

export function drawTotalsLine(input: TotalsLineInput): number {
  const { doc, cols, startX, y, label, value, emphasized, muted } = input;
  const rowHeight = emphasized ? 24 : 20;
  const totalWidth = cols.reduce((s, c) => s + c.width, 0);
  const valueColWidth = cols[cols.length - 1]!.width;
  const labelWidth = totalWidth - valueColWidth;

  if (emphasized) {
    doc
      .save()
      .rect(startX, y, totalWidth, rowHeight)
      .fill(COLORS.fillTotal)
      .restore();
  }
  doc
    .strokeColor(COLORS.border)
    .lineWidth(0.4)
    .moveTo(startX, y + rowHeight)
    .lineTo(startX + totalWidth, y + rowHeight)
    .stroke();

  const fontName = emphasized ? FONTS.bold : muted ? FONTS.regular : FONTS.regular;
  const labelColor = muted ? COLORS.textMuted : COLORS.textBody;
  const valueColor = emphasized
    ? COLORS.textPrimary
    : muted
      ? COLORS.textMuted
      : COLORS.textPrimary;
  const fontSize = emphasized ? 11 : 9.5;

  doc
    .font(fontName)
    .fontSize(fontSize)
    .fillColor(labelColor)
    .text(label, startX + 5, y + (emphasized ? 7 : 6), {
      width: labelWidth - 10,
      align: "right",
      lineBreak: false,
    });
  doc
    .font(emphasized ? FONTS.bold : FONTS.bold)
    .fontSize(fontSize)
    .fillColor(valueColor)
    .text(value, startX + labelWidth, y + (emphasized ? 7 : 6), {
      width: valueColWidth - 5,
      align: "right",
      lineBreak: false,
    });
  return y + rowHeight;
}

// ---------------------------------------------------------------------------
// Page-break helper for tables. Repaints the table header on the new page.
// ---------------------------------------------------------------------------

export function ensureRoom(
  doc: PDFKit.PDFDocument,
  needed: number,
  startX: number,
  cols: Column[],
  y: number,
  bottomMargin = PAGE.margin + 24, // leave room for footer
): number {
  const limit = doc.page.height - bottomMargin;
  if (y + needed > limit) {
    doc.addPage();
    return drawTableHeader(doc, cols, startX, PAGE.margin);
  }
  return y;
}

// ---------------------------------------------------------------------------
// Notes block — small label + body text.
// ---------------------------------------------------------------------------

export function drawNotesBlock(
  doc: PDFKit.PDFDocument,
  label: string,
  text: string | null | undefined,
  pageLeft: number,
  pageWidth: number,
  y: number,
): number {
  if (!text || !text.trim()) return y;
  doc
    .font(FONTS.bold)
    .fontSize(8.5)
    .fillColor(COLORS.textMuted)
    .text(label.toUpperCase(), pageLeft, y, {
      width: pageWidth,
      characterSpacing: 0.5,
      lineBreak: false,
    });
  doc
    .font(FONTS.regular)
    .fontSize(9)
    .fillColor(COLORS.textBody)
    .text(text, pageLeft, doc.y + 2, { width: pageWidth });
  return doc.y + 8;
}

// ---------------------------------------------------------------------------
// Signature block (right-aligned)
// ---------------------------------------------------------------------------

export function drawSignatureBlock(
  doc: PDFKit.PDFDocument,
  orgName: string,
  pageRight: number,
  y: number,
  width = 200,
): void {
  const x = pageRight - width;
  doc
    .font(FONTS.regular)
    .fontSize(9)
    .fillColor(COLORS.textBody)
    .text(`For ${orgName}`, x, y, { width, align: "right" });
  // signature line ~ 50pt below
  const lineY = y + 56;
  doc
    .strokeColor(COLORS.borderStrong)
    .lineWidth(0.5)
    .moveTo(x, lineY)
    .lineTo(pageRight, lineY)
    .stroke();
  doc
    .font(FONTS.regular)
    .fontSize(8)
    .fillColor(COLORS.textMuted)
    .text("Authorised signatory", x, lineY + 3, {
      width,
      align: "right",
    });
}

// ---------------------------------------------------------------------------
// Status stamp — diagonal watermark for DRAFT / CANCELLED / PAID.
// Drawn once, large, at the centre of the first page after content.
// ---------------------------------------------------------------------------

export type StatusStamp = "DRAFT" | "CANCELLED" | "PAID" | "DUPLICATE";

export function drawStatusStamp(
  doc: PDFKit.PDFDocument,
  text: StatusStamp,
): void {
  const colorMap: Record<StatusStamp, string> = {
    DRAFT: COLORS.textFaint,
    CANCELLED: COLORS.danger,
    PAID: COLORS.success,
    DUPLICATE: COLORS.warning,
  };
  const color = colorMap[text];
  // Render on the first page only — switch to page 0 deterministically.
  doc.switchToPage(0);
  doc.save();
  const cx = doc.page.width / 2;
  const cy = doc.page.height / 2;
  doc.translate(cx, cy);
  doc.rotate(-30);
  doc.opacity(0.12);
  doc
    .font(FONTS.bold)
    .fontSize(110)
    .fillColor(color)
    .text(text, -260, -55, { width: 520, align: "center", lineBreak: false });
  doc.opacity(1);
  doc.restore();
}

// ---------------------------------------------------------------------------
// Page footer — drawn after content via doc.bufferedPageRange().
// Shows "Page X of Y" right + small org line left + generated timestamp.
// ---------------------------------------------------------------------------

export function paginate(
  doc: PDFKit.PDFDocument,
  org: DocOrg,
  documentLabel: string,
): void {
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let i = 0; i < total; i++) {
    doc.switchToPage(range.start + i);
    // We intentionally draw the footer below the normal bottom margin.
    // PDFKit's text() will auto-add a new page when y is past
    // (page.height - margins.bottom), even with lineBreak:false. Temporarily
    // drop the bottom margin to 0 so writing the footer doesn't trigger a
    // spurious addPage() — which would in turn need its own footer drawn,
    // causing trailing empty pages.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - PAGE.margin + 6;
    doc
      .strokeColor(COLORS.border)
      .lineWidth(0.4)
      .moveTo(PAGE.margin, y - 4)
      .lineTo(doc.page.width - PAGE.margin, y - 4)
      .stroke();
    doc
      .font(FONTS.regular)
      .fontSize(7.5)
      .fillColor(COLORS.textMuted)
      .text(
        `${org.name} · ${documentLabel}`,
        PAGE.margin,
        y,
        {
          width: (doc.page.width - PAGE.margin * 2) / 2,
          align: "left",
          lineBreak: false,
        },
      );
    doc.text(
      `Page ${i + 1} of ${total}`,
      doc.page.width / 2,
      y,
      {
        width: doc.page.width / 2 - PAGE.margin,
        align: "right",
        lineBreak: false,
      },
    );
    doc.page.margins.bottom = savedBottom;
  }
}

// ---------------------------------------------------------------------------
// Compact info grid — used by simple documents (e.g. payment voucher) to
// display a 2×N grid of label/value pairs with subtle borders.
// ---------------------------------------------------------------------------

export interface InfoGridInput {
  doc: PDFKit.PDFDocument;
  pairs: Array<[label: string, value: string]>;
  pageLeft: number;
  pageWidth: number;
  y: number;
  columns?: number; // default 2
}

export function drawInfoGrid(input: InfoGridInput): number {
  const { doc, pairs, pageLeft, pageWidth, y } = input;
  const cols = input.columns ?? 2;
  const cellW = pageWidth / cols;
  const rowH = 28;
  const rows = Math.ceil(pairs.length / cols);
  doc
    .strokeColor(COLORS.border)
    .lineWidth(0.5)
    .rect(pageLeft, y, pageWidth, rowH * rows)
    .stroke();
  for (let i = 0; i < pairs.length; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const x0 = pageLeft + c * cellW;
    const y0 = y + r * rowH;
    if (c > 0) {
      doc
        .strokeColor(COLORS.border)
        .lineWidth(0.4)
        .moveTo(x0, y0)
        .lineTo(x0, y0 + rowH)
        .stroke();
    }
    if (r > 0) {
      doc
        .strokeColor(COLORS.border)
        .lineWidth(0.4)
        .moveTo(x0, y0)
        .lineTo(x0 + cellW, y0)
        .stroke();
    }
    const [label, value] = pairs[i]!;
    doc
      .font(FONTS.regular)
      .fontSize(7.5)
      .fillColor(COLORS.textMuted)
      .text(label.toUpperCase(), x0 + 8, y0 + 5, {
        width: cellW - 16,
        characterSpacing: 0.5,
        lineBreak: false,
      });
    doc
      .font(FONTS.bold)
      .fontSize(10)
      .fillColor(COLORS.textPrimary)
      .text(value, x0 + 8, y0 + 14, {
        width: cellW - 16,
        lineBreak: false,
        ellipsis: true,
      });
  }
  return y + rowH * rows + 12;
}
