import {
  pgTable,
  varchar,
  integer,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";

export type BulkResultStatus =
  | "pending"
  | "running"
  | "success"
  | "already_issued"
  | "failed"
  | "skipped"
  | "ineligible";

export interface BulkResultRow {
  orderId: number;
  orderNumber: string | null;
  status: BulkResultStatus;
  message: string | null;
  errorCode: string | null;
}

export const einvoiceBulkBatchesTable = pgTable(
  "einvoice_bulk_batches",
  {
    id: varchar("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    total: integer("total").notNull().default(0),
    processed: integer("processed").notNull().default(0),
    succeeded: integer("succeeded").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    orderIdsInOrder: jsonb("order_ids_in_order")
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    results: jsonb("results")
      .$type<Record<string, BulkResultRow>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    recoveryClaimedAt: timestamp("recovery_claimed_at", {
      withTimezone: true,
    }),
  },
  (t) => ({
    statusCreatedIdx: index("einvoice_bulk_batches_status_created_idx").on(
      t.status,
      t.createdAt,
    ),
    orgIdx: index("einvoice_bulk_batches_org_idx").on(t.organizationId),
  }),
);

export type EinvoiceBulkBatch = typeof einvoiceBulkBatchesTable.$inferSelect;
