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

export interface JwoOrderSupplier {
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  gstNumber: string | null;
  address: string | null;
}

export interface JwoOrderWarehouse {
  name: string;
  code: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

export interface JwoOrderComponent {
  itemName: string;
  sku: string;
  quantityPerOutput: number | string;
  totalQuantity: number | string;
}

export interface JwoOrderHeader {
  jwoNumber: string;
  outputItemName: string;
  outputItemSku: string;
  outputQuantity: number | string;
  jobChargeRate: number | string;
  status: string;
  createdAt: string;
  expectedReturnDate: string | null;
  notes: string | null;
}

export interface RenderJwoOrderPdfInput {
  org: DocOrg;
  jobWorker: JwoOrderSupplier;
  sourceWarehouse: JwoOrderWarehouse;
  destWarehouse: JwoOrderWarehouse;
  jwo: JwoOrderHeader;
  components: JwoOrderComponent[];
  logoBuffer: Buffer | null;
}

function workerToParty(s: JwoOrderSupplier): DocParty {
  return {
    name: s.name,
    company: s.company,
    email: s.email,
    phone: s.phone,
    gstNumber: s.gstNumber,
    addressLines: s.address ? s.address.split("\n") : [],
  };
}

function warehouseToParty(w: JwoOrderWarehouse, label?: string): DocParty {
  const addr: string[] = [];
  if (w.addressLine1) addr.push(w.addressLine1);
  const cityLine = [w.city, w.state, w.country].filter(Boolean).join(", ");
  if (cityLine) addr.push(cityLine);
  const extras: string[] = [];
  if (w.code) extras.push(`Code: ${w.code}`);
  return {
    name: label ? `${w.name}` : w.name,
    addressLines: addr,
    extraLines: extras,
  };
}

const COLUMNS: Column[] = [
  { label: "#", width: 28, align: "right" },
  { label: "Component / Raw material", width: 240 },
  { label: "SKU", width: 110 },
  { label: "Per unit", width: 80, align: "right" },
  { label: "Total needed", width: 95, align: "right" },
];

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

export async function renderJwoOrderPdf(
  input: RenderJwoOrderPdfInput,
): Promise<Buffer> {
  const {
    org,
    jobWorker,
    sourceWarehouse,
    destWarehouse,
    jwo,
    components,
    logoBuffer,
  } = input;
  const { doc, done, pageLeft, pageRight, pageWidth } = createPdfDoc({
    title: `Job Work Order ${jwo.jwoNumber}`,
    author: org.name,
    subject: `Job work order for ${jobWorker.name}`,
  });

  const metaPairs: Array<[string, string]> = [
    ["Order #", jwo.jwoNumber],
    ["Status", capitalise(jwo.status)],
    ["Created", fmtDate(jwo.createdAt.slice(0, 10))],
    [
      "Expected return",
      jwo.expectedReturnDate ? fmtDate(jwo.expectedReturnDate) : "—",
    ],
    [
      "Output item",
      `${jwo.outputItemName}${jwo.outputItemSku ? ` (${jwo.outputItemSku})` : ""}`,
    ],
    ["Quantity to produce", fmtQty(toNum(jwo.outputQuantity))],
    ...(toNum(jwo.jobChargeRate) > 0
      ? ([
          [
            "Job charge rate",
            `₹${toNum(jwo.jobChargeRate).toLocaleString("en-IN", { minimumFractionDigits: 2 })} / unit`,
          ],
        ] as Array<[string, string]>)
      : []),
  ];

  let y = drawHeaderBand({
    doc,
    org,
    logoBuffer,
    documentTitle: "JOB WORK ORDER",
    documentSubtitle: `${jwo.outputItemName} — ${fmtQty(toNum(jwo.outputQuantity))} units`,
    metaPairs,
    pageLeft,
    pageRight,
  });

  y = drawPartyBoxes({
    doc,
    y,
    pageLeft,
    pageWidth,
    left: {
      label: "Source warehouse",
      party: warehouseToParty(sourceWarehouse),
    },
    right: { label: "Job worker", party: workerToParty(jobWorker) },
  });

  if (destWarehouse.name !== sourceWarehouse.name) {
    y += 6;
    doc
      .font(FONTS.bold)
      .fontSize(8)
      .fillColor(COLORS.textMuted)
      .text("Destination warehouse:", pageLeft, y);
    y = doc.y + 2;
    doc
      .font(FONTS.regular)
      .fontSize(9)
      .fillColor(COLORS.textBody)
      .text(destWarehouse.name, pageLeft, y);
    y = doc.y + 12;
  }

  const tableTotalWidth = COLUMNS.reduce((s, c) => s + c.width, 0);
  const tableStartX =
    pageLeft + Math.max(0, Math.floor((pageWidth - tableTotalWidth) / 2));

  y += 4;
  doc
    .font(FONTS.bold)
    .fontSize(9)
    .fillColor(COLORS.textBody)
    .text("Raw Materials / Bill of Materials", pageLeft, y);
  y = doc.y + 6;

  y = drawTableHeader(doc, COLUMNS, tableStartX, y);
  let totalQty = 0;
  for (let i = 0; i < components.length; i++) {
    const c = components[i]!;
    const total = toNum(c.totalQuantity);
    totalQty += total;
    y = ensureRoom(doc, 28, tableStartX, COLUMNS, y);
    y = drawTextRow({
      doc,
      cols: COLUMNS,
      values: [
        String(i + 1),
        c.itemName,
        c.sku,
        fmtQty(toNum(c.quantityPerOutput)),
        fmtQty(total),
      ],
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
    label: "Total raw material",
    value: fmtQty(totalQty),
    emphasized: true,
  });

  if (jwo.notes) {
    y += 8;
    if (y > doc.page.height - PAGE.margin - 80) {
      doc.addPage();
      y = PAGE.margin;
    }
    y = drawNotesBlock(doc, "Notes", jwo.notes, pageLeft, pageWidth, y);
  }

  if (y > doc.page.height - PAGE.margin - 90) {
    doc.addPage();
    y = PAGE.margin;
  }
  const sigY = y + 12;
  const halfW = (pageWidth - 24) / 2;
  doc
    .font(FONTS.regular)
    .fontSize(9)
    .fillColor(COLORS.textBody)
    .text(`For ${org.name}`, pageLeft, sigY, { width: halfW });
  doc
    .strokeColor(COLORS.borderStrong)
    .lineWidth(0.5)
    .moveTo(pageLeft, sigY + 48)
    .lineTo(pageLeft + halfW, sigY + 48)
    .stroke();
  doc
    .font(FONTS.regular)
    .fontSize(8)
    .fillColor(COLORS.textMuted)
    .text("Authorised signatory", pageLeft, sigY + 51, { width: halfW });

  const rightX = pageLeft + halfW + 24;
  doc
    .font(FONTS.regular)
    .fontSize(9)
    .fillColor(COLORS.textBody)
    .text(`Acknowledged by · ${jobWorker.name}`, rightX, sigY, {
      width: halfW,
      align: "right",
    });
  doc
    .strokeColor(COLORS.borderStrong)
    .lineWidth(0.5)
    .moveTo(rightX, sigY + 48)
    .lineTo(rightX + halfW, sigY + 48)
    .stroke();
  doc
    .font(FONTS.regular)
    .fontSize(8)
    .fillColor(COLORS.textMuted)
    .text("Signature & date", rightX, sigY + 51, {
      width: halfW,
      align: "right",
    });

  paginate(doc, org, `Job Work Order ${jwo.jwoNumber}`);
  doc.end();
  return done;
}
