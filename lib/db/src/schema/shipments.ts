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
import { salesOrdersTable, salesOrderLinesTable } from "./salesOrders";

export const shipmentsTable = pgTable(
  "shipments",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    salesOrderId: integer("sales_order_id")
      .notNull()
      .references(() => salesOrdersTable.id, { onDelete: "cascade" }),
    shipmentNumber: text("shipment_number").notNull(),
    shipDate: date("ship_date").notNull(),
    status: text("status").notNull().default("shipped"),
    notes: text("notes"),
    shiprocketOrderId: text("shiprocket_order_id"),
    shiprocketShipmentId: text("shiprocket_shipment_id"),
    awb: text("awb"),
    courierName: text("courier_name"),
    labelUrl: text("label_url"),
    trackingUrl: text("tracking_url"),
    trackingStatus: text("tracking_status"),
    lastTrackedAt: timestamp("last_tracked_at", { withTimezone: true }),
    // Reason metadata captured when a shipment is cancelled. The
    // `cancelReasonCode` is one of CANCEL_REASON_CODES (see
    // `src/lib/cancelReasons.ts`); `cancelReasonNotes` is optional free
    // text. Both stay NULL on active shipments. Used by the returns
    // report (Feature 4).
    cancelReasonCode: text("cancel_reason_code"),
    cancelReasonNotes: text("cancel_reason_notes"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    orgNumber: uniqueIndex("shipments_org_number_idx").on(
      t.organizationId,
      t.shipmentNumber,
    ),
    orgOrder: index("shipments_org_order_idx").on(
      t.organizationId,
      t.salesOrderId,
    ),
  }),
);

export const shipmentLinesTable = pgTable(
  "shipment_lines",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    shipmentId: integer("shipment_id")
      .notNull()
      .references(() => shipmentsTable.id, { onDelete: "cascade" }),
    salesOrderLineId: integer("sales_order_line_id")
      .notNull()
      .references(() => salesOrderLinesTable.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 14, scale: 2 }).notNull(),
  },
  (t) => ({
    shipmentIdx: index("shipment_lines_shipment_idx").on(t.shipmentId),
    orgLineIdx: index("shipment_lines_org_line_idx").on(
      t.organizationId,
      t.salesOrderLineId,
    ),
  }),
);

export type Shipment = typeof shipmentsTable.$inferSelect;
export type ShipmentLine = typeof shipmentLinesTable.$inferSelect;
