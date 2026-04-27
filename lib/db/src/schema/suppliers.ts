import { pgTable, serial, integer, text, numeric, timestamp } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";

export const suppliersTable = pgTable("suppliers", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  company: text("company"),
  gstNumber: text("gst_number"),
  address: text("address"),
  notes: text("notes"),
  outstandingPayable: numeric("outstanding_payable", { precision: 14, scale: 2 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Supplier = typeof suppliersTable.$inferSelect;
