import { toNum } from "./numeric";
import {
  COLORS,
  FONTS,
  PAGE,
  createPdfDoc,
  drawHeaderBand,
  drawNotesBlock,
  drawPartyBoxes,
  drawSignatureBlock,
  drawStatusStamp,
  drawTableHeader,
  drawTextRow,
  drawTotalsLine,
  ensureRoom,
  fmtDate,
  fmtQty,
  paginate,
  type Column,
  type DocOrg,
  type DocParty,
} from "./pdfDesign";

export interface StockTransferWarehouseRef {
  name: string;
  code: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

export interface StockTransferPdfLine {
  itemName: string;
  sku: string;
  variantOptions: Record<string, string> | null;
  quantity: number | string;
}

export interface StockTransferPdfHeader {
  transferNumber: string;
  transferDate: string;
  status: string;
  notes: string | null;
}

export interface RenderStockTransferInput {
  org: DocOrg;
  transfer: StockTransferPdfHeader;
  fromWarehouse: StockTransferWarehouseRef;
  toWarehouse: StockTransferWarehouseRef;
  lines: StockTransferPdfLine[];
  logoBuffer: Buffer | null;
}

function warehouseToParty(w: StockTransferWarehouseRef): DocParty {
  const addr: string[] = [];
  if (w.addressLine1) addr.push(w.addressLine1);
  const cityLine = [w.city, w.state, w.country].filter(Boolean).join(", ");
  if (cityLine) addr.push(cityLine);
  const extras: string[] = [];
  if (w.code) extras.push(`Code: ${w.code}`);
  return { name: w.name, addressLines: addr, extraLines: extras };
}

const COLUMNS: Column[] = [
  { label: "#", width: 28, align: "right" },
  { label: "Item", width: 280 },
  { label: "SKU", width: 110 },
  { label: "Qty dispatched", width: 105, align: "right" },
];

function variantSummary(v: Record<string, string> | null): string {
  if (!v) return "";
  const entries = Object.entries(v);
  if (entries.length === 0) return "";
  return entries.map(([k, val]) => `${k}: ${val}`).join(" · ");
}

export async function renderStockTransferPdf(
  input: RenderStockTransferInput,
): Promise<Buffer> {
  const { org, transfer, fromWarehouse, toWarehouse, lines, logoBuffer } =
    input;
  const { doc, done, pageLeft, pageRight, pageWidth } = createPdfDoc({
    title: `Dispatch Slip ${transfer.transferNumber}`,
    author: org.name,
    subject: `Internal stock transfer ${transfer.transferNumber}`,
  });

  const metaPairs: Array<[string, string]> = [
    ["Slip #", transfer.transferNumber],
    ["Date", fmtDate(transfer.transferDate)],
    ["Status", transfer.status.replace(/_/g, " ").toUpperCase()],
  ];

  let y = drawHeaderBand({
    doc,
    org,
    logoBuffer,
    documentTitle: "DISPATCH SLIP",
    documentSubtitle: "Internal stock transfer · not for sale",
    metaPairs,
    pageLeft,
    pageRight,
  });

  y = drawPartyBoxes({
    doc,
    y,
    pageLeft,
    pageWidth,
    left: { label: "From warehouse", party: warehouseToParty(fromWarehouse) },
    right: { label: "To warehouse", party: warehouseToParty(toWarehouse) },
  });

  const tableTotalWidth = COLUMNS.reduce((s, c) => s + c.width, 0);
  const tableStartX =
    pageLeft + Math.max(0, Math.floor((pageWidth - tableTotalWidth) / 2));
  y = drawTableHeader(doc, COLUMNS, tableStartX, y);

  let totalQty = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const qty = toNum(l.quantity);
    totalQty += qty;
    const variant = variantSummary(l.variantOptions);
    const values = [String(i + 1), l.itemName, l.sku, fmtQty(qty)];
    y = ensureRoom(doc, 28, tableStartX, COLUMNS, y);
    y = drawTextRow({
      doc,
      cols: COLUMNS,
      values,
      startX: tableStartX,
      y,
      subtext: variant ? { colIdx: 1, text: variant } : undefined,
      shaded: i % 2 === 1,
    });
  }
  y = ensureRoom(doc, 24, tableStartX, COLUMNS, y);
  y = drawTotalsLine({
    doc,
    cols: COLUMNS,
    startX: tableStartX,
    y,
    label: "Total quantity",
    value: fmtQty(totalQty),
    emphasized: true,
  });

  if (transfer.notes) {
    y += 8;
    if (y > doc.page.height - PAGE.margin - 80) {
      doc.addPage();
      y = PAGE.margin;
    }
    y = drawNotesBlock(doc, "Notes", transfer.notes, pageLeft, pageWidth, y);
  }

  if (y > doc.page.height - PAGE.margin - 110) {
    doc.addPage();
    y = PAGE.margin;
  }
  // Two-up signature: dispatched-by left, received-by right.
  const sigY = y + 14;
  const halfW = (pageWidth - 24) / 2;
  doc
    .font(FONTS.regular)
    .fontSize(9)
    .fillColor(COLORS.textBody)
    .text(`Dispatched by · ${fromWarehouse.name}`, pageLeft, sigY, {
      width: halfW,
    });
  doc
    .strokeColor(COLORS.borderStrong)
    .lineWidth(0.5)
    .moveTo(pageLeft, sigY + 56)
    .lineTo(pageLeft + halfW, sigY + 56)
    .stroke();
  doc
    .font(FONTS.regular)
    .fontSize(8)
    .fillColor(COLORS.textMuted)
    .text("Authorised signatory", pageLeft, sigY + 59, { width: halfW });

  const rightX = pageLeft + halfW + 24;
  doc
    .font(FONTS.regular)
    .fontSize(9)
    .fillColor(COLORS.textBody)
    .text(`Received by · ${toWarehouse.name}`, rightX, sigY, {
      width: halfW,
      align: "right",
    });
  doc
    .strokeColor(COLORS.borderStrong)
    .lineWidth(0.5)
    .moveTo(rightX, sigY + 56)
    .lineTo(rightX + halfW, sigY + 56)
    .stroke();
  doc
    .font(FONTS.regular)
    .fontSize(8)
    .fillColor(COLORS.textMuted)
    .text("Authorised signatory", rightX, sigY + 59, {
      width: halfW,
      align: "right",
    });

  if (transfer.status === "draft") drawStatusStamp(doc, "DRAFT");
  else if (transfer.status === "cancelled") drawStatusStamp(doc, "CANCELLED");

  paginate(doc, org, `Dispatch Slip ${transfer.transferNumber}`);
  doc.end();
  return done;
}
