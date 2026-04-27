import {
  pgTable,
  serial,
  integer,
  text,
  numeric,
  timestamp,
  date,
  index,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { suppliersTable } from "./suppliers";
import { purchaseOrdersTable } from "./purchaseOrders";

export const supplierPaymentsTable = pgTable(
  "supplier_payments",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliersTable.id, { onDelete: "restrict" }),
    paymentDate: date("payment_date").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    mode: text("mode").notNull(),
    referenceNumber: text("reference_number"),
    notes: text("notes"),
    bankAccountLabel: text("bank_account_label"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    orgSupplierIdx: index("supplier_payments_org_supplier_idx").on(
      t.organizationId,
      t.supplierId,
    ),
    orgDateIdx: index("supplier_payments_org_date_idx").on(
      t.organizationId,
      t.paymentDate,
    ),
  }),
);

export const supplierPaymentAllocationsTable = pgTable(
  "supplier_payment_allocations",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    paymentId: integer("payment_id")
      .notNull()
      .references(() => supplierPaymentsTable.id, { onDelete: "cascade" }),
    purchaseOrderId: integer("purchase_order_id")
      .notNull()
      .references(() => purchaseOrdersTable.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  },
  (t) => ({
    paymentIdx: index("supplier_payment_allocations_payment_idx").on(
      t.paymentId,
    ),
    purchaseOrderIdx: index("supplier_payment_allocations_po_idx").on(
      t.purchaseOrderId,
    ),
    orgIdx: index("supplier_payment_allocations_org_idx").on(t.organizationId),
  }),
);

export type SupplierPayment = typeof supplierPaymentsTable.$inferSelect;
export type SupplierPaymentAllocation =
  typeof supplierPaymentAllocationsTable.$inferSelect;
