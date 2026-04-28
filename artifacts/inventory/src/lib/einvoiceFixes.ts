/**
 * Shared mapping from a persisted IRP `errorCode` to the operator-
 * facing "what to fix" guidance. Owned in one place so the
 * SalesOrderDetail panel, the SalesOrders list, the Dashboard
 * summary and the Bulk e-invoice dialog all stay in lockstep —
 * tweaking a fix title here updates every surface.
 */

export interface EinvoiceFix {
  title: string;
  detail: string;
  href: string;
  cta: string;
}

export interface EinvoiceFixContext {
  customerId?: number | null;
  customerName?: string | null;
}

/**
 * Minimal shape we need to compute fixes. Both `SalesOrder.einvoice`
 * and `BulkEinvoiceResultRow` carry these fields on the wire.
 */
export interface EinvoiceErrorLike {
  errorCode?: string | null;
  errorContext?: Record<string, unknown> | null;
}

const customerEditHref = (customerId: number | null | undefined) =>
  customerId != null ? `/customers?focus=${customerId}` : "/customers";
const ORG_SETTINGS_HREF = "/settings";
const INTEGRATION_HREF = "/integrations/einvoice";

export function buildEinvoiceFixes(
  einvoice: EinvoiceErrorLike | null | undefined,
  ctx: EinvoiceFixContext = {},
): EinvoiceFix[] {
  if (!einvoice) return [];
  const code = einvoice.errorCode;
  if (!code) return [];

  const customerHref = customerEditHref(ctx.customerId ?? null);
  const customerName = ctx.customerName ?? "this customer";

  switch (code) {
    case "missing_buyer_gstin":
      return [
        {
          title: `Add a GSTIN for ${customerName}`,
          detail:
            "B2B e-invoices need the buyer's 15-character GSTIN. Open the customer record and fill in the GST number field.",
          href: customerHref,
          cta: "Edit customer",
        },
      ];
    case "invalid_buyer_state":
      return [
        {
          title: "Set the customer's place of supply",
          detail:
            "The IRP needs the buyer's state to compute CGST/SGST vs IGST. Pick the place of supply on the customer record.",
          href: customerHref,
          cta: "Edit customer",
        },
      ];
    case "missing_buyer_pincode":
      return [
        {
          title: "Add a 6-digit PIN code to the customer's address",
          detail:
            "The buyer's billing address must contain a valid 6-digit PIN code. Update the billing address on the customer record.",
          href: customerHref,
          cta: "Edit customer",
        },
      ];
    case "missing_buyer_city":
      return [
        {
          title: "Add a city to the customer's billing address",
          detail:
            "We couldn't read a city from the customer's billing address. Add it (e.g. \"Bengaluru\") on a separate line of the address.",
          href: customerHref,
          cta: "Edit customer",
        },
      ];
    case "missing_seller_gstin":
      return [
        {
          title: "Set your organization's GSTIN",
          detail:
            "Your business GSTIN is required on every e-invoice. Add it under Settings → Organization profile.",
          href: ORG_SETTINGS_HREF,
          cta: "Open settings",
        },
      ];
    case "invalid_seller_gstin":
      return [
        {
          title: "Fix your organization's GSTIN",
          detail:
            "We could not derive a state code from the GSTIN you have on file. Double-check the 15-character GSTIN under Settings → Organization profile.",
          href: ORG_SETTINGS_HREF,
          cta: "Open settings",
        },
      ];
    case "missing_seller_pincode":
      return [
        {
          title: "Add a 6-digit PIN code to your organization address",
          detail:
            "Set a valid PIN code on your organization profile so it can be embedded in the IRN payload.",
          href: ORG_SETTINGS_HREF,
          cta: "Open settings",
        },
      ];
    case "missing_seller_city":
      return [
        {
          title: "Add a city to your organization address",
          detail:
            "We couldn't read a city from your organization address. Update it under Settings → Organization profile.",
          href: ORG_SETTINGS_HREF,
          cta: "Open settings",
        },
      ];
    case "invalid_hsn": {
      const ctxData = einvoice.errorContext as
        | { itemId?: number; itemName?: string }
        | null
        | undefined;
      const itemId =
        ctxData && typeof ctxData.itemId === "number" ? ctxData.itemId : null;
      const itemName =
        ctxData && typeof ctxData.itemName === "string"
          ? ctxData.itemName
          : "this item";
      return [
        {
          title: `Add a valid HSN code to ${itemName}`,
          detail:
            "The IRP requires a 4-8 digit HSN/SAC code on every line. Open the item and set its HSN code.",
          href: itemId ? `/items?focus=${itemId}` : "/items",
          cta: "Edit item",
        },
      ];
    }
    case "einvoice_not_connected":
      return [
        {
          title: "Connect IRP credentials",
          detail:
            "E-invoicing is not configured for this organization. An admin needs to enter the IRP API credentials.",
          href: INTEGRATION_HREF,
          cta: "Open integration",
        },
      ];
    case "einvoice_auth_failed":
      return [
        {
          title: "Reconnect the IRP integration",
          detail:
            "The IRP rejected the saved credentials. An admin needs to re-enter them on the integration page.",
          href: INTEGRATION_HREF,
          cta: "Open integration",
        },
      ];
    default:
      return [];
  }
}

/**
 * Convenience helper for the summary surfaces (sales-order list,
 * dashboard, bulk dialog) that only need a one-liner. Returns the
 * primary fix, or `null` if there is no mapped guidance for this
 * error code (caller should fall back to the raw error message).
 */
export function getEinvoiceFixSummary(
  einvoice: EinvoiceErrorLike | null | undefined,
  ctx: EinvoiceFixContext = {},
): EinvoiceFix | null {
  const fixes = buildEinvoiceFixes(einvoice, ctx);
  return fixes[0] ?? null;
}
