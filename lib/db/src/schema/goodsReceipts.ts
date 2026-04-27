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
import { purchaseOrdersTable, purchaseOrderLinesTable } from "./purchaseOrders";

export const goodsReceiptsTable = pgTable(
  "goods_receipts",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    purchaseOrderId: integer("purchase_order_id")
      .notNull()
      .references(() => purchaseOrdersTable.id, { onDelete: "cascade" }),
    receiptNumber: text("receipt_number").notNull(),
    receivedDate: date("received_date").notNull(),
    status: text("status").notNull().default("received"),
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
    orgNumber: uniqueIndex("goods_receipts_org_number_idx").on(
      t.organizationId,
      t.receiptNumber,
    ),
    orgOrder: index("goods_receipts_org_order_idx").on(
      t.organizationId,
      t.purchaseOrderId,
    ),
  }),
);

export const goodsReceiptLinesTable = pgTable(
  "goods_receipt_lines",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    goodsReceiptId: integer("goods_receipt_id")
      .notNull()
      .references(() => goodsReceiptsTable.id, { onDelete: "cascade" }),
    purchaseOrderLineId: integer("purchase_order_line_id")
      .notNull()
      .references(() => purchaseOrderLinesTable.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 14, scale: 2 }).notNull(),
  },
  (t) => ({
    receiptIdx: index("goods_receipt_lines_receipt_idx").on(t.goodsReceiptId),
    orgLineIdx: index("goods_receipt_lines_org_line_idx").on(
      t.organizationId,
      t.purchaseOrderLineId,
    ),
  }),
);

export type GoodsReceipt = typeof goodsReceiptsTable.$inferSelect;
export type GoodsReceiptLine = typeof goodsReceiptLinesTable.$inferSelect;
