// Pure helpers that translate a sales order (already loaded from the
// database) into the shape the IRP / GSP `Generate IRN` endpoint
// expects. Kept separate from `routes/einvoice.ts` so unit tests can
// exercise every validation branch (state-code derivation,
// intra/inter-state CGST/SGST/IGST split, HSN validation, PIN parsing,
// city derivation) without spinning up Express, the DB, or the IRP
// HTTP client.

import {
  EinvoiceApiError,
  type GenerateIrnInput,
  type IrpAddress,
  type IrpItem,
} from "./einvoice";
import {
  gstStateCodeFromGstin,
  gstStateCodeFromName,
} from "./gstStates";

export interface OrderForIrn {
  id: number;
  organizationId: number;
  orderNumber: string;
  orderDate: string;
  status: string;
  irn: string | null;
  irpStatus: string | null;
  irpAckNumber: string | null;
  irpAckDate: Date | null;
  customer: {
    id: number;
    name: string;
    company: string | null;
    gstNumber: string | null;
    billingAddress: string | null;
    shippingAddress: string | null;
    placeOfSupply: string | null;
    email: string | null;
    phone: string | null;
  };
  org: {
    name: string;
    gstNumber: string | null;
    addressLine1: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    eInvoiceGstin: string | null;
  };
  totals: { subtotal: number; tax: number; total: number };
  lines: Array<{
    itemId: number;
    name: string;
    sku: string;
    description: string | null;
    hsnCode: string | null;
    unit: string;
    quantity: number;
    unitPrice: number;
    taxRate: number;
    lineSubtotal: number;
    lineTax: number;
    lineTotal: number;
  }>;
}

export interface BuildPayloadResult {
  payload: GenerateIrnInput;
  warnings: string[];
}

export function parsePincode(text: string | null | undefined): string | null {
  const m = (text ?? "").match(/(?<![0-9])([0-9]{6})(?![0-9])/u);
  return m ? m[1]! : null;
}

export function parseCity(text: string | null | undefined): string | null {
  const s = (text ?? "").trim();
  if (!s) return null;
  // Strip pincode then take last alpha token that isn't a known state.
  const sansPin = s.replace(/(?<![0-9])([0-9]{6})(?![0-9])/u, "");
  const tokens = sansPin
    .split(/[,\n]/u)
    .map((t) => t.replace(/[\s\-–—]+$/u, "").trim())
    .filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (!/^[A-Za-z][A-Za-z .'-]+$/u.test(t)) continue;
    if (gstStateCodeFromName(t) != null) continue;
    return t;
  }
  return null;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Translate an order into the IRP `Generate IRN` payload. Throws if
 * the order is missing data the IRP requires (party GSTIN, addresses
 * with PIN, valid HSN codes, etc.). The IRP enforces a tight schema
 * and returns ErrorDetails arrays on validation failure that we
 * surface verbatim to admins, so we err on the side of catching
 * problems locally first.
 */
export function buildIrnPayloadFromOrder(order: OrderForIrn): BuildPayloadResult {
  if (!order.customer.gstNumber) {
    throw new EinvoiceApiError(
      400,
      "Customer must have a GSTIN to register a B2B e-invoice.",
      null,
      "missing_buyer_gstin",
    );
  }
  const sellerGstin = order.org.eInvoiceGstin ?? order.org.gstNumber;
  if (!sellerGstin) {
    throw new EinvoiceApiError(
      400,
      "Set your organization GSTIN before generating e-invoices.",
      null,
      "missing_seller_gstin",
    );
  }
  const sellerStateCode = gstStateCodeFromGstin(sellerGstin);
  const buyerStateCode =
    gstStateCodeFromName(order.customer.placeOfSupply) ??
    gstStateCodeFromGstin(order.customer.gstNumber);
  if (!sellerStateCode) {
    throw new EinvoiceApiError(
      400,
      "Could not derive your state code from the GSTIN.",
      null,
      "invalid_seller_gstin",
    );
  }
  if (!buyerStateCode) {
    throw new EinvoiceApiError(
      400,
      "Could not derive the buyer's state code. Set the customer's place of supply.",
      null,
      "invalid_buyer_state",
    );
  }
  const sellerPincode = parsePincode(order.org.postalCode) ??
    parsePincode(order.org.addressLine1);
  const buyerPincode =
    parsePincode(order.customer.billingAddress) ??
    parsePincode(order.customer.shippingAddress);
  if (!sellerPincode) {
    throw new EinvoiceApiError(
      400,
      "Set a valid 6-digit PIN code on your organization address.",
      null,
      "missing_seller_pincode",
    );
  }
  if (!buyerPincode) {
    throw new EinvoiceApiError(
      400,
      "The customer's address must include a 6-digit PIN code.",
      null,
      "missing_buyer_pincode",
    );
  }
  const warnings: string[] = [];
  for (const line of order.lines) {
    if (!line.hsnCode || !/^[0-9]{4,8}$/u.test(line.hsnCode)) {
      throw new EinvoiceApiError(
        400,
        `Item "${line.name}" needs a valid 4-8 digit HSN code before it can be reported on an e-invoice.`,
        null,
        "invalid_hsn",
        { itemId: line.itemId, itemName: line.name },
      );
    }
  }

  const sameState = sellerStateCode === buyerStateCode;

  const items: IrpItem[] = order.lines.map((l, idx) => {
    const taxRate = l.taxRate;
    const cgst = sameState ? round2(l.lineTax / 2) : 0;
    const sgst = sameState ? l.lineTax - cgst : 0; // halves sum exactly
    const igst = sameState ? 0 : round2(l.lineTax);
    return {
      serialNumber: String(idx + 1),
      productName: l.name.slice(0, 100),
      productDesc: (l.description ?? l.name).slice(0, 300),
      hsnCode: l.hsnCode!,
      quantity: l.quantity,
      unit: (l.unit || "NOS").toUpperCase().slice(0, 8),
      unitPrice: l.unitPrice,
      taxableValue: l.lineSubtotal,
      gstRate: taxRate,
      cgstAmount: cgst,
      sgstAmount: sgst,
      igstAmount: igst,
      cessAmount: 0,
      totalItemValue: l.lineTotal,
    };
  });

  const cgstTotal = items.reduce((s, i) => s + i.cgstAmount, 0);
  const sgstTotal = items.reduce((s, i) => s + i.sgstAmount, 0);
  const igstTotal = items.reduce((s, i) => s + i.igstAmount, 0);

  const dt = new Date(order.orderDate + "T00:00:00Z");
  const docDate = `${pad2(dt.getUTCDate())}/${pad2(
    dt.getUTCMonth() + 1,
  )}/${dt.getUTCFullYear()}`;

  const seller: IrpAddress = {
    legalName: order.org.name,
    gstin: sellerGstin,
    addressLine1: (order.org.addressLine1 ?? "").slice(0, 100) || order.org.name,
    location: parseCity(order.org.addressLine1) ?? order.org.city ?? "",
    pincode: sellerPincode,
    stateCode: pad2(sellerStateCode),
  };
  const buyer: IrpAddress = {
    legalName: order.customer.company ?? order.customer.name,
    gstin: order.customer.gstNumber,
    addressLine1: (
      order.customer.billingAddress ??
      order.customer.shippingAddress ??
      order.customer.name
    ).slice(0, 100),
    location:
      parseCity(order.customer.billingAddress) ??
      parseCity(order.customer.shippingAddress) ??
      order.customer.placeOfSupply ??
      "",
    pincode: buyerPincode,
    stateCode: pad2(buyerStateCode),
    email: order.customer.email,
    phone: order.customer.phone,
  };

  if (!seller.location) {
    throw new EinvoiceApiError(
      400,
      "Could not derive your city from the organization address.",
      null,
      "missing_seller_city",
    );
  }
  if (!buyer.location) {
    throw new EinvoiceApiError(
      400,
      "Could not derive the customer's city. Add it to the billing address.",
      null,
      "missing_buyer_city",
    );
  }

  return {
    payload: {
      docType: "INV",
      docNumber: order.orderNumber,
      docDate,
      supplyType: "B2B",
      seller,
      buyer,
      items,
      totals: {
        assessableValue: round2(order.totals.subtotal),
        cgstValue: round2(cgstTotal),
        sgstValue: round2(sgstTotal),
        igstValue: round2(igstTotal),
        cessValue: 0,
        totalInvoiceValue: round2(order.totals.total),
      },
    },
    warnings,
  };
}
