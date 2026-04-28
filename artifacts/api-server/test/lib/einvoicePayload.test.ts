import { describe, it, expect } from "vitest";
import {
  buildIrnPayloadFromOrder,
  parsePincode,
  parseCity,
  type OrderForIrn,
} from "../../src/lib/einvoicePayload";
import { EinvoiceApiError } from "../../src/lib/einvoice";

// ──────────────────────────────────────────────────────────────────────
// Fixture helpers
// ──────────────────────────────────────────────────────────────────────

function baseOrder(overrides: Partial<OrderForIrn> = {}): OrderForIrn {
  // Seller in Karnataka (state code 29). Buyer overrides switch to
  // intra-state by default; the inter-state suite passes a Maharashtra
  // buyer.
  return {
    id: 42,
    organizationId: 1,
    orderNumber: "INV-0001",
    orderDate: "2026-01-15",
    status: "shipped",
    irn: null,
    irpStatus: null,
    irpAckDate: null,
    customer: {
      id: 7,
      name: "Acme Buyer",
      company: "Acme Pvt Ltd",
      gstNumber: "29ABCDE1234F1Z5",
      billingAddress: "12 MG Road, Bengaluru 560001",
      shippingAddress: "12 MG Road, Bengaluru 560001",
      placeOfSupply: "Karnataka",
      email: "buyer@acme.test",
      phone: "9999999999",
    },
    org: {
      name: "Mystics Inc",
      gstNumber: "29ZZZZZ9999Z1Z5",
      addressLine1: "1 Brigade Road, Bengaluru 560002",
      city: "Bengaluru",
      state: "Karnataka",
      postalCode: "560002",
      eInvoiceGstin: null,
    },
    totals: { subtotal: 1000, tax: 180, total: 1180 },
    lines: [
      {
        itemId: 100,
        name: "Widget",
        sku: "WID-1",
        description: "Blue widget",
        hsnCode: "84715000",
        unit: "NOS",
        quantity: 1,
        unitPrice: 1000,
        taxRate: 18,
        lineSubtotal: 1000,
        lineTax: 180,
        lineTotal: 1180,
      },
    ],
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────
// PIN / city parsing
// ──────────────────────────────────────────────────────────────────────

describe("parsePincode", () => {
  it("extracts a 6-digit PIN from a free-form address", () => {
    expect(parsePincode("12 MG Road, Bengaluru 560001")).toBe("560001");
  });
  it("ignores a stray 5-digit number", () => {
    expect(parsePincode("12 MG Road, Bengaluru 12345")).toBeNull();
  });
  it("ignores a 7-digit run that contains a 6-digit substring", () => {
    // The negative lookarounds reject runs adjacent to other digits.
    expect(parsePincode("contact 5600012")).toBeNull();
  });
  it("returns null for null/undefined/empty inputs", () => {
    expect(parsePincode(null)).toBeNull();
    expect(parsePincode(undefined)).toBeNull();
    expect(parsePincode("")).toBeNull();
  });
  it("picks the first 6-digit run when several are present", () => {
    expect(parsePincode("PO Box 110001 ATTN 560001")).toBe("110001");
  });
});

describe("parseCity", () => {
  it("returns the trailing city token after a pincode", () => {
    expect(parseCity("12 MG Road, Bengaluru 560001")).toBe("Bengaluru");
  });
  it("skips state-name tokens to find the actual city", () => {
    expect(parseCity("12 MG Road, Bengaluru, Karnataka 560001")).toBe(
      "Bengaluru",
    );
  });
  it("returns null when no alpha city token is present", () => {
    expect(parseCity("560001")).toBeNull();
    expect(parseCity("")).toBeNull();
    expect(parseCity(null)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Validation branches
// ──────────────────────────────────────────────────────────────────────

describe("buildIrnPayloadFromOrder validation", () => {
  it("happy path: builds a B2B payload for a complete intra-state order", () => {
    const { payload } = buildIrnPayloadFromOrder(baseOrder());
    expect(payload.docType).toBe("INV");
    expect(payload.docNumber).toBe("INV-0001");
    expect(payload.docDate).toBe("15/01/2026");
    expect(payload.supplyType).toBe("B2B");
    expect(payload.seller.gstin).toBe("29ZZZZZ9999Z1Z5");
    expect(payload.seller.stateCode).toBe("29");
    expect(payload.seller.pincode).toBe("560002");
    expect(payload.buyer.stateCode).toBe("29");
    expect(payload.items).toHaveLength(1);
  });

  it("throws missing_buyer_gstin when the customer has no GSTIN (B2C)", () => {
    expect(() =>
      buildIrnPayloadFromOrder(
        baseOrder({
          customer: { ...baseOrder().customer, gstNumber: null },
        }),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "missing_buyer_gstin",
        status: 400,
      }) as unknown as Error,
    );
  });

  it("throws missing_seller_gstin when neither org GSTIN is set", () => {
    expect(() =>
      buildIrnPayloadFromOrder(
        baseOrder({
          org: {
            ...baseOrder().org,
            gstNumber: null,
            eInvoiceGstin: null,
          },
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "missing_seller_gstin" }) as unknown as Error,
    );
  });

  it("prefers eInvoiceGstin over the org's general GSTIN", () => {
    const { payload } = buildIrnPayloadFromOrder(
      baseOrder({
        org: {
          ...baseOrder().org,
          gstNumber: "27AAAAA0000A1Z5", // Maharashtra
          eInvoiceGstin: "29ZZZZZ9999Z1Z5", // Karnataka
        },
      }),
    );
    expect(payload.seller.gstin).toBe("29ZZZZZ9999Z1Z5");
    expect(payload.seller.stateCode).toBe("29");
  });

  it("throws invalid_seller_gstin for a malformed seller GSTIN", () => {
    expect(() =>
      buildIrnPayloadFromOrder(
        baseOrder({
          org: { ...baseOrder().org, eInvoiceGstin: "BAD" },
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_seller_gstin" }) as unknown as Error,
    );
  });

  it("throws invalid_buyer_state when neither place-of-supply nor GSTIN yield a state", () => {
    // GSTIN passes shape check (2 leading digits 99 are still
    // technically numeric and parseable as a state index, so we use
    // a clearly-invalid state code 99 which `gstStateCodeFromGstin`
    // rejects).
    expect(() =>
      buildIrnPayloadFromOrder(
        baseOrder({
          customer: {
            ...baseOrder().customer,
            placeOfSupply: null,
            gstNumber: "99ABCDE1234F1Z5",
          },
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_buyer_state" }) as unknown as Error,
    );
  });

  it("derives buyer state from placeOfSupply when set, even with a foreign GSTIN", () => {
    const { payload } = buildIrnPayloadFromOrder(
      baseOrder({
        customer: {
          ...baseOrder().customer,
          placeOfSupply: "Maharashtra",
          gstNumber: "27ABCDE1234F1Z5",
        },
      }),
    );
    expect(payload.buyer.stateCode).toBe("27");
  });

  it("throws missing_seller_pincode when org PIN cannot be parsed from any field", () => {
    expect(() =>
      buildIrnPayloadFromOrder(
        baseOrder({
          org: {
            ...baseOrder().org,
            postalCode: null,
            addressLine1: "1 Brigade Road, Bengaluru",
          },
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "missing_seller_pincode" }) as unknown as Error,
    );
  });

  it("falls back to addressLine1 when postalCode is empty", () => {
    const { payload } = buildIrnPayloadFromOrder(
      baseOrder({
        org: {
          ...baseOrder().org,
          postalCode: null,
          addressLine1: "1 Brigade Road, Bengaluru 560002",
        },
      }),
    );
    expect(payload.seller.pincode).toBe("560002");
  });

  it("throws missing_buyer_pincode when neither billing nor shipping address has a PIN", () => {
    expect(() =>
      buildIrnPayloadFromOrder(
        baseOrder({
          customer: {
            ...baseOrder().customer,
            billingAddress: "12 MG Road, Bengaluru",
            shippingAddress: "12 MG Road, Bengaluru",
          },
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "missing_buyer_pincode" }) as unknown as Error,
    );
  });

  it("falls back to shipping address PIN when billing address has none", () => {
    const { payload } = buildIrnPayloadFromOrder(
      baseOrder({
        customer: {
          ...baseOrder().customer,
          billingAddress: "12 MG Road, Bengaluru",
          shippingAddress: "1 Indiranagar, Bengaluru 560038",
        },
      }),
    );
    expect(payload.buyer.pincode).toBe("560038");
  });

  it("throws invalid_hsn for a missing HSN code with item context", () => {
    let caught: EinvoiceApiError | null = null;
    try {
      buildIrnPayloadFromOrder(
        baseOrder({
          lines: [
            {
              ...baseOrder().lines[0]!,
              hsnCode: null,
            },
          ],
        }),
      );
    } catch (err) {
      caught = err as EinvoiceApiError;
    }
    expect(caught).toBeInstanceOf(EinvoiceApiError);
    expect(caught?.code).toBe("invalid_hsn");
    expect(caught?.context).toEqual({ itemId: 100, itemName: "Widget" });
  });

  it("throws invalid_hsn for a 3-digit HSN", () => {
    expect(() =>
      buildIrnPayloadFromOrder(
        baseOrder({
          lines: [{ ...baseOrder().lines[0]!, hsnCode: "847" }],
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_hsn" }) as unknown as Error,
    );
  });

  it("throws invalid_hsn for a 9-digit HSN", () => {
    expect(() =>
      buildIrnPayloadFromOrder(
        baseOrder({
          lines: [{ ...baseOrder().lines[0]!, hsnCode: "847150001" }],
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_hsn" }) as unknown as Error,
    );
  });

  it("throws invalid_hsn for a non-numeric HSN", () => {
    expect(() =>
      buildIrnPayloadFromOrder(
        baseOrder({
          lines: [{ ...baseOrder().lines[0]!, hsnCode: "84A50" }],
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_hsn" }) as unknown as Error,
    );
  });

  it("accepts 4-digit and 8-digit HSN codes", () => {
    expect(() =>
      buildIrnPayloadFromOrder(
        baseOrder({
          lines: [{ ...baseOrder().lines[0]!, hsnCode: "8471" }],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      buildIrnPayloadFromOrder(
        baseOrder({
          lines: [{ ...baseOrder().lines[0]!, hsnCode: "84715000" }],
        }),
      ),
    ).not.toThrow();
  });

  it("throws missing_seller_city when org address has no derivable city", () => {
    expect(() =>
      buildIrnPayloadFromOrder(
        baseOrder({
          org: {
            ...baseOrder().org,
            addressLine1: "560002",
            city: null,
          },
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "missing_seller_city" }) as unknown as Error,
    );
  });

  it("throws missing_buyer_city when customer addresses + place-of-supply are all empty of a city", () => {
    expect(() =>
      buildIrnPayloadFromOrder(
        baseOrder({
          customer: {
            ...baseOrder().customer,
            billingAddress: "560001",
            shippingAddress: "560001",
            placeOfSupply: null,
            gstNumber: "29ABCDE1234F1Z5",
          },
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "missing_buyer_city" }) as unknown as Error,
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// CGST/SGST/IGST split — the legal-compliance core
// ──────────────────────────────────────────────────────────────────────

describe("buildIrnPayloadFromOrder tax split", () => {
  it("intra-state: splits line tax into equal CGST/SGST and zero IGST", () => {
    const { payload } = buildIrnPayloadFromOrder(baseOrder());
    const item = payload.items[0]!;
    expect(item.cgstAmount).toBe(90);
    expect(item.sgstAmount).toBe(90);
    expect(item.igstAmount).toBe(0);
    expect(payload.totals.cgstValue).toBe(90);
    expect(payload.totals.sgstValue).toBe(90);
    expect(payload.totals.igstValue).toBe(0);
  });

  it("intra-state: keeps CGST+SGST = lineTax even when /2 doesn't round cleanly", () => {
    const order = baseOrder({
      lines: [
        {
          ...baseOrder().lines[0]!,
          // 18% of 555.55 = 99.999 → typical rounding pain
          unitPrice: 555.55,
          lineSubtotal: 555.55,
          lineTax: 99.99,
          lineTotal: 655.54,
        },
      ],
      totals: { subtotal: 555.55, tax: 99.99, total: 655.54 },
    });
    const { payload } = buildIrnPayloadFromOrder(order);
    const item = payload.items[0]!;
    // CGST is rounded to 2dp; SGST takes the residual to keep the
    // halves summing to the original line tax exactly.
    expect(item.cgstAmount + item.sgstAmount).toBeCloseTo(99.99, 6);
    expect(item.cgstAmount).toBe(50);
    expect(item.sgstAmount).toBeCloseTo(49.99, 6);
    expect(item.igstAmount).toBe(0);
  });

  it("inter-state: routes the entire tax through IGST and zeroes CGST/SGST", () => {
    // Buyer in Maharashtra (27), seller in Karnataka (29).
    const order = baseOrder({
      customer: {
        ...baseOrder().customer,
        placeOfSupply: "Maharashtra",
        gstNumber: "27ABCDE1234F1Z5",
        billingAddress: "1 Marine Drive, Mumbai 400001",
      },
    });
    const { payload } = buildIrnPayloadFromOrder(order);
    const item = payload.items[0]!;
    expect(item.cgstAmount).toBe(0);
    expect(item.sgstAmount).toBe(0);
    expect(item.igstAmount).toBe(180);
    expect(payload.totals.cgstValue).toBe(0);
    expect(payload.totals.sgstValue).toBe(0);
    expect(payload.totals.igstValue).toBe(180);
  });

  it("totals: sums per-item tax components into ValDtls correctly", () => {
    const order = baseOrder({
      lines: [
        { ...baseOrder().lines[0]!, lineSubtotal: 1000, lineTax: 180 },
        {
          itemId: 101,
          name: "Gizmo",
          sku: "GIZ-1",
          description: null,
          hsnCode: "8471",
          unit: "NOS",
          quantity: 2,
          unitPrice: 250,
          taxRate: 18,
          lineSubtotal: 500,
          lineTax: 90,
          lineTotal: 590,
        },
      ],
      totals: { subtotal: 1500, tax: 270, total: 1770 },
    });
    const { payload } = buildIrnPayloadFromOrder(order);
    expect(payload.items).toHaveLength(2);
    expect(payload.totals.cgstValue).toBe(135);
    expect(payload.totals.sgstValue).toBe(135);
    expect(payload.totals.assessableValue).toBe(1500);
    expect(payload.totals.totalInvoiceValue).toBe(1770);
  });

  it("formats the document date in the dd/mm/yyyy form the IRP expects", () => {
    const { payload } = buildIrnPayloadFromOrder(
      baseOrder({ orderDate: "2026-03-07" }),
    );
    expect(payload.docDate).toBe("07/03/2026");
  });
});
