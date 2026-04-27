import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { salesOrdersTable } from "./salesOrders";
import { usersTable } from "./users";

export const emailLogTable = pgTable(
  "email_log",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    salesOrderId: integer("sales_order_id").references(
      () => salesOrdersTable.id,
      { onDelete: "set null" },
    ),
    kind: text("kind").notNull(),
    recipient: text("recipient").notNull(),
    subject: text("subject").notNull(),
    status: text("status").notNull(),
    errorMessage: text("error_message"),
    sentByUserId: integer("sent_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    sentAt: timestamp("sent_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgSalesOrderIdx: index("email_log_org_sales_order_idx").on(
      t.organizationId,
      t.salesOrderId,
    ),
  }),
);

export type EmailLog = typeof emailLogTable.$inferSelect;
