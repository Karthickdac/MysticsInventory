import {
  pgTable,
  serial,
  integer,
  text,
  numeric,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { salesOrdersTable } from "./salesOrders";
import { usersTable } from "./users";

export const paymentLinksTable = pgTable(
  "payment_links",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    salesOrderId: integer("sales_order_id")
      .notNull()
      .references(() => salesOrdersTable.id, { onDelete: "cascade" }),
    razorpayLinkId: text("razorpay_link_id").notNull(),
    shortUrl: text("short_url").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("INR"),
    status: text("status").notNull().default("created"),
    description: text("description"),
    razorpayPaymentId: text("razorpay_payment_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdByUserId: integer("created_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    razorpayLinkIdIdx: uniqueIndex("payment_links_razorpay_link_id_idx").on(
      t.razorpayLinkId,
    ),
    razorpayPaymentIdIdx: uniqueIndex(
      "payment_links_razorpay_payment_id_idx",
    ).on(t.razorpayPaymentId),
    orgSalesOrderIdx: index("payment_links_org_sales_order_idx").on(
      t.organizationId,
      t.salesOrderId,
    ),
    // At most one active (status='created') link per (org, sales order).
    // Enforced at the DB level so concurrent create requests cannot both
    // commit a new active link.
    activeLinkUniqueIdx: uniqueIndex("payment_links_active_unique_idx")
      .on(t.organizationId, t.salesOrderId)
      .where(sql`status = 'created'`),
  }),
);

export type PaymentLink = typeof paymentLinksTable.$inferSelect;
