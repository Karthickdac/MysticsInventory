import {
  pgTable,
  serial,
  integer,
  text,
  numeric,
  timestamp,
  date,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { customersTable } from "./customers";
import { warehousesTable } from "./warehouses";
import { itemsTable } from "./items";

export const salesOrdersTable = pgTable(
  "sales_orders",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    orderNumber: text("order_number").notNull(),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "restrict" }),
    warehouseId: integer("warehouse_id")
      .notNull()
      .references(() => warehousesTable.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("draft"),
    orderDate: date("order_date").notNull(),
    expectedShipDate: date("expected_ship_date"),
    subtotal: numeric("subtotal", { precision: 14, scale: 2 }).notNull().default("0"),
    taxTotal: numeric("tax_total", { precision: 14, scale: 2 }).notNull().default("0"),
    total: numeric("total", { precision: 14, scale: 2 }).notNull().default("0"),
    notes: text("notes"),
    stockAppliedAt: timestamp("stock_applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    orgNumber: uniqueIndex("sales_orders_org_number_idx").on(t.organizationId, t.orderNumber),
  }),
);

export const salesOrderLinesTable = pgTable("sales_order_lines", {
  id: serial("id").primaryKey(),
  salesOrderId: integer("sales_order_id")
    .notNull()
    .references(() => salesOrdersTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id")
    .notNull()
    .references(() => itemsTable.id, { onDelete: "restrict" }),
  description: text("description"),
  quantity: numeric("quantity", { precision: 14, scale: 2 }).notNull(),
  unitPrice: numeric("unit_price", { precision: 14, scale: 2 }).notNull(),
  taxRate: numeric("tax_rate", { precision: 6, scale: 2 }).notNull().default("0"),
  lineSubtotal: numeric("line_subtotal", { precision: 14, scale: 2 }).notNull(),
  lineTax: numeric("line_tax", { precision: 14, scale: 2 }).notNull(),
  lineTotal: numeric("line_total", { precision: 14, scale: 2 }).notNull(),
});

export type SalesOrder = typeof salesOrdersTable.$inferSelect;
export type SalesOrderLine = typeof salesOrderLinesTable.$inferSelect;
