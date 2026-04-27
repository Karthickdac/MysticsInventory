import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";

export const shopifyOauthStatesTable = pgTable(
  "shopify_oauth_states",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    state: text("state").notNull(),
    shopDomain: text("shop_domain").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    stateIdx: uniqueIndex("shopify_oauth_states_state_idx").on(t.state),
  }),
);

export type ShopifyOauthState = typeof shopifyOauthStatesTable.$inferSelect;
