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

export interface SupplierPaymentParty {
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  gstNumber: string | null;
  address: string | null;
}

export interface SupplierPaymentAllocation {
  orderNumber: string;
  orderTotal: number | string;
  orderBalanceDue: number | string;
  amount: number | string;
}

export interface SupplierPaymentHeader {
  voucherNumber: string;
  paymentDate: string;
  amount: number | string;
  mode: string;
  referenceNumber: string | null;
  bankAccountLabel: string | null;
  notes: string | null;
}

export interface RenderSupplierPaymentInput {
  org: DocOrg;
  supplier: SupplierPaymentParty;
  payment: SupplierPaymentHeader;
  allocations: SupplierPaymentAllocation[];
  logoBuffer: Buffer | null;
}

function partyOf(p: SupplierPaymentParty): DocParty {
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
  { label: "Purchase order", width: 130 },
  { label: "Order total", width: 110, align: "right" },
  { label: "Balance after", width: 110, align: "right" },
  { label: "Amount applied", width: 149, align: "right" },
];

export async function renderSupplierPaymentPdf(
  input: RenderSupplierPaymentInput,
): Promise<Buffer> {
  const { org, supplier, payment, allocations, logoBuffer } = input;
  const { doc, done, pageLeft, pageRight, pageWidth } = createPdfDoc({
    title: `Payment Voucher ${payment.voucherNumber}`,
    author: org.name,
    subject: `Payment voucher for ${supplier.name}`,
  });

  const metaPairs: Array<[string, string]> = [
    ["Voucher #", payment.voucherNumber],
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
    documentTitle: "PAYMENT VOUCHER",
    documentSubtitle: "Supplier disbursement",
    metaPairs,
    pageLeft,
    pageRight,
  });

  y = drawPartyBoxes({
    doc,
    y,
    pageLeft,
    pageWidth,
    left: { label: "Paid to", party: partyOf(supplier) },
    right: { label: "Paid by", party: selfParty(org) },
    height: 96,
  });

  // Big amount-paid card
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
    .text("AMOUNT PAID", pageLeft + 12, y + 8, {
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

  const gridPairs: Array<[string, string]> = [
    ["Payment date", fmtDate(payment.paymentDate)],
    ["Payment mode", payment.mode.toUpperCase()],
  ];
  if (payment.referenceNumber) {
    gridPairs.push(["Reference number", payment.referenceNumber]);
  }
  if (payment.bankAccountLabel) {
    gridPairs.push(["Drawn from", payment.bankAccountLabel]);
  }
  y = drawInfoGrid({
    doc,
    pairs: gridPairs,
    pageLeft,
    pageWidth,
    y,
    columns: 2,
  });

  if (allocations.length > 0) {
    y = drawSectionTitle(doc, "Applied to bills", pageLeft, pageWidth, y);
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
        "Held as advance — not yet applied to any bill.",
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

  paginate(doc, org, `Payment Voucher ${payment.voucherNumber}`);
  doc.end();
  return done;
}
