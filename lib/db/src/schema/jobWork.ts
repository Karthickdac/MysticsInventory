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
import { suppliersTable } from "./suppliers";
import { warehousesTable } from "./warehouses";
import { itemsTable } from "./items";

// A Job Work Order ("JWO") tracks a batch of finished goods we've
// outsourced to a job worker (e.g. a textile printer or embroiderer).
// It owns three flows:
//   1. components definition (snapshot of the BOM at create time)
//   2. material issue challans (raw material out of `sourceWarehouseId`,
//      into the supplier's virtual warehouse `vendorWarehouseId`)
//   3. finished goods receipts (output item back into `destWarehouseId`,
//      with components consumed from the vendor warehouse + optional
//      scrap and a per-receipt job charge)
export const jobWorkOrdersTable = pgTable(
  "job_work_orders",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    jwoNumber: text("jwo_number").notNull(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliersTable.id, { onDelete: "restrict" }),
    // Output (finished) item we expect back from the job worker.
    outputItemId: integer("output_item_id")
      .notNull()
      .references(() => itemsTable.id, { onDelete: "restrict" }),
    // How many units of the output item were ordered.
    outputQuantity: numeric("output_quantity", {
      precision: 14,
      scale: 2,
    }).notNull(),
    // Real warehouse from which raw material is shipped to the worker.
    sourceWarehouseId: integer("source_warehouse_id")
      .notNull()
      .references(() => warehousesTable.id, { onDelete: "restrict" }),
    // Real warehouse where finished output is received back into.
    destWarehouseId: integer("dest_warehouse_id")
      .notNull()
      .references(() => warehousesTable.id, { onDelete: "restrict" }),
    // Virtual warehouse representing the worker's premises. Created
    // on demand the first time we issue material to this supplier.
    vendorWarehouseId: integer("vendor_warehouse_id")
      .notNull()
      .references(() => warehousesTable.id, { onDelete: "restrict" }),
    // Per-output-unit conversion charge agreed with the worker
    // (rupees / unit). Used as the default when posting a receipt's
    // job charge; the receipt itself stores the actual amount.
    jobChargeRate: numeric("job_charge_rate", {
      precision: 14,
      scale: 2,
    })
      .notNull()
      .default("0"),
    expectedReturnDate: date("expected_return_date"),
    notes: text("notes"),
    // draft | issued | partially_received | completed | cancelled
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    orgNumberIdx: uniqueIndex("job_work_orders_org_number_idx").on(
      t.organizationId,
      t.jwoNumber,
    ),
    orgSupplierIdx: index("job_work_orders_org_supplier_idx").on(
      t.organizationId,
      t.supplierId,
    ),
    orgStatusIdx: index("job_work_orders_org_status_idx").on(
      t.organizationId,
      t.status,
    ),
  }),
);

// BOM snapshot for the order. Captured at create time from the output
// item's bundle definition (or empty if the output item has no BOM —
// the user can edit the rows on the form). `quantityPerOutput` stays
// editable while the JWO is in draft; `totalQuantity` is recomputed
// (= outputQuantity * quantityPerOutput) and used as the planned
// material requirement.
export const jobWorkOrderComponentsTable = pgTable(
  "job_work_order_components",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    jobWorkOrderId: integer("job_work_order_id")
      .notNull()
      .references(() => jobWorkOrdersTable.id, { onDelete: "cascade" }),
    componentItemId: integer("component_item_id")
      .notNull()
      .references(() => itemsTable.id, { onDelete: "restrict" }),
    quantityPerOutput: numeric("quantity_per_output", {
      precision: 14,
      scale: 2,
    }).notNull(),
    totalQuantity: numeric("total_quantity", {
      precision: 14,
      scale: 2,
    }).notNull(),
  },
  (t) => ({
    orgJwoIdx: index("job_work_order_components_org_jwo_idx").on(
      t.organizationId,
      t.jobWorkOrderId,
    ),
    jwoCompUnique: uniqueIndex("job_work_order_components_jwo_comp_idx").on(
      t.jobWorkOrderId,
      t.componentItemId,
    ),
  }),
);

// One issue challan = one shipment of raw materials out to the worker.
// A JWO can have many issues (split deliveries are common in textile
// production where dyeing is staggered across batches).
export const jobWorkIssuesTable = pgTable(
  "job_work_issues",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    jobWorkOrderId: integer("job_work_order_id")
      .notNull()
      .references(() => jobWorkOrdersTable.id, { onDelete: "cascade" }),
    issueNumber: text("issue_number").notNull(),
    issueDate: date("issue_date").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgNumberIdx: uniqueIndex("job_work_issues_org_number_idx").on(
      t.organizationId,
      t.issueNumber,
    ),
    jwoIdx: index("job_work_issues_jwo_idx").on(t.jobWorkOrderId),
  }),
);

export const jobWorkIssueLinesTable = pgTable(
  "job_work_issue_lines",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    jobWorkIssueId: integer("job_work_issue_id")
      .notNull()
      .references(() => jobWorkIssuesTable.id, { onDelete: "cascade" }),
    componentItemId: integer("component_item_id")
      .notNull()
      .references(() => itemsTable.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 14, scale: 2 }).notNull(),
  },
  (t) => ({
    issueIdx: index("job_work_issue_lines_issue_idx").on(t.jobWorkIssueId),
    issueCompUnique: uniqueIndex(
      "job_work_issue_lines_issue_comp_idx",
    ).on(t.jobWorkIssueId, t.componentItemId),
  }),
);

// One receipt = the worker delivered a batch of finished goods back.
// Each receipt records: finished output qty (added to dest warehouse),
// optional scrap qty (lost output, recorded as a stock_movement note
// only — no inventory row to mutate), per-receipt job charge that
// bumps the supplier's outstanding payable, plus the matching component
// consumption rows that decrement the vendor warehouse.
export const jobWorkReceiptsTable = pgTable(
  "job_work_receipts",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    jobWorkOrderId: integer("job_work_order_id")
      .notNull()
      .references(() => jobWorkOrdersTable.id, { onDelete: "cascade" }),
    receiptNumber: text("receipt_number").notNull(),
    receivedDate: date("received_date").notNull(),
    finishedQuantity: numeric("finished_quantity", {
      precision: 14,
      scale: 2,
    }).notNull(),
    scrapQuantity: numeric("scrap_quantity", {
      precision: 14,
      scale: 2,
    })
      .notNull()
      .default("0"),
    jobCharge: numeric("job_charge", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    notes: text("notes"),
    // Soft-cancel marker. 'recorded' (default) is the live receipt;
    // 'cancelled' means stock + payable + auto-bill have been reversed
    // but the row is retained for audit and JWO history.
    status: text("status").notNull().default("recorded"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgNumberIdx: uniqueIndex("job_work_receipts_org_number_idx").on(
      t.organizationId,
      t.receiptNumber,
    ),
    jwoIdx: index("job_work_receipts_jwo_idx").on(t.jobWorkOrderId),
  }),
);

export const jobWorkReceiptComponentsTable = pgTable(
  "job_work_receipt_components",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    jobWorkReceiptId: integer("job_work_receipt_id")
      .notNull()
      .references(() => jobWorkReceiptsTable.id, { onDelete: "cascade" }),
    componentItemId: integer("component_item_id")
      .notNull()
      .references(() => itemsTable.id, { onDelete: "restrict" }),
    quantityConsumed: numeric("quantity_consumed", {
      precision: 14,
      scale: 2,
    }).notNull(),
    scrapQuantity: numeric("scrap_quantity", {
      precision: 14,
      scale: 2,
    })
      .notNull()
      .default("0"),
  },
  (t) => ({
    receiptIdx: index("job_work_receipt_components_receipt_idx").on(
      t.jobWorkReceiptId,
    ),
    receiptCompUnique: uniqueIndex(
      "job_work_receipt_components_receipt_comp_idx",
    ).on(t.jobWorkReceiptId, t.componentItemId),
  }),
);

export type JobWorkOrder = typeof jobWorkOrdersTable.$inferSelect;
export type JobWorkOrderComponent =
  typeof jobWorkOrderComponentsTable.$inferSelect;
export type JobWorkIssue = typeof jobWorkIssuesTable.$inferSelect;
export type JobWorkIssueLine = typeof jobWorkIssueLinesTable.$inferSelect;
export type JobWorkReceipt = typeof jobWorkReceiptsTable.$inferSelect;
export type JobWorkReceiptComponent =
  typeof jobWorkReceiptComponentsTable.$inferSelect;
