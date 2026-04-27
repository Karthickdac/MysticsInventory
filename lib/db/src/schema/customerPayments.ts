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
import { customersTable } from "./customers";
import { salesOrdersTable } from "./salesOrders";

export const customerPaymentsTable = pgTable(
  "customer_payments",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "restrict" }),
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
    orgCustomerIdx: index("customer_payments_org_customer_idx").on(
      t.organizationId,
      t.customerId,
    ),
    orgDateIdx: index("customer_payments_org_date_idx").on(
      t.organizationId,
      t.paymentDate,
    ),
  }),
);

export const customerPaymentAllocationsTable = pgTable(
  "customer_payment_allocations",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    paymentId: integer("payment_id")
      .notNull()
      .references(() => customerPaymentsTable.id, { onDelete: "cascade" }),
    salesOrderId: integer("sales_order_id")
      .notNull()
      .references(() => salesOrdersTable.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  },
  (t) => ({
    paymentIdx: index("customer_payment_allocations_payment_idx").on(t.paymentId),
    salesOrderIdx: index("customer_payment_allocations_so_idx").on(
      t.salesOrderId,
    ),
    orgIdx: index("customer_payment_allocations_org_idx").on(t.organizationId),
  }),
);

export type CustomerPayment = typeof customerPaymentsTable.$inferSelect;
export type CustomerPaymentAllocation =
  typeof customerPaymentAllocationsTable.$inferSelect;
