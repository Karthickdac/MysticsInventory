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
import { suppliersTable } from "./suppliers";
import { warehousesTable } from "./warehouses";
import { itemsTable } from "./items";
import { jobWorkReceiptsTable } from "./jobWork";

export const purchaseOrdersTable = pgTable(
  "purchase_orders",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    orderNumber: text("order_number").notNull(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliersTable.id, { onDelete: "restrict" }),
    warehouseId: integer("warehouse_id")
      .notNull()
      .references(() => warehousesTable.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("draft"),
    orderDate: date("order_date").notNull(),
    expectedDeliveryDate: date("expected_delivery_date"),
    subtotal: numeric("subtotal", { precision: 14, scale: 2 }).notNull().default("0"),
    taxTotal: numeric("tax_total", { precision: 14, scale: 2 }).notNull().default("0"),
    total: numeric("total", { precision: 14, scale: 2 }).notNull().default("0"),
    amountPaid: numeric("amount_paid", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    balanceDue: numeric("balance_due", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    notes: text("notes"),
    stockAppliedAt: timestamp("stock_applied_at", { withTimezone: true }),
    // Set when this PO was auto-created as a supplier bill against a
    // job-work receipt (per-receipt conversion charge). Lets us link
    // the bill back to its originating JWO and reverse the bill if
    // the receipt is cancelled. SET NULL on delete so historical
    // bills survive even if the receipt is hard-deleted (we soft-cancel
    // in practice).
    jobWorkReceiptId: integer("job_work_receipt_id").references(
      () => jobWorkReceiptsTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    orgNumber: uniqueIndex("purchase_orders_org_number_idx").on(t.organizationId, t.orderNumber),
    // One bill per receipt. Prevents the auto-create from ever
    // double-firing for the same receipt (defence in depth alongside
    // the application-level guard).
    orgJwReceipt: uniqueIndex("purchase_orders_org_jw_receipt_idx").on(
      t.organizationId,
      t.jobWorkReceiptId,
    ),
  }),
);

export const purchaseOrderLinesTable = pgTable("purchase_order_lines", {
  id: serial("id").primaryKey(),
  purchaseOrderId: integer("purchase_order_id")
    .notNull()
    .references(() => purchaseOrdersTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id")
    .notNull()
    .references(() => itemsTable.id, { onDelete: "restrict" }),
  description: text("description"),
  quantity: numeric("quantity", { precision: 14, scale: 2 }).notNull(),
  unitPrice: numeric("unit_price", { precision: 14, scale: 2 }).notNull(),
  taxRate: numeric("tax_rate", { precision: 6, scale: 2 }).notNull().default("0"),
  discountPercent: numeric("discount_percent", { precision: 6, scale: 2 }).notNull().default("0"),
  discountAmount: numeric("discount_amount", { precision: 14, scale: 2 }).notNull().default("0"),
  lineSubtotal: numeric("line_subtotal", { precision: 14, scale: 2 }).notNull(),
  lineTax: numeric("line_tax", { precision: 14, scale: 2 }).notNull(),
  lineTotal: numeric("line_total", { precision: 14, scale: 2 }).notNull(),
  quantityReceived: numeric("quantity_received", { precision: 14, scale: 2 })
    .notNull()
    .default("0"),
});

export type PurchaseOrder = typeof purchaseOrdersTable.$inferSelect;
export type PurchaseOrderLine = typeof purchaseOrderLinesTable.$inferSelect;
