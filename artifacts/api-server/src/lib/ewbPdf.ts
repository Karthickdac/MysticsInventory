import PDFDocument from "pdfkit";
import QRCode from "qrcode";

export interface EwbPdfOrg {
  name: string;
  gstNumber: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}

export interface EwbPdfOrder {
  orderNumber: string;
  orderDate: string;
  total: number;
  subtotal: number;
  taxTotal: number;
}

export interface EwbPdfDetails {
  number: string;
  date: Date | null;
  validUntil: Date | null;
  status: string | null;
  qrPayload: string | null;
  vehicleNumber: string | null;
  transportMode: string | null;
  transporterName: string | null;
  transporterId: string | null;
  distanceKm: number | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
}

export interface EwbPdfLine {
  name: string;
  sku: string;
  hsn: string | null;
  unit: string;
  qty: number;
  rate: number;
  taxableAmount: number;
  total: number;
}

export interface EwbPdfCustomer {
  name: string;
  company: string | null;
  gstNumber: string | null;
}

export interface RenderEwbPdfInput {
  org: EwbPdfOrg;
  order: EwbPdfOrder;
  ewb: EwbPdfDetails;
  customer: EwbPdfCustomer;
  dispatchAddress: Record<string, unknown> | null;
  shipToAddress: Record<string, unknown> | null;
  lines: EwbPdfLine[];
}

const TRANSPORT_MODE_LABELS: Record<string, string> = {
  "1": "Road",
  "2": "Rail",
  "3": "Air",
  "4": "Ship",
};

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${day}/${month}/${year} ${hh}:${mm}`;
}

function fmtAmount(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function addressLine(addr: Record<string, unknown> | null): string[] {
  if (!addr) return ["—"];
  const lines: string[] = [];
  const get = (k: string): string => {
    const v = addr[k];
    return typeof v === "string" ? v.trim() : "";
  };
  if (get("legalName")) lines.push(get("legalName"));
  const street = [get("addressLine1"), get("addressLine2")]
    .filter(Boolean)
    .join(", ");
  if (street) lines.push(street);
  const cityLine = [get("city"), get("pincode")].filter(Boolean).join(" - ");
  if (cityLine) lines.push(cityLine);
  if (typeof addr["stateCode"] === "number") {
    lines.push(`State code: ${addr["stateCode"]}`);
  }
  if (get("gstin")) lines.push(`GSTIN: ${get("gstin")}`);
  return lines.length ? lines : ["—"];
}

export async function renderEwbPdf(input: RenderEwbPdfInput): Promise<Buffer> {
  const qrPng = input.ewb.qrPayload
    ? await QRCode.toBuffer(input.ewb.qrPayload, {
        margin: 0,
        width: 140,
        errorCorrectionLevel: "M",
      })
    : null;

  return await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 36,
      info: {
        Title: `E-way Bill ${input.ewb.number}`,
        Author: input.org.name,
      },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const left = doc.page.margins.left;

    // ── Header ───────────────────────────────────────────────────────
    doc
      .fontSize(16)
      .font("Helvetica-Bold")
      .text("E-WAY BILL", left, doc.y, { align: "left", width: pageWidth });
    doc.moveDown(0.2);
    doc
      .fontSize(9)
      .font("Helvetica")
      .fillColor("#555")
      .text(
        "Generated under Rule 138 of CGST Rules, 2017",
        left,
        doc.y,
        { width: pageWidth },
      )
      .fillColor("#000");

    // Cancelled banner
    if (input.ewb.status === "cancelled") {
      doc.moveDown(0.6);
      doc
        .rect(left, doc.y, pageWidth, 22)
        .fillAndStroke("#fee2e2", "#dc2626");
      doc
        .fillColor("#991b1b")
        .font("Helvetica-Bold")
        .fontSize(11)
        .text(
          `CANCELLED  ·  ${fmtDate(input.ewb.cancelledAt)}${
            input.ewb.cancelReason ? `  ·  ${input.ewb.cancelReason}` : ""
          }`,
          left + 8,
          doc.y - 16,
          { width: pageWidth - 16 },
        )
        .fillColor("#000");
      doc.moveDown(0.5);
    }

    // ── EWB summary block + QR side-by-side ──────────────────────────
    doc.moveDown(0.6);
    const summaryTop = doc.y;
    const qrBoxWidth = 150;
    const summaryWidth = pageWidth - qrBoxWidth - 12;
    const labelValue = (label: string, value: string, indent = 0) => {
      doc.font("Helvetica-Bold").fontSize(8).fillColor("#666")
        .text(label.toUpperCase(), left + indent, doc.y, {
          width: summaryWidth - indent,
          continued: false,
        });
      doc.font("Helvetica").fontSize(11).fillColor("#000")
        .text(value || "—", left + indent, doc.y, {
          width: summaryWidth - indent,
        });
      doc.moveDown(0.25);
    };
    doc.y = summaryTop;
    labelValue("E-way Bill No", input.ewb.number);
    labelValue("Generated On", fmtDate(input.ewb.date));
    labelValue("Valid Until", fmtDate(input.ewb.validUntil));
    labelValue(
      "Document",
      `Invoice ${input.order.orderNumber}  ·  ${input.order.orderDate}`,
    );
    const summaryEnd = doc.y;

    if (qrPng) {
      doc.image(qrPng, left + pageWidth - 140, summaryTop, {
        fit: [140, 140],
      });
      doc
        .font("Helvetica")
        .fontSize(7)
        .fillColor("#666")
        .text("Scan to verify", left + pageWidth - 140, summaryTop + 142, {
          width: 140,
          align: "center",
        })
        .fillColor("#000");
    }
    doc.y = Math.max(summaryEnd, summaryTop + 160);

    // ── From / To addresses ──────────────────────────────────────────
    doc.moveDown(0.5);
    drawTwoColumnBlock(doc, left, pageWidth, "Dispatched From", "Ship To", [
      addressLine(input.dispatchAddress),
      addressLine(input.shipToAddress),
    ]);

    // ── Transport details ────────────────────────────────────────────
    doc.moveDown(0.6);
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor("#000")
      .text("Transport Details", left, doc.y, { width: pageWidth });
    doc.moveDown(0.3);
    const transRows: Array<[string, string]> = [
      [
        "Mode",
        input.ewb.transportMode
          ? TRANSPORT_MODE_LABELS[input.ewb.transportMode] ?? input.ewb.transportMode
          : "—",
      ],
      ["Vehicle No", input.ewb.vehicleNumber ?? "—"],
      ["Distance (km)", input.ewb.distanceKm ? String(input.ewb.distanceKm) : "—"],
      ["Transporter", input.ewb.transporterName ?? "—"],
      ["Transporter ID", input.ewb.transporterId ?? "—"],
    ];
    drawKeyValueGrid(doc, left, pageWidth, transRows);

    // ── Item table ───────────────────────────────────────────────────
    doc.moveDown(0.8);
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Items", left, doc.y, { width: pageWidth });
    doc.moveDown(0.3);
    drawItemsTable(doc, left, pageWidth, input.lines);

    // ── Totals ───────────────────────────────────────────────────────
    doc.moveDown(0.6);
    const totalsX = left + pageWidth - 220;
    const drawTotalLine = (label: string, value: string, bold = false) => {
      doc
        .font(bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(bold ? 11 : 10)
        .text(label, totalsX, doc.y, { width: 120, continued: true })
        .text(value, { width: 100, align: "right" });
      doc.moveDown(0.2);
    };
    drawTotalLine("Subtotal", `INR ${fmtAmount(input.order.subtotal)}`);
    drawTotalLine("Tax", `INR ${fmtAmount(input.order.taxTotal)}`);
    drawTotalLine("Total", `INR ${fmtAmount(input.order.total)}`, true);

    // ── Footer ───────────────────────────────────────────────────────
    const footerY = doc.page.height - doc.page.margins.bottom - 28;
    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor("#888")
      .text(
        `Issued by ${input.org.name}${
          input.org.gstNumber ? ` (GSTIN ${input.org.gstNumber})` : ""
        }. This is a system-generated copy of the e-way bill registered with the National Informatics Centre.`,
        left,
        footerY,
        { width: pageWidth, align: "center" },
      )
      .fillColor("#000");

    doc.end();
  });
}

function drawTwoColumnBlock(
  doc: PDFKit.PDFDocument,
  left: number,
  pageWidth: number,
  leftHeading: string,
  rightHeading: string,
  columns: [string[], string[]],
): void {
  const colWidth = (pageWidth - 12) / 2;
  const startY = doc.y;
  const drawCol = (heading: string, lines: string[], x: number) => {
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor("#666")
      .text(heading.toUpperCase(), x, startY, { width: colWidth });
    doc.font("Helvetica").fontSize(10).fillColor("#000");
    let cursor = doc.y;
    for (const ln of lines) {
      doc.text(ln, x, cursor, { width: colWidth });
      cursor = doc.y;
    }
    return cursor;
  };
  const leftEnd = drawCol(leftHeading, columns[0], left);
  const rightEnd = drawCol(rightHeading, columns[1], left + colWidth + 12);
  doc.y = Math.max(leftEnd, rightEnd);
}

function drawKeyValueGrid(
  doc: PDFKit.PDFDocument,
  left: number,
  pageWidth: number,
  rows: Array<[string, string]>,
): void {
  const colWidth = pageWidth / 2 - 6;
  let cursor = doc.y;
  rows.forEach(([k, v], idx) => {
    const col = idx % 2;
    const x = left + col * (colWidth + 12);
    if (col === 0 && idx > 0) cursor = doc.y;
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#666")
      .text(k.toUpperCase(), x, cursor, { width: colWidth });
    doc.font("Helvetica").fontSize(10).fillColor("#000")
      .text(v, x, cursor + 10, { width: colWidth });
    if (col === 1 || idx === rows.length - 1) {
      doc.moveDown(1.2);
    }
  });
}

function drawItemsTable(
  doc: PDFKit.PDFDocument,
  left: number,
  pageWidth: number,
  lines: EwbPdfLine[],
): void {
  const cols: Array<{ label: string; w: number; align?: "left" | "right" }> = [
    { label: "Item", w: 0.32 },
    { label: "HSN", w: 0.1 },
    { label: "Qty", w: 0.1, align: "right" },
    { label: "Unit", w: 0.08 },
    { label: "Rate", w: 0.13, align: "right" },
    { label: "Taxable", w: 0.13, align: "right" },
    { label: "Total", w: 0.14, align: "right" },
  ];
  const colWidths = cols.map((c) => c.w * pageWidth);
  const headerY = doc.y;
  doc.rect(left, headerY, pageWidth, 18).fill("#f3f4f6").fillColor("#000");
  let x = left;
  cols.forEach((c, i) => {
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor("#374151")
      .text(c.label, x + 4, headerY + 5, {
        width: colWidths[i]! - 8,
        align: c.align ?? "left",
      });
    x += colWidths[i]!;
  });
  doc.fillColor("#000");
  doc.y = headerY + 20;

  for (const line of lines) {
    const rowY = doc.y;
    let cx = left;
    const cells: Array<{ text: string; align?: "left" | "right" }> = [
      { text: `${line.name}${line.sku ? `\n${line.sku}` : ""}` },
      { text: line.hsn ?? "—" },
      { text: String(line.qty), align: "right" },
      { text: line.unit },
      { text: fmtAmount(line.rate), align: "right" },
      { text: fmtAmount(line.taxableAmount), align: "right" },
      { text: fmtAmount(line.total), align: "right" },
    ];
    let maxH = 12;
    cells.forEach((cell, i) => {
      const w = colWidths[i]!;
      const h = doc.heightOfString(cell.text, { width: w - 8 });
      if (h > maxH) maxH = h;
      cx += w;
    });
    cx = left;
    cells.forEach((cell, i) => {
      const w = colWidths[i]!;
      doc
        .font("Helvetica")
        .fontSize(9)
        .text(cell.text, cx + 4, rowY + 4, {
          width: w - 8,
          align: cell.align ?? "left",
        });
      cx += w;
    });
    doc.y = rowY + maxH + 8;
    doc
      .strokeColor("#e5e7eb")
      .lineWidth(0.5)
      .moveTo(left, doc.y - 2)
      .lineTo(left + pageWidth, doc.y - 2)
      .stroke()
      .strokeColor("#000");
  }
}
