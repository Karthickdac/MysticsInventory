import { pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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
