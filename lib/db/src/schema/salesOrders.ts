import {
  pgTable,
  serial,
  integer,
  text,
  numeric,
  timestamp,
  date,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { customersTable } from "./customers";
import { warehousesTable } from "./warehouses";
import { itemsTable } from "./items";

export const salesOrdersTable = pgTable(
  "sales_orders",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    orderNumber: text("order_number").notNull(),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "restrict" }),
    warehouseId: integer("warehouse_id")
      .notNull()
      .references(() => warehousesTable.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("draft"),
    orderDate: date("order_date").notNull(),
    expectedShipDate: date("expected_ship_date"),
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
    shopifyOrderId: text("shopify_order_id"),
    externalReference: text("external_reference"),
    // ── E-way bill (NIC EWB) ──────────────────────────────────────────
    // Populated when an EWB has been generated for this order. Status
    // values: null (not generated), "active", "cancelled". Expiry is
    // derived at read time by comparing ewbValidUntil to now.
    ewbNumber: text("ewb_number"),
    ewbDate: timestamp("ewb_date", { withTimezone: true }),
    ewbValidUntil: timestamp("ewb_valid_until", { withTimezone: true }),
    ewbStatus: text("ewb_status"),
    ewbQrPayload: text("ewb_qr_payload"),
    ewbVehicleNumber: text("ewb_vehicle_number"),
    ewbTransportMode: text("ewb_transport_mode"),
    ewbTransporterName: text("ewb_transporter_name"),
    ewbTransporterId: text("ewb_transporter_id"),
    ewbDistanceKm: integer("ewb_distance_km"),
    ewbDispatchAddress: jsonb("ewb_dispatch_address"),
    ewbShipToAddress: jsonb("ewb_ship_to_address"),
    ewbCancelledAt: timestamp("ewb_cancelled_at", { withTimezone: true }),
    ewbCancelReason: text("ewb_cancel_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    orgNumber: uniqueIndex("sales_orders_org_number_idx").on(t.organizationId, t.orderNumber),
    orgShopifyOrder: uniqueIndex("sales_orders_org_shopify_order_idx").on(
      t.organizationId,
      t.shopifyOrderId,
    ),
  }),
);

export const salesOrderLinesTable = pgTable("sales_order_lines", {
  id: serial("id").primaryKey(),
  salesOrderId: integer("sales_order_id")
    .notNull()
    .references(() => salesOrdersTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id")
    .notNull()
    .references(() => itemsTable.id, { onDelete: "restrict" }),
  description: text("description"),
  quantity: numeric("quantity", { precision: 14, scale: 2 }).notNull(),
  quantityShipped: numeric("quantity_shipped", { precision: 14, scale: 2 })
    .notNull()
    .default("0"),
  unitPrice: numeric("unit_price", { precision: 14, scale: 2 }).notNull(),
  taxRate: numeric("tax_rate", { precision: 6, scale: 2 }).notNull().default("0"),
  lineSubtotal: numeric("line_subtotal", { precision: 14, scale: 2 }).notNull(),
  lineTax: numeric("line_tax", { precision: 14, scale: 2 }).notNull(),
  lineTotal: numeric("line_total", { precision: 14, scale: 2 }).notNull(),
});

export type SalesOrder = typeof salesOrdersTable.$inferSelect;
export type SalesOrderLine = typeof salesOrderLinesTable.$inferSelect;
