import { pgTable, serial, integer, text, numeric, timestamp } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";

export const customersTable = pgTable("customers", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  company: text("company"),
  gstNumber: text("gst_number"),
  billingAddress: text("billing_address"),
  shippingAddress: text("shipping_address"),
  placeOfSupply: text("place_of_supply"),
  notes: text("notes"),
  outstandingBalance: numeric("outstanding_balance", { precision: 14, scale: 2 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Customer = typeof customersTable.$inferSelect;
