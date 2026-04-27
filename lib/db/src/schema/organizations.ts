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
    plan: text("plan").notNull().default("free"),
    subscriptionStatus: text("subscription_status").notNull().default("trialing"),
    razorpayCustomerId: text("razorpay_customer_id"),
    razorpaySubscriptionId: text("razorpay_subscription_id"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    shopifyShopDomain: text("shopify_shop_domain"),
    shopifyAccessToken: text("shopify_access_token"),
    shopifyLastSyncedAt: timestamp("shopify_last_synced_at", { withTimezone: true }),
    shopifyProductCount: text("shopify_product_count"),
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
