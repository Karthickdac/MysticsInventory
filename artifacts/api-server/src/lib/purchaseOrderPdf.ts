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

export interface PurchaseOrderPdfSupplier {
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  gstNumber: string | null;
  address: string | null;
}

export interface PurchaseOrderPdfWarehouse {
  name: string;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

export interface PurchaseOrderPdfLine {
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

export interface PurchaseOrderPdfHeader {
  orderNumber: string;
  status: string;
  orderDate: string;
  expectedDeliveryDate: string | null;
  notes: string | null;
  subtotal: number | string;
  taxTotal: number | string;
  total: number | string;
}

export interface RenderPurchaseOrderInput {
  org: DocOrg;
  supplier: PurchaseOrderPdfSupplier;
  shipTo: PurchaseOrderPdfWarehouse;
  order: PurchaseOrderPdfHeader;
  lines: PurchaseOrderPdfLine[];
  logoBuffer: Buffer | null;
}

function supplierToParty(s: PurchaseOrderPdfSupplier): DocParty {
  return {
    name: s.name,
    company: s.company,
    email: s.email,
    phone: s.phone,
    gstNumber: s.gstNumber,
    addressLines: s.address ? s.address.split("\n") : [],
  };
}

function warehouseToParty(w: PurchaseOrderPdfWarehouse): DocParty {
  const addr: string[] = [];
  if (w.addressLine1) addr.push(w.addressLine1);
  const cityLine = [w.city, w.state, w.country].filter(Boolean).join(", ");
  if (cityLine) addr.push(cityLine);
  return { name: w.name, addressLines: addr };
}

const COLUMNS: Column[] = [
  { label: "#", width: 22, align: "right" },
  { label: "Item", width: 200 },
  { label: "HSN", width: 50 },
  { label: "Qty", width: 40, align: "right" },
  { label: "Rate", width: 60, align: "right" },
  { label: "Taxable", width: 65, align: "right" },
  { label: "Tax", width: 60, align: "right" },
  { label: "Total", width: 66, align: "right" },
];

export async function renderPurchaseOrderPdf(
  input: RenderPurchaseOrderInput,
): Promise<Buffer> {
  const { org, supplier, shipTo, order, lines, logoBuffer } = input;
  const { doc, done, pageLeft, pageRight, pageWidth } = createPdfDoc({
    title: `Purchase Order ${order.orderNumber}`,
    author: org.name,
    subject: `Purchase order to ${supplier.name}`,
  });

  const metaPairs: Array<[string, string]> = [
    ["PO #", order.orderNumber],
    ["Date", fmtDate(order.orderDate)],
  ];
  if (order.expectedDeliveryDate) {
    metaPairs.push(["Deliver by", fmtDate(order.expectedDeliveryDate)]);
  }
  metaPairs.push(["Status", order.status.replace(/_/g, " ").toUpperCase()]);

  let y = drawHeaderBand({
    doc,
    org,
    logoBuffer,
    documentTitle: "PURCHASE ORDER",
    documentSubtitle: null,
    metaPairs,
    pageLeft,
    pageRight,
  });

  y = drawPartyBoxes({
    doc,
    y,
    pageLeft,
    pageWidth,
    left: { label: "Supplier", party: supplierToParty(supplier) },
    right: { label: "Ship to", party: warehouseToParty(shipTo) },
  });

  const tableTotalWidth = COLUMNS.reduce((s, c) => s + c.width, 0);
  const tableStartX =
    pageLeft + Math.max(0, Math.floor((pageWidth - tableTotalWidth) / 2));
  y = drawTableHeader(doc, COLUMNS, tableStartX, y);

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const subtext = [l.sku, l.description]
      .map((s) => (s ?? "").trim())
      .filter(Boolean)
      .join(" — ");
    const values = [
      String(i + 1),
      l.itemName,
      (l.hsnCode ?? "").trim() || "—",
      fmtQty(toNum(l.quantity)),
      fmtMoney(toNum(l.unitPrice)),
      fmtMoney(toNum(l.lineSubtotal)),
      `${fmtMoney(toNum(l.lineTax))}\n@${toNum(l.taxRate).toFixed(1)}%`,
      fmtMoney(toNum(l.lineTotal)),
    ];
    y = ensureRoom(doc, 32, tableStartX, COLUMNS, y);
    y = drawTextRow({
      doc,
      cols: COLUMNS,
      values,
      startX: tableStartX,
      y,
      subtext: subtext ? { colIdx: 1, text: subtext } : undefined,
      shaded: i % 2 === 1,
    });
  }

  const subtotal = toNum(order.subtotal);
  const taxTotal = toNum(order.taxTotal);
  const total = toNum(order.total);
  const total_ = (
    label: string,
    value: string,
    opts?: { emphasized?: boolean; muted?: boolean },
  ) => {
    y = ensureRoom(doc, 24, tableStartX, COLUMNS, y);
    y = drawTotalsLine({
      doc,
      cols: COLUMNS,
      startX: tableStartX,
      y,
      label,
      value,
      emphasized: opts?.emphasized,
      muted: opts?.muted,
    });
  };
  total_("Subtotal", fmtMoney(subtotal));
  if (Math.abs(taxTotal) > 0.005) total_("Total tax", fmtMoney(taxTotal));
  total_("Grand total (INR)", fmtMoney(total), { emphasized: true });

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

  if (y > doc.page.height - PAGE.margin - 90) {
    doc.addPage();
    y = PAGE.margin;
  }
  drawSignatureBlock(doc, org.name, pageRight, y + 8);

  if (order.status === "draft") drawStatusStamp(doc, "DRAFT");
  else if (order.status === "cancelled") drawStatusStamp(doc, "CANCELLED");

  paginate(doc, org, `Purchase Order ${order.orderNumber}`);
  doc.end();
  return done;
}
