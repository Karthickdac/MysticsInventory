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

/**
 * Persisted state for historical Shopify order imports.
 *
 * The import runs in the background (paging through Shopify), so the route
 * kicks it off and returns a job id the frontend polls. State is persisted
 * here (rather than an in-process Map) so the result — including the list of
 * `failedOrders` a merchant needs to retry — survives a server restart.
 */
export const shopifyImportJobsTable = pgTable(
  "shopify_import_jobs",
  {
    id: varchar("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    // Total orders to process; null until known (count call in flight).
    total: integer("total"),
    processed: integer("processed").notNull().default(0),
    imported: integer("imported").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    // Shopify orders that threw during import, with a human-readable failure
    // reason, so they can be retried (and the merchant can see *why*).
    failedOrders: jsonb("failed_orders")
      .$type<{ id: string; reason: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    fromDate: text("from_date"),
    toDate: text("to_date"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    orgIdx: index("shopify_import_jobs_org_idx").on(t.organizationId),
    finishedAtIdx: index("shopify_import_jobs_finished_at_idx").on(
      t.finishedAt,
    ),
  }),
);

export type ShopifyImportJobRow = typeof shopifyImportJobsTable.$inferSelect;
