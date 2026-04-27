import { pgTable, serial, integer, text, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    orgCode: uniqueIndex("warehouses_org_code_idx").on(t.organizationId, t.code),
  }),
);

export type Warehouse = typeof warehousesTable.$inferSelect;
