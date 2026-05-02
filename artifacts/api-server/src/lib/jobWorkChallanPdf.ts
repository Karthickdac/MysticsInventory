import { toNum } from "./numeric";
import {
  COLORS,
  FONTS,
  PAGE,
  createPdfDoc,
  drawHeaderBand,
  drawNotesBlock,
  drawPartyBoxes,
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

export interface JwoChallanSupplier {
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  gstNumber: string | null;
  address: string | null;
}

export interface JwoChallanWarehouse {
  name: string;
  code: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

export interface JwoChallanComponent {
  itemName: string;
  sku: string;
  quantity: number | string;
}

export interface JwoChallanHeader {
  jwoNumber: string;
  outputItemName: string;
  outputItemSku: string;
}

export interface JwoChallanIssue {
  issueNumber: string;
  issueDate: string;
  notes: string | null;
}

export interface RenderJwoChallanInput {
  org: DocOrg;
  jobWorker: JwoChallanSupplier;
  fromWarehouse: JwoChallanWarehouse;
  jwo: JwoChallanHeader;
  issue: JwoChallanIssue;
  components: JwoChallanComponent[];
  logoBuffer: Buffer | null;
}

function workerToParty(s: JwoChallanSupplier): DocParty {
  return {
    name: s.name,
    company: s.company,
    email: s.email,
    phone: s.phone,
    gstNumber: s.gstNumber,
    addressLines: s.address ? s.address.split("\n") : [],
  };
}

function warehouseToParty(w: JwoChallanWarehouse): DocParty {
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
  { label: "Component", width: 270 },
  { label: "SKU", width: 110 },
  { label: "Qty issued", width: 115, align: "right" },
];

export async function renderJwoChallanPdf(
  input: RenderJwoChallanInput,
): Promise<Buffer> {
  const { org, jobWorker, fromWarehouse, jwo, issue, components, logoBuffer } =
    input;
  const { doc, done, pageLeft, pageRight, pageWidth } = createPdfDoc({
    title: `Delivery Challan ${issue.issueNumber}`,
    author: org.name,
    subject: `Delivery challan for ${jobWorker.name}`,
  });

  const metaPairs: Array<[string, string]> = [
    ["Challan #", issue.issueNumber],
    ["Date", fmtDate(issue.issueDate)],
    ["Job work order", jwo.jwoNumber],
    ["For output", `${jwo.outputItemName} (${jwo.outputItemSku})`],
  ];

  let y = drawHeaderBand({
    doc,
    org,
    logoBuffer,
    documentTitle: "DELIVERY CHALLAN",
    documentSubtitle: "Goods sent for job work · not a sale",
    metaPairs,
    pageLeft,
    pageRight,
  });

  y = drawPartyBoxes({
    doc,
    y,
    pageLeft,
    pageWidth,
    left: { label: "Dispatched from", party: warehouseToParty(fromWarehouse) },
    right: { label: "Job worker", party: workerToParty(jobWorker) },
  });

  const tableTotalWidth = COLUMNS.reduce((s, c) => s + c.width, 0);
  const tableStartX =
    pageLeft + Math.max(0, Math.floor((pageWidth - tableTotalWidth) / 2));
  y = drawTableHeader(doc, COLUMNS, tableStartX, y);
  let totalQty = 0;
  for (let i = 0; i < components.length; i++) {
    const c = components[i]!;
    const qty = toNum(c.quantity);
    totalQty += qty;
    y = ensureRoom(doc, 28, tableStartX, COLUMNS, y);
    y = drawTextRow({
      doc,
      cols: COLUMNS,
      values: [String(i + 1), c.itemName, c.sku, fmtQty(qty)],
      startX: tableStartX,
      y,
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

  if (issue.notes) {
    y += 8;
    if (y > doc.page.height - PAGE.margin - 80) {
      doc.addPage();
      y = PAGE.margin;
    }
    y = drawNotesBlock(doc, "Notes", issue.notes, pageLeft, pageWidth, y);
  }

  // Statutory note for job-work delivery challans (Rule 55 CGST).
  if (y > doc.page.height - PAGE.margin - 110) {
    doc.addPage();
    y = PAGE.margin;
  }
  y += 6;
  doc
    .font(FONTS.italic)
    .fontSize(8)
    .fillColor(COLORS.textMuted)
    .text(
      "Goods sent on delivery challan for job work under Rule 55 of the CGST Rules. " +
        "Not a tax invoice; ownership of these goods remains with the principal.",
      pageLeft,
      y,
      { width: pageWidth },
    );
  y = doc.y + 12;

  if (y > doc.page.height - PAGE.margin - 90) {
    doc.addPage();
    y = PAGE.margin;
  }
  const sigY = y + 8;
  const halfW = (pageWidth - 24) / 2;
  doc
    .font(FONTS.regular)
    .fontSize(9)
    .fillColor(COLORS.textBody)
    .text(`For ${org.name}`, pageLeft, sigY, { width: halfW });
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
    .text(`Received by · ${jobWorker.name}`, rightX, sigY, {
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
    .text("Signature & date", rightX, sigY + 59, {
      width: halfW,
      align: "right",
    });

  paginate(doc, org, `Delivery Challan ${issue.issueNumber}`);
  doc.end();
  return done;
}
