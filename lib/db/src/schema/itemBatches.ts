import {
  pgTable,
  serial,
  integer,
  text,
  numeric,
  timestamp,
  date,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { itemsTable } from "./items";

export const itemBatchesTable = pgTable(
  "item_batches",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    itemId: integer("item_id")
      .notNull()
      .references(() => itemsTable.id, { onDelete: "cascade" }),
    batchNumber: text("batch_number").notNull(),
    mfgDate: date("mfg_date"),
    expiryDate: date("expiry_date"),
    costPrice: numeric("cost_price", { precision: 14, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("item_batches_item_batchno_idx").on(
      t.itemId,
      t.batchNumber,
    ),
    orgItem: index("item_batches_org_item_idx").on(
      t.organizationId,
      t.itemId,
    ),
    expiry: index("item_batches_org_expiry_idx").on(
      t.organizationId,
      t.expiryDate,
    ),
  }),
);

export type ItemBatch = typeof itemBatchesTable.$inferSelect;
