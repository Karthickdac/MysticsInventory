import { pgTable, serial, integer, numeric, uniqueIndex } from "drizzle-orm/pg-core";
import { itemsTable } from "./items";
import { warehousesTable } from "./warehouses";
import { organizationsTable } from "./organizations";

export const itemWarehouseStockTable = pgTable(
  "item_warehouse_stock",
  {
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
    quantity: numeric("quantity", { precision: 14, scale: 2 }).notNull().default("0"),
  },
  (t) => ({
    uniq: uniqueIndex("item_warehouse_stock_idx").on(t.itemId, t.warehouseId),
  }),
);

export type ItemWarehouseStock = typeof itemWarehouseStockTable.$inferSelect;
