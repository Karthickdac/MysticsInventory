import {
  pgTable,
  serial,
  integer,
  text,
  numeric,
  timestamp,
  index,
  uniqueIndex,
  boolean,
  jsonb,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";

export const itemsTable = pgTable(
  "items",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category"),
    unit: text("unit").notNull().default("pcs"),
    salePrice: numeric("sale_price", { precision: 14, scale: 2 }).notNull().default("0"),
    purchasePrice: numeric("purchase_price", { precision: 14, scale: 2 }).notNull().default("0"),
    hsnCode: text("hsn_code"),
    taxRate: numeric("tax_rate", { precision: 6, scale: 2 }).notNull().default("0"),
    reorderLevel: numeric("reorder_level", { precision: 14, scale: 2 }).notNull().default("0"),
    imageUrl: text("image_url"),
    parentItemId: integer("parent_item_id").references(
      (): AnyPgColumn => itemsTable.id,
      { onDelete: "cascade" },
    ),
    hasVariants: boolean("has_variants").notNull().default(false),
    variantOptions: jsonb("variant_options"),
    shopifyProductId: text("shopify_product_id"),
    shopifyVariantId: text("shopify_variant_id"),
    shopifyInventoryItemId: text("shopify_inventory_item_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    orgSku: uniqueIndex("items_org_sku_idx").on(t.organizationId, t.sku),
    // Variant-table lookups: "give me all children of this parent
    // within the org". Without this, the variant matrix on a parent
    // item detail page does a full org scan.
    orgParent: index("items_org_parent_idx").on(
      t.organizationId,
      t.parentItemId,
    ),
    // Idempotent Shopify resync: match-by-variant-id is the primary
    // upsert key now, so we want a fast lookup.
    orgShopifyVariant: index("items_org_shopify_variant_idx").on(
      t.organizationId,
      t.shopifyVariantId,
    ),
  }),
);

export type Item = typeof itemsTable.$inferSelect;
