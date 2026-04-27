import {
  pgTable,
  serial,
  integer,
  text,
  numeric,
  timestamp,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { warehousesTable } from "./warehouses";
import { itemsTable } from "./items";

export const stockTransfersTable = pgTable(
  "stock_transfers",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    transferNumber: text("transfer_number").notNull(),
    fromWarehouseId: integer("from_warehouse_id")
      .notNull()
      .references(() => warehousesTable.id, { onDelete: "restrict" }),
    toWarehouseId: integer("to_warehouse_id")
      .notNull()
      .references(() => warehousesTable.id, { onDelete: "restrict" }),
    transferDate: date("transfer_date").notNull(),
    status: text("status").notNull().default("draft"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    orgNumber: uniqueIndex("stock_transfers_org_number_idx").on(
      t.organizationId,
      t.transferNumber,
    ),
    orgFrom: index("stock_transfers_org_from_idx").on(
      t.organizationId,
      t.fromWarehouseId,
    ),
    orgTo: index("stock_transfers_org_to_idx").on(
      t.organizationId,
      t.toWarehouseId,
    ),
    orgStatus: index("stock_transfers_org_status_idx").on(
      t.organizationId,
      t.status,
    ),
  }),
);

export const stockTransferLinesTable = pgTable(
  "stock_transfer_lines",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    stockTransferId: integer("stock_transfer_id")
      .notNull()
      .references(() => stockTransfersTable.id, { onDelete: "cascade" }),
    itemId: integer("item_id")
      .notNull()
      .references(() => itemsTable.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 14, scale: 2 }).notNull(),
  },
  (t) => ({
    transferIdx: index("stock_transfer_lines_transfer_idx").on(t.stockTransferId),
    orgItemIdx: index("stock_transfer_lines_org_item_idx").on(
      t.organizationId,
      t.itemId,
    ),
  }),
);

export type StockTransfer = typeof stockTransfersTable.$inferSelect;
export type StockTransferLine = typeof stockTransferLinesTable.$inferSelect;
