import { boolean, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const organizationsTable = pgTable(
  "organizations",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    currency: text("currency").notNull().default("INR"),
    timezone: text("timezone").notNull().default("Asia/Kolkata"),
    gstNumber: text("gst_number"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    state: text("state"),
    postalCode: text("postal_code"),
    country: text("country").default("India"),
    logoUrl: text("logo_url"),
    invoiceFooter: text("invoice_footer"),
    plan: text("plan").notNull().default("free"),
    subscriptionStatus: text("subscription_status").notNull().default("trialing"),
    razorpayCustomerId: text("razorpay_customer_id"),
    razorpaySubscriptionId: text("razorpay_subscription_id"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    shopifyShopDomain: text("shopify_shop_domain"),
    shopifyAccessToken: text("shopify_access_token"),
    shopifyScopes: text("shopify_scopes"),
    shopifyLocationId: text("shopify_location_id"),
    shopifyWebhookRegisteredAt: timestamp("shopify_webhook_registered_at", { withTimezone: true }),
    shopifyLastWebhookAt: timestamp("shopify_last_webhook_at", { withTimezone: true }),
    shopifyLastSyncedAt: timestamp("shopify_last_synced_at", { withTimezone: true }),
    shopifyProductCount: text("shopify_product_count"),
    shopifyLastOrderId: text("shopify_last_order_id"),
    shiprocketEmail: text("shiprocket_email"),
    shiprocketTokenEncrypted: text("shiprocket_token_encrypted"),
    shiprocketTokenExpiresAt: timestamp("shiprocket_token_expires_at", { withTimezone: true }),
    shiprocketPickupPincode: text("shiprocket_pickup_pincode"),
    shiprocketLastSyncedAt: timestamp("shiprocket_last_synced_at", { withTimezone: true }),
    // ── E-way bill (NIC EWB portal) ─────────────────────────────────
    // GSTIN registered with the NIC EWB system. Often matches gst_number
    // above, but stored separately because some orgs file EWBs under a
    // different branch GSTIN than their primary one.
    ewbGstin: text("ewb_gstin"),
    // Username + password issued by the NIC EWB API portal (or by the
    // GSP fronting it). Both are encrypted at rest with the same
    // AES-256-GCM helper used elsewhere. We must persist the password
    // — unlike Shiprocket — because NIC session tokens last only ~6
    // hours and can ONLY be re-minted by re-submitting the username +
    // password (no refresh-token API exists). A token-only design
    // would force admins to reconnect the integration multiple times
    // a day, which is unworkable.
    ewbApiUsername: text("ewb_api_username"),
    ewbApiPasswordEncrypted: text("ewb_api_password_encrypted"),
    // Cached active session token, re-minted on demand from the
    // encrypted credentials when missing or near expiry.
    ewbTokenEncrypted: text("ewb_token_encrypted"),
    ewbTokenExpiresAt: timestamp("ewb_token_expires_at", { withTimezone: true }),
    ewbConnectedAt: timestamp("ewb_connected_at", { withTimezone: true }),
    ewbLastErrorAt: timestamp("ewb_last_error_at", { withTimezone: true }),
    ewbLastErrorMessage: text("ewb_last_error_message"),
    // ── E-invoice (IRP / GSP) ───────────────────────────────────────
    // Mandatory under Indian GST law for B2B invoices issued by orgs
    // above the e-invoice turnover threshold (currently ₹5 cr). When
    // enabled, every invoice for a customer with a GSTIN is registered
    // with the Invoice Registration Portal (IRP) via a GSP, which
    // returns an IRN + signed QR that we embed on the printed invoice.
    //
    // Storage mirrors the EWB pattern: the GSTIN under which we file
    // (often the same as gst_number, occasionally a sister branch),
    // an API username + password issued by the IRP API portal (or by
    // the GSP fronting it), and a cached short-lived session token.
    // IRP tokens last ~6 hours and can only be re-minted by replaying
    // the username + password — there's no refresh-token API — so we
    // must persist the password (encrypted at rest) to refresh
    // silently in the background. Without this, admins would be
    // forced to reconnect the integration multiple times a day.
    eInvoiceEnabled: boolean("e_invoice_enabled").notNull().default(false),
    eInvoiceGstin: text("e_invoice_gstin"),
    eInvoiceApiUsername: text("e_invoice_api_username"),
    eInvoiceApiPasswordEncrypted: text("e_invoice_api_password_encrypted"),
    // Some GSPs (Cygnet, Masters India, IRIS) require an additional
    // client_id / client_secret pair issued at the GSP application
    // level, separate from the per-GSTIN username + password. When
    // unset we fall back to NIC's two-credential flow.
    eInvoiceClientIdEncrypted: text("e_invoice_client_id_encrypted"),
    eInvoiceClientSecretEncrypted: text("e_invoice_client_secret_encrypted"),
    eInvoiceTokenEncrypted: text("e_invoice_token_encrypted"),
    eInvoiceTokenExpiresAt: timestamp("e_invoice_token_expires_at", { withTimezone: true }),
    eInvoiceConnectedAt: timestamp("e_invoice_connected_at", { withTimezone: true }),
    eInvoiceLastErrorAt: timestamp("e_invoice_last_error_at", { withTimezone: true }),
    eInvoiceLastErrorMessage: text("e_invoice_last_error_message"),
    onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    slugIdx: uniqueIndex("organizations_slug_idx").on(t.slug),
  }),
);

export type Organization = typeof organizationsTable.$inferSelect;
