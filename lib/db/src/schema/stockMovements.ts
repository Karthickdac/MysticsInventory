import { pgTable, serial, integer, text, numeric, timestamp } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { itemsTable } from "./items";
import { warehousesTable } from "./warehouses";

export const stockMovementsTable = pgTable("stock_movements", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id")
    .notNull()
    .references(() => itemsTable.id, { onDelete: "cascade" }),
  warehouseId: integer("warehouse_id")
    .notNull()
    .references(() => warehousesTable.id, { onDelete: "cascade" }),
  movementType: text("movement_type").notNull(),
  quantity: numeric("quantity", { precision: 14, scale: 2 }).notNull(),
  referenceType: text("reference_type"),
  referenceId: integer("reference_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type StockMovement = typeof stockMovementsTable.$inferSelect;
