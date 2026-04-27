import {
  pgTable,
  serial,
  integer,
  numeric,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { itemBatchesTable } from "./itemBatches";
import { warehousesTable } from "./warehouses";
import { stockMovementsTable } from "./stockMovements";

// Per-batch ledger that splits a parent stock movement across one or
// more batches. Sum(batch movement quantity) for a given parent
// stockMovementId equals the parent stock movement's signed quantity.
// Used to deterministically reverse stock-in / stock-out on cancel.
export const stockBatchMovementsTable = pgTable(
  "stock_batch_movements",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    stockMovementId: integer("stock_movement_id")
      .notNull()
      .references(() => stockMovementsTable.id, { onDelete: "cascade" }),
    itemBatchId: integer("item_batch_id")
      .notNull()
      .references(() => itemBatchesTable.id, { onDelete: "restrict" }),
    warehouseId: integer("warehouse_id")
      .notNull()
      .references(() => warehousesTable.id, { onDelete: "cascade" }),
    quantity: numeric("quantity", { precision: 14, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byMovement: index("stock_batch_mvts_movement_idx").on(t.stockMovementId),
    byBatchWh: index("stock_batch_mvts_batch_wh_idx").on(
      t.itemBatchId,
      t.warehouseId,
    ),
    byOrg: index("stock_batch_mvts_org_idx").on(t.organizationId),
  }),
);

export type StockBatchMovement = typeof stockBatchMovementsTable.$inferSelect;
