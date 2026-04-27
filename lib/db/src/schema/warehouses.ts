import { pgTable, serial, integer, text, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";

export const warehousesTable = pgTable(
  "warehouses",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    addressLine1: text("address_line1"),
    city: text("city"),
    state: text("state"),
    country: text("country"),
    isDefault: boolean("is_default").notNull().default(false),
    shopifyLocationId: text("shopify_location_id"),
    shopifyLocationName: text("shopify_location_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    orgCode: uniqueIndex("warehouses_org_code_idx").on(t.organizationId, t.code),
    orgShopifyLoc: uniqueIndex("warehouses_org_shopify_location_idx")
      .on(t.organizationId, t.shopifyLocationId)
      .where(sql`${t.shopifyLocationId} IS NOT NULL`),
  }),
);

export type Warehouse = typeof warehousesTable.$inferSelect;
