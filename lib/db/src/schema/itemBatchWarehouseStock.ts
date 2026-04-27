import {
  pgTable,
  serial,
  integer,
  numeric,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { itemBatchesTable } from "./itemBatches";
import { warehousesTable } from "./warehouses";

export const itemBatchWarehouseStockTable = pgTable(
  "item_batch_warehouse_stock",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    itemBatchId: integer("item_batch_id")
      .notNull()
      .references(() => itemBatchesTable.id, { onDelete: "cascade" }),
    warehouseId: integer("warehouse_id")
      .notNull()
      .references(() => warehousesTable.id, { onDelete: "cascade" }),
    quantity: numeric("quantity", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
  },
  (t) => ({
    uniq: uniqueIndex("item_batch_wh_stock_idx").on(
      t.itemBatchId,
      t.warehouseId,
    ),
    byWarehouse: index("item_batch_wh_stock_wh_idx").on(t.warehouseId),
  }),
);

export type ItemBatchWarehouseStock =
  typeof itemBatchWarehouseStockTable.$inferSelect;
