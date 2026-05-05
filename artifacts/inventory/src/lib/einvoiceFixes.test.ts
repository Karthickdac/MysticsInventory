import { describe, expect, it } from "vitest";
import {
  buildEinvoiceFixes,
  getEinvoiceFixSummary,
  type EinvoiceErrorLike,
} from "./einvoiceFixes";

describe("getEinvoiceFixSummary", () => {
  it("returns null when the einvoice payload is null", () => {
    expect(getEinvoiceFixSummary(null)).toBeNull();
  });

  it("returns null when the einvoice payload is undefined", () => {
    expect(getEinvoiceFixSummary(undefined)).toBeNull();
  });

  it("returns null when there is no error code", () => {
    expect(getEinvoiceFixSummary({ errorCode: null })).toBeNull();
    expect(getEinvoiceFixSummary({ errorCode: "" })).toBeNull();
    expect(getEinvoiceFixSummary({})).toBeNull();
  });

  it("returns null for an unknown error code (fallback)", () => {
    expect(
      getEinvoiceFixSummary({ errorCode: "totally_unknown_code" }),
    ).toBeNull();
    expect(
      buildEinvoiceFixes({ errorCode: "totally_unknown_code" }),
    ).toEqual([]);
  });

  describe("missing_buyer_gstin", () => {
    it("uses the customer name and customer focus href when context is provided", () => {
      expect(
        getEinvoiceFixSummary(
          { errorCode: "missing_buyer_gstin" },
          { customerId: 42, customerName: "Acme Pvt Ltd" },
        ),
      ).toEqual({
        title: "Add a GSTIN for Acme Pvt Ltd",
        detail:
          "B2B e-invoices need the buyer's 15-character GSTIN. Open the customer record and fill in the GST number field.",
        href: "/customers?focus=42",
        cta: "Edit customer",
      });
    });

    it("falls back to a generic name and listing href when context is missing", () => {
      expect(
        getEinvoiceFixSummary({ errorCode: "missing_buyer_gstin" }),
      ).toEqual({
        title: "Add a GSTIN for this customer",
        detail:
          "B2B e-invoices need the buyer's 15-character GSTIN. Open the customer record and fill in the GST number field.",
        href: "/customers",
        cta: "Edit customer",
      });
    });

    it("treats null customerId as missing", () => {
      const fix = getEinvoiceFixSummary(
        { errorCode: "missing_buyer_gstin" },
        { customerId: null, customerName: null },
      );
      expect(fix?.href).toBe("/customers");
      expect(fix?.title).toBe("Add a GSTIN for this customer");
    });
  });

  it("maps invalid_buyer_state to the customer place-of-supply guidance", () => {
    expect(
      getEinvoiceFixSummary(
        { errorCode: "invalid_buyer_state" },
        { customerId: 7 },
      ),
    ).toEqual({
      title: "Set the customer's place of supply",
      detail:
        "The IRP needs the buyer's state to compute CGST/SGST vs IGST. Pick the place of supply on the customer record.",
      href: "/customers?focus=7",
      cta: "Edit customer",
    });
  });

  it("maps missing_buyer_pincode to the buyer PIN guidance", () => {
    expect(
      getEinvoiceFixSummary(
        { errorCode: "missing_buyer_pincode" },
        { customerId: 9 },
      ),
    ).toEqual({
      title: "Add a 6-digit PIN code to the customer's address",
      detail:
        "The buyer's billing address must contain a valid 6-digit PIN code. Update the billing address on the customer record.",
      href: "/customers?focus=9",
      cta: "Edit customer",
    });
  });

  it("maps missing_buyer_city to the buyer city guidance", () => {
    expect(
      getEinvoiceFixSummary(
        { errorCode: "missing_buyer_city" },
        { customerId: 11 },
      ),
    ).toEqual({
      title: "Add a city to the customer's billing address",
      detail:
        "We couldn't read a city from the customer's billing address. Add it (e.g. \"Bengaluru\") on a separate line of the address.",
      href: "/customers?focus=11",
      cta: "Edit customer",
    });
  });

  it("maps missing_seller_gstin to the org settings", () => {
    expect(
      getEinvoiceFixSummary({ errorCode: "missing_seller_gstin" }),
    ).toEqual({
      title: "Set your organization's GSTIN",
      detail:
        "Your business GSTIN is required on every e-invoice. Add it under Settings → Organization profile.",
      href: "/settings",
      cta: "Open settings",
    });
  });

  it("maps invalid_seller_gstin to the org settings", () => {
    expect(
      getEinvoiceFixSummary({ errorCode: "invalid_seller_gstin" }),
    ).toEqual({
      title: "Fix your organization's GSTIN",
      detail:
        "We could not derive a state code from the GSTIN you have on file. Double-check the 15-character GSTIN under Settings → Organization profile.",
      href: "/settings",
      cta: "Open settings",
    });
  });

  it("maps missing_seller_pincode to the org settings", () => {
    expect(
      getEinvoiceFixSummary({ errorCode: "missing_seller_pincode" }),
    ).toEqual({
      title: "Add a 6-digit PIN code to your organization address",
      detail:
        "Set a valid PIN code on your organization profile so it can be embedded in the IRN payload.",
      href: "/settings",
      cta: "Open settings",
    });
  });

  it("maps missing_seller_city to the org settings", () => {
    expect(
      getEinvoiceFixSummary({ errorCode: "missing_seller_city" }),
    ).toEqual({
      title: "Add a city to your organization address",
      detail:
        "We couldn't read a city from your organization address. Update it under Settings → Organization profile.",
      href: "/settings",
      cta: "Open settings",
    });
  });

  describe("invalid_hsn", () => {
    it("uses item context to build a focused item link and title", () => {
      const einvoice: EinvoiceErrorLike = {
        errorCode: "invalid_hsn",
        errorContext: { itemId: 314, itemName: "Brass Widget" },
      };
      expect(getEinvoiceFixSummary(einvoice)).toEqual({
        title: "Add a valid HSN code to Brass Widget",
        detail:
          "The IRP requires a 4-8 digit HSN/SAC code on every line. Open the item and set its HSN code.",
        href: "/items?focus=314",
        cta: "Edit item",
      });
    });

    it("falls back to the items listing and a generic name without context", () => {
      expect(
        getEinvoiceFixSummary({
          errorCode: "invalid_hsn",
          errorContext: null,
        }),
      ).toEqual({
        title: "Add a valid HSN code to this item",
        detail:
          "The IRP requires a 4-8 digit HSN/SAC code on every line. Open the item and set its HSN code.",
        href: "/items",
        cta: "Edit item",
      });
    });

    it("ignores non-numeric itemId and non-string itemName in context", () => {
      const fix = getEinvoiceFixSummary({
        errorCode: "invalid_hsn",
        errorContext: {
          itemId: "314" as unknown as number,
          itemName: 99 as unknown as string,
        },
      });
      expect(fix?.href).toBe("/items");
      expect(fix?.title).toBe("Add a valid HSN code to this item");
    });
  });

  it("maps einvoice_not_connected to the integration page", () => {
    expect(
      getEinvoiceFixSummary({ errorCode: "einvoice_not_connected" }),
    ).toEqual({
      title: "Connect IRP credentials",
      detail:
        "E-invoicing is not configured for this organization. An admin needs to enter the IRP API credentials.",
      href: "/integrations/einvoice",
      cta: "Open integration",
    });
  });

  it("maps einvoice_auth_failed to the integration page", () => {
    expect(
      getEinvoiceFixSummary({ errorCode: "einvoice_auth_failed" }),
    ).toEqual({
      title: "Reconnect the IRP integration",
      detail:
        "The IRP rejected the saved credentials. An admin needs to re-enter them on the integration page.",
      href: "/integrations/einvoice",
      cta: "Open integration",
    });
  });

  it("returns the first fix from buildEinvoiceFixes", () => {
    const einvoice: EinvoiceErrorLike = { errorCode: "missing_seller_gstin" };
    const fixes = buildEinvoiceFixes(einvoice);
    expect(fixes).toHaveLength(1);
    expect(getEinvoiceFixSummary(einvoice)).toEqual(fixes[0]);
  });
});
