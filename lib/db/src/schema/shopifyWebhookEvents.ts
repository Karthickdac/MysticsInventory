import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";

export const shopifyWebhookEventsTable = pgTable(
  "shopify_webhook_events",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    shopifyEventId: text("shopify_event_id").notNull(),
    topic: text("topic").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqEvent: uniqueIndex("shopify_webhook_events_org_event_idx").on(
      t.organizationId,
      t.shopifyEventId,
    ),
  }),
);

export type ShopifyWebhookEvent = typeof shopifyWebhookEventsTable.$inferSelect;
