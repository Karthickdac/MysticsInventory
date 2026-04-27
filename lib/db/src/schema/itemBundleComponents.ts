import {
  pgTable,
  serial,
  integer,
  numeric,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { itemsTable } from "./items";

export const itemBundleComponentsTable = pgTable(
  "item_bundle_components",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    parentItemId: integer("parent_item_id")
      .notNull()
      .references(() => itemsTable.id, { onDelete: "cascade" }),
    componentItemId: integer("component_item_id")
      .notNull()
      .references(() => itemsTable.id, { onDelete: "restrict" }),
    quantityPerBundle: numeric("quantity_per_bundle", {
      precision: 14,
      scale: 2,
    })
      .notNull()
      .default("1"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    parentComponent: uniqueIndex("item_bundle_components_parent_comp_idx").on(
      t.parentItemId,
      t.componentItemId,
    ),
    orgParent: index("item_bundle_components_org_parent_idx").on(
      t.organizationId,
      t.parentItemId,
    ),
    orgComponent: index("item_bundle_components_org_comp_idx").on(
      t.organizationId,
      t.componentItemId,
    ),
  }),
);

export type ItemBundleComponent = typeof itemBundleComponentsTable.$inferSelect;
