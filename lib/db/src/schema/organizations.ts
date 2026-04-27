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
    shiprocketPasswordEncrypted: text("shiprocket_password_encrypted"),
    shiprocketTokenEncrypted: text("shiprocket_token_encrypted"),
    shiprocketTokenExpiresAt: timestamp("shiprocket_token_expires_at", { withTimezone: true }),
    shiprocketPickupPincode: text("shiprocket_pickup_pincode"),
    shiprocketLastSyncedAt: timestamp("shiprocket_last_synced_at", { withTimezone: true }),
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
