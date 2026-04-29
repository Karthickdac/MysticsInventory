import { pgTable, serial, integer, text, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";

export const warehousesTable = pgTable(
  "warehouses",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    addressLine1: text("address_line1"),
    city: text("city"),
    state: text("state"),
    country: text("country"),
    isDefault: boolean("is_default").notNull().default(false),
    // Virtual warehouses model stock that is physically off-premises
    // (currently: at a job worker / outsourcing partner). They are
    // hidden from the regular warehouse picker and listings so users
    // never accidentally fulfil a sale from a job worker's premises.
    isVirtual: boolean("is_virtual").notNull().default(false),
    // When isVirtual is true and this points to a supplier, the
    // virtual warehouse represents that job worker's premises. We
    // create at most one such warehouse per (org, supplier).
    jobWorkerSupplierId: integer("job_worker_supplier_id"),
    shopifyLocationId: text("shopify_location_id"),
    shopifyLocationName: text("shopify_location_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    orgCode: uniqueIndex("warehouses_org_code_idx").on(t.organizationId, t.code),
    orgShopifyLoc: uniqueIndex("warehouses_org_shopify_location_idx")
      .on(t.organizationId, t.shopifyLocationId)
      .where(sql`${t.shopifyLocationId} IS NOT NULL`),
    // At most one virtual "with this job worker" warehouse per
    // (org, supplier). Without this guard two parallel "Issue
    // materials" calls for the same worker can both pass the
    // existence check inside ensureVendorWarehouse and create
    // duplicate ledgers, splitting the worker's stock and breaking
    // the "stock with this worker" report.
    orgJobWorker: uniqueIndex("warehouses_org_job_worker_idx")
      .on(t.organizationId, t.jobWorkerSupplierId)
      .where(sql`${t.isVirtual} = true`),
  }),
);

export type Warehouse = typeof warehousesTable.$inferSelect;
