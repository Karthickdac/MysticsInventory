import { toNum } from "./numeric";
import { rupeesInWords } from "./numberToWords";
import {
  COLORS,
  FONTS,
  PAGE,
  createPdfDoc,
  drawHeaderBand,
  drawInfoGrid,
  drawNotesBlock,
  drawPartyBoxes,
  drawSectionTitle,
  drawSignatureBlock,
  drawTableHeader,
  drawTextRow,
  drawTotalsLine,
  ensureRoom,
  fmtDate,
  fmtMoney,
  paginate,
  type Column,
  type DocOrg,
  type DocParty,
} from "./pdfDesign";

export interface PaymentReceiptParty {
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  gstNumber: string | null;
  address: string | null;
}

export interface PaymentReceiptAllocation {
  orderNumber: string;
  orderTotal: number | string;
  orderBalanceDue: number | string;
  amount: number | string;
}

export interface PaymentReceiptHeader {
  receiptNumber: string;
  paymentDate: string;
  amount: number | string;
  mode: string;
  referenceNumber: string | null;
  bankAccountLabel: string | null;
  notes: string | null;
}

export interface RenderPaymentReceiptInput {
  org: DocOrg;
  customer: PaymentReceiptParty;
  payment: PaymentReceiptHeader;
  allocations: PaymentReceiptAllocation[];
  logoBuffer: Buffer | null;
}

function partyOf(p: PaymentReceiptParty): DocParty {
  return {
    name: p.name,
    company: p.company,
    email: p.email,
    phone: p.phone,
    gstNumber: p.gstNumber,
    addressLines: p.address ? p.address.split("\n") : [],
  };
}

function selfParty(org: DocOrg): DocParty {
  const addr: string[] = [];
  if (org.addressLine1) addr.push(org.addressLine1);
  if (org.addressLine2) addr.push(org.addressLine2);
  const cityLine = [org.city, org.state, org.postalCode]
    .filter(Boolean)
    .join(", ");
  if (cityLine) addr.push(cityLine);
  if (org.country) addr.push(org.country);
  return {
    name: org.name,
    gstNumber: org.gstNumber,
    addressLines: addr,
  };
}

const ALLOC_COLS: Column[] = [
  { label: "#", width: 24, align: "right" },
  { label: "Sales order", width: 130 },
  { label: "Order total", width: 110, align: "right" },
  { label: "Balance after", width: 110, align: "right" },
  { label: "Amount applied", width: 149, align: "right" },
];

export async function renderPaymentReceiptPdf(
  input: RenderPaymentReceiptInput,
): Promise<Buffer> {
  const { org, customer, payment, allocations, logoBuffer } = input;
  const { doc, done, pageLeft, pageRight, pageWidth } = createPdfDoc({
    title: `Payment Receipt ${payment.receiptNumber}`,
    author: org.name,
    subject: `Payment receipt for ${customer.name}`,
  });

  const metaPairs: Array<[string, string]> = [
    ["Receipt #", payment.receiptNumber],
    ["Date", fmtDate(payment.paymentDate)],
    ["Mode", payment.mode.toUpperCase()],
  ];
  if (payment.referenceNumber) {
    metaPairs.push(["Reference", payment.referenceNumber]);
  }

  let y = drawHeaderBand({
    doc,
    org,
    logoBuffer,
    documentTitle: "PAYMENT RECEIPT",
    documentSubtitle: "Customer collection",
    metaPairs,
    pageLeft,
    pageRight,
  });

  y = drawPartyBoxes({
    doc,
    y,
    pageLeft,
    pageWidth,
    left: { label: "Received from", party: partyOf(customer) },
    right: { label: "Received by", party: selfParty(org) },
    height: 96,
  });

  // Big amount-received card
  const amount = toNum(payment.amount);
  const cardH = 56;
  doc
    .save()
    .rect(pageLeft, y, pageWidth, cardH)
    .fill(COLORS.fillSubtle)
    .restore();
  doc
    .strokeColor(COLORS.borderStrong)
    .lineWidth(0.5)
    .rect(pageLeft, y, pageWidth, cardH)
    .stroke();
  doc
    .font(FONTS.bold)
    .fontSize(8)
    .fillColor(COLORS.textMuted)
    .text("AMOUNT RECEIVED", pageLeft + 12, y + 8, {
      width: pageWidth - 24,
      characterSpacing: 0.6,
      lineBreak: false,
    });
  doc
    .font(FONTS.bold)
    .fontSize(22)
    .fillColor(COLORS.textPrimary)
    .text(`Rs. ${fmtMoney(amount)}`, pageLeft + 12, y + 20, {
      width: pageWidth - 24,
      lineBreak: false,
    });
  doc
    .font(FONTS.italic)
    .fontSize(9)
    .fillColor(COLORS.textMuted)
    .text(rupeesInWords(amount), pageLeft + 12, y + 44, {
      width: pageWidth - 24,
      lineBreak: false,
      ellipsis: true,
    });
  y += cardH + 14;

  // Payment method details grid
  const gridPairs: Array<[string, string]> = [
    ["Payment date", fmtDate(payment.paymentDate)],
    ["Payment mode", payment.mode.toUpperCase()],
  ];
  if (payment.referenceNumber) {
    gridPairs.push(["Reference number", payment.referenceNumber]);
  }
  if (payment.bankAccountLabel) {
    gridPairs.push(["Deposited into", payment.bankAccountLabel]);
  }
  y = drawInfoGrid({
    doc,
    pairs: gridPairs,
    pageLeft,
    pageWidth,
    y,
    columns: 2,
  });

  // Allocations
  if (allocations.length > 0) {
    y = drawSectionTitle(doc, "Applied to invoices", pageLeft, pageWidth, y);
    y = drawTableHeader(doc, ALLOC_COLS, pageLeft, y);
    let allocSum = 0;
    for (let i = 0; i < allocations.length; i++) {
      const a = allocations[i]!;
      const values = [
        String(i + 1),
        a.orderNumber,
        fmtMoney(toNum(a.orderTotal)),
        fmtMoney(toNum(a.orderBalanceDue)),
        fmtMoney(toNum(a.amount)),
      ];
      y = ensureRoom(doc, 24, pageLeft, ALLOC_COLS, y);
      y = drawTextRow({
        doc,
        cols: ALLOC_COLS,
        values,
        startX: pageLeft,
        y,
        shaded: i % 2 === 1,
      });
      allocSum += toNum(a.amount);
    }
    y = ensureRoom(doc, 24, pageLeft, ALLOC_COLS, y);
    y = drawTotalsLine({
      doc,
      cols: ALLOC_COLS,
      startX: pageLeft,
      y,
      label: "Total applied",
      value: fmtMoney(allocSum),
      emphasized: true,
    });
    if (Math.abs(amount - allocSum) > 0.005) {
      y = drawTotalsLine({
        doc,
        cols: ALLOC_COLS,
        startX: pageLeft,
        y,
        label: "Unapplied (advance)",
        value: fmtMoney(amount - allocSum),
        muted: true,
      });
    }
    y += 10;
  } else {
    doc
      .font(FONTS.italic)
      .fontSize(9)
      .fillColor(COLORS.textMuted)
      .text(
        "Held as advance — not yet applied to any invoice.",
        pageLeft,
        y,
        { width: pageWidth },
      );
    y = doc.y + 14;
  }

  if (payment.notes) {
    y = drawNotesBlock(doc, "Notes", payment.notes, pageLeft, pageWidth, y);
  }

  if (y > doc.page.height - PAGE.margin - 90) {
    doc.addPage();
    y = PAGE.margin;
  }
  drawSignatureBlock(doc, org.name, pageRight, y + 12);

  paginate(doc, org, `Payment Receipt ${payment.receiptNumber}`);
  doc.end();
  return done;
}
