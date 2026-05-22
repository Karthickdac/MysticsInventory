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

export interface SalesOrderAckCustomer {
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  gstNumber: string | null;
  billingAddress: string | null;
  shippingAddress: string | null;
  placeOfSupply: string | null;
}

export interface SalesOrderAckLine {
  itemName: string;
  sku: string;
  description: string | null;
  hsnCode: string | null;
  quantity: number | string;
  unitPrice: number | string;
  taxRate: number | string;
  discountPercent?: number | string | null;
  discountAmount?: number | string | null;
  lineSubtotal: number | string;
  lineTax: number | string;
  lineTotal: number | string;
}

export interface SalesOrderAckHeader {
  orderNumber: string;
  status: string;
  orderDate: string;
  expectedShipDate: string | null;
  notes: string | null;
  subtotal: number | string;
  taxTotal: number | string;
  total: number | string;
}

export interface RenderSalesOrderAckInput {
  org: DocOrg;
  customer: SalesOrderAckCustomer;
  order: SalesOrderAckHeader;
  lines: SalesOrderAckLine[];
  logoBuffer: Buffer | null;
}

function customerToParty(c: SalesOrderAckCustomer, ship = false): DocParty {
  const addr = ship ? c.shippingAddress ?? c.billingAddress : c.billingAddress;
  const extras: string[] = [];
  if (ship && c.placeOfSupply) {
    extras.push(`Place of supply: ${c.placeOfSupply}`);
  }
  return {
    name: c.name,
    company: c.company,
    email: ship ? null : c.email,
    phone: ship ? null : c.phone,
    gstNumber: ship ? null : c.gstNumber,
    addressLines: addr ? addr.split("\n") : [],
    extraLines: extras,
  };
}

const COLUMNS: Column[] = [
  { label: "#", width: 22, align: "right" },
  { label: "Item", width: 168 },
  { label: "HSN", width: 48 },
  { label: "Qty", width: 38, align: "right" },
  { label: "Rate", width: 58, align: "right" },
  { label: "Disc", width: 52, align: "right" },
  { label: "Taxable", width: 58, align: "right" },
  { label: "Tax", width: 57, align: "right" },
  { label: "Total", width: 62, align: "right" },
];

export async function renderSalesOrderAckPdf(
  input: RenderSalesOrderAckInput,
): Promise<Buffer> {
  const { org, customer, order, lines, logoBuffer } = input;
  const { doc, done, pageLeft, pageRight, pageWidth } = createPdfDoc({
    title: `Order Acknowledgement ${order.orderNumber}`,
    author: org.name,
    subject: `Order acknowledgement for ${customer.name}`,
  });

  const metaPairs: Array<[string, string]> = [
    ["Order #", order.orderNumber],
    ["Date", fmtDate(order.orderDate)],
  ];
  if (order.expectedShipDate) {
    metaPairs.push(["Expected ship", fmtDate(order.expectedShipDate)]);
  }
  metaPairs.push(["Status", order.status.replace(/_/g, " ").toUpperCase()]);

  let y = drawHeaderBand({
    doc,
    org,
    logoBuffer,
    documentTitle: "ORDER ACKNOWLEDGEMENT",
    documentSubtitle: "Not a tax invoice",
    metaPairs,
    pageLeft,
    pageRight,
  });

  y = drawPartyBoxes({
    doc,
    y,
    pageLeft,
    pageWidth,
    left: { label: "Bill to", party: customerToParty(customer, false) },
    right: { label: "Ship to", party: customerToParty(customer, true) },
  });

  const tableTotalWidth = COLUMNS.reduce((s, c) => s + c.width, 0);
  const tableStartX =
    pageLeft + Math.max(0, Math.floor((pageWidth - tableTotalWidth) / 2));
  y = drawTableHeader(doc, COLUMNS, tableStartX, y);

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const discAmt = toNum(l.discountAmount ?? 0);
    const discPct = toNum(l.discountPercent ?? 0);
    const discCell =
      discAmt > 0
        ? discPct > 0
          ? `-${fmtMoney(discAmt)}\n(${discPct.toFixed(1)}%)`
          : `-${fmtMoney(discAmt)}`
        : "—";
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
      discCell,
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
    opts?: { emphasized?: boolean },
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

  paginate(doc, org, `Order Acknowledgement ${order.orderNumber}`);
  doc.end();
  return done;
}
