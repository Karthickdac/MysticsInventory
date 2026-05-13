import { Router, type IRouter } from "express";
import { and, eq, ilike, or, sql, asc, inArray } from "drizzle-orm";
import {
  db,
  itemsTable,
  itemBundleComponentsTable,
  itemWarehouseStockTable,
  itemBatchesTable,
  warehousesTable,
  stockMovementsTable,
} from "@workspace/db";
import {
  tenantMiddleware,
  getDefaultWarehouseId,
  assertOwnership,
} from "../lib/tenant";
import {
  serializeItem,
  serializeItemBatch,
  serializeStockMovement,
} from "../lib/serializers";
import { toNum, toStr } from "../lib/numeric";
import { pushStockToShopify } from "../lib/shopifyOutbound";
import {
  generateUniqueBarcode,
  findBarcodeOwner,
  isBarcodeUniqueViolation,
} from "../lib/barcodeGen";
import {
  loadBundleComponents,
  computeBundleStockByWarehouse,
  computeBundleTotalsForMany,
} from "../lib/bundles";
import { getBatchAvailability } from "../lib/batches";

const router: IRouter = Router();
router.use(tenantMiddleware);

async function totalStockFor(
  orgId: number,
  itemIds: number[],
): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (itemIds.length === 0) return map;
  const rows = await db
    .select({
      itemId: itemWarehouseStockTable.itemId,
      qty: sql<string>`COALESCE(SUM(${itemWarehouseStockTable.quantity}), 0)`,
    })
    .from(itemWarehouseStockTable)
    .where(
      and(
        eq(itemWarehouseStockTable.organizationId, orgId),
        inArray(itemWarehouseStockTable.itemId, itemIds),
      ),
    )
    .groupBy(itemWarehouseStockTable.itemId);
  for (const r of rows) map.set(r.itemId, toNum(r.qty));
  return map;
}

async function variantCountsFor(
  orgId: number,
  parentIds: number[],
): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (parentIds.length === 0) return map;
  const rows = await db
    .select({
      parentItemId: itemsTable.parentItemId,
      c: sql<string>`COUNT(*)`,
    })
    .from(itemsTable)
    .where(
      and(
        eq(itemsTable.organizationId, orgId),
        inArray(itemsTable.parentItemId, parentIds),
      ),
    )
    .groupBy(itemsTable.parentItemId);
  for (const r of rows) {
    if (r.parentItemId != null) map.set(r.parentItemId, Number(r.c));
  }
  return map;
}

router.get("/items", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const lowStock = req.query.lowStock === "true";
    const leafOnly = req.query.leafOnly === "true";
    const excludeVariants = req.query.excludeVariants === "true";
    const includeWarehouseBreakdown =
      req.query.includeWarehouseBreakdown === "true";
    let warehouseId: number | null = null;
    if (
      req.query.warehouseId !== undefined &&
      req.query.warehouseId !== ""
    ) {
      const raw = String(req.query.warehouseId);
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        res
          .status(400)
          .json({ error: "warehouseId must be a positive integer" });
        return;
      }
      warehouseId = n;
    }
    const conds = [
      eq(itemsTable.organizationId, t.organizationId),
      // Hide soft-deleted (archived) items from the catalog list.
      sql`${itemsTable.archivedAt} IS NULL`,
    ];
    if (search) {
      conds.push(
        or(
          ilike(itemsTable.name, `%${search}%`),
          ilike(itemsTable.sku, `%${search}%`),
        )!,
      );
    }
    if (leafOnly) {
      // Pickers want only items that can hold stock — exclude parents.
      conds.push(eq(itemsTable.hasVariants, false));
    }
    if (excludeVariants) {
      // Items list (tree view) wants top-level rows only; the client
      // expands a parent to fetch its variants on demand.
      conds.push(sql`${itemsTable.parentItemId} IS NULL`);
    }
    const rows = await db
      .select()
      .from(itemsTable)
      .where(and(...conds))
      .orderBy(asc(itemsTable.name));
    const itemIds = rows.map((r) => r.id);
    const stockMap = await totalStockFor(t.organizationId, itemIds);
    const parentIds = rows
      .filter((r) => r.hasVariants)
      .map((r) => r.id);
    const vcountMap = await variantCountsFor(t.organizationId, parentIds);
    // Bundles have no physical stock — replace their totals with the
    // derived "how many bundles can I assemble" figure.
    const bundleIds = rows.filter((r) => r.isBundle).map((r) => r.id);
    const bundleTotals = await computeBundleTotalsForMany(
      t.organizationId,
      bundleIds,
    );
    for (const id of bundleIds) {
      stockMap.set(id, bundleTotals.get(id) ?? 0);
    }

    let warehouseStockMap = new Map<number, number>();
    if (warehouseId && itemIds.length > 0) {
      const stockRows = await db
        .select({
          itemId: itemWarehouseStockTable.itemId,
          quantity: itemWarehouseStockTable.quantity,
        })
        .from(itemWarehouseStockTable)
        .where(
          and(
            eq(itemWarehouseStockTable.organizationId, t.organizationId),
            eq(itemWarehouseStockTable.warehouseId, warehouseId),
            inArray(itemWarehouseStockTable.itemId, itemIds),
          ),
        );
      for (const r of stockRows) {
        warehouseStockMap.set(r.itemId, toNum(r.quantity));
      }
      // Override warehouse stock for bundles with the derived figure.
      for (const id of bundleIds) {
        const perWh = await computeBundleStockByWarehouse(
          t.organizationId,
          id,
        );
        const found = perWh.find((w) => w.warehouseId === warehouseId);
        warehouseStockMap.set(id, found?.quantity ?? 0);
      }
    }

    // Per-warehouse breakdown for the items list. One JOIN'd query for
    // physical items, then per-bundle derived breakdowns layered on top.
    // Excludes virtual job-worker warehouses (the picker hides them too).
    const breakdownMap = new Map<
      number,
      Array<{ warehouseId: number; warehouseName: string; quantity: number }>
    >();
    if (includeWarehouseBreakdown && itemIds.length > 0) {
      const physicalIds = rows.filter((r) => !r.isBundle).map((r) => r.id);
      if (physicalIds.length > 0) {
        const breakdownRows = await db
          .select({
            itemId: itemWarehouseStockTable.itemId,
            warehouseId: itemWarehouseStockTable.warehouseId,
            warehouseName: warehousesTable.name,
            quantity: itemWarehouseStockTable.quantity,
          })
          .from(itemWarehouseStockTable)
          .innerJoin(
            warehousesTable,
            and(
              eq(warehousesTable.id, itemWarehouseStockTable.warehouseId),
              eq(warehousesTable.organizationId, t.organizationId),
              eq(warehousesTable.isVirtual, false),
            ),
          )
          .where(
            and(
              eq(itemWarehouseStockTable.organizationId, t.organizationId),
              inArray(itemWarehouseStockTable.itemId, physicalIds),
              sql`${itemWarehouseStockTable.quantity} > 0`,
            ),
          );
        for (const r of breakdownRows) {
          if (!breakdownMap.has(r.itemId)) breakdownMap.set(r.itemId, []);
          breakdownMap.get(r.itemId)!.push({
            warehouseId: r.warehouseId,
            warehouseName: r.warehouseName,
            quantity: toNum(r.quantity),
          });
        }
      }
      // Bundles: derive per-warehouse from components and resolve names.
      if (bundleIds.length > 0) {
        const allWarehouses = await db
          .select({ id: warehousesTable.id, name: warehousesTable.name })
          .from(warehousesTable)
          .where(
            and(
              eq(warehousesTable.organizationId, t.organizationId),
              eq(warehousesTable.isVirtual, false),
            ),
          );
        const whName = new Map<number, string>(
          allWarehouses.map((w) => [w.id, w.name]),
        );
        for (const id of bundleIds) {
          const perWh = await computeBundleStockByWarehouse(
            t.organizationId,
            id,
          );
          breakdownMap.set(
            id,
            perWh
              .filter((w) => w.quantity > 0 && whName.has(w.warehouseId))
              .map((w) => ({
                warehouseId: w.warehouseId,
                warehouseName: whName.get(w.warehouseId)!,
                quantity: w.quantity,
              })),
          );
        }
      }
    }

    let result = rows.map((r) =>
      serializeItem(
        r,
        stockMap.get(r.id) ?? 0,
        warehouseId ? (warehouseStockMap.get(r.id) ?? 0) : undefined,
        vcountMap.get(r.id) ?? 0,
        includeWarehouseBreakdown ? (breakdownMap.get(r.id) ?? []) : undefined,
      ),
    );
    if (lowStock) {
      result = result.filter(
        (i) => i.totalStock <= i.reorderLevel && i.reorderLevel > 0,
      );
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

type ParsedComponent = {
  componentItemId: number;
  quantityPerBundle: number;
};

/**
 * Validate the bundle components payload from POST/PATCH /items.
 * Returns either a parsed list (sorted, deduped) or a structured error.
 *
 * Each input row must have a positive integer `componentItemId` and a
 * positive `quantityPerBundle`. The same component cannot appear twice.
 */
function parseComponents(
  input: unknown,
): ParsedComponent[] | { error: string } {
  if (!Array.isArray(input)) {
    return { error: "components must be an array" };
  }
  const out: ParsedComponent[] = [];
  const seen = new Set<number>();
  for (const c of input) {
    if (!c || typeof c !== "object") {
      return { error: "Each component must be an object" };
    }
    const cid = Number((c as { componentItemId?: unknown }).componentItemId);
    const qty = toNum(
      (c as { quantityPerBundle?: unknown }).quantityPerBundle as
        | string
        | number
        | null
        | undefined,
    );
    if (!Number.isInteger(cid) || cid <= 0) {
      return { error: "componentItemId must be a positive integer" };
    }
    if (!(qty > 0)) {
      return {
        error: "quantityPerBundle must be a number greater than zero",
      };
    }
    if (seen.has(cid)) {
      return { error: `Duplicate componentItemId: ${cid}` };
    }
    seen.add(cid);
    out.push({ componentItemId: cid, quantityPerBundle: qty });
  }
  return out;
}

/**
 * Validate that every supplied component id refers to an existing,
 * stockable item in the same org — i.e. not a parent (hasVariants),
 * not another bundle (no nested bundles for P0), and not the parent
 * bundle itself.
 */
async function validateComponentsAreStockable(
  organizationId: number,
  parentItemId: number | null,
  components: ParsedComponent[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (components.length === 0) return { ok: true };
  const ids = components.map((c) => c.componentItemId);
  if (parentItemId != null && ids.includes(parentItemId)) {
    return {
      ok: false,
      error: "A bundle cannot include itself as a component",
    };
  }
  const rows = await db
    .select({
      id: itemsTable.id,
      sku: itemsTable.sku,
      hasVariants: itemsTable.hasVariants,
      isBundle: itemsTable.isBundle,
    })
    .from(itemsTable)
    .where(
      and(
        eq(itemsTable.organizationId, organizationId),
        inArray(itemsTable.id, ids),
      ),
    );
  if (rows.length !== ids.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    return {
      ok: false,
      error: `Component item not found: ${missing.join(", ")}`,
    };
  }
  for (const r of rows) {
    if (r.hasVariants) {
      return {
        ok: false,
        error: `Component ${r.sku} is a variant parent. Pick a specific variant instead.`,
      };
    }
    if (r.isBundle) {
      return {
        ok: false,
        error: `Component ${r.sku} is itself a bundle. Nested bundles are not supported.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Validate parent variantOptions payload. Parents store their axis
 * definition as `{ axes: ["Size", "Color"], values?: { Size: [...] } }`.
 * Only `axes` is required; `values` is optional metadata.
 */
function parseAxes(input: unknown): string[] | { error: string } {
  if (!input || typeof input !== "object") {
    return { error: "variantOptions must be an object with an `axes` array" };
  }
  const axes = (input as { axes?: unknown }).axes;
  if (!Array.isArray(axes) || axes.length === 0 || axes.length > 3) {
    return { error: "variantOptions.axes must be an array of 1-3 axis names" };
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of axes) {
    if (typeof a !== "string" || a.trim().length === 0) {
      return { error: "Each axis name must be a non-empty string" };
    }
    const trimmed = a.trim();
    if (seen.has(trimmed)) {
      return { error: `Duplicate axis name: ${trimmed}` };
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

router.post("/items", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const b = req.body ?? {};
    if (!b.sku || !b.name || !b.unit) {
      res.status(400).json({ error: "sku, name and unit are required" });
      return;
    }
    const hasVariants = !!b.hasVariants;
    const isBundle = !!b.isBundle;
    const trackBatches = !!b.trackBatches;
    if (hasVariants && isBundle) {
      res.status(400).json({
        error: "An item cannot be both a variant parent and a bundle",
      });
      return;
    }
    if (trackBatches && hasVariants) {
      res.status(400).json({
        error:
          "Variant parents do not hold physical stock. Enable batch tracking on each variant instead.",
      });
      return;
    }
    if (trackBatches && isBundle) {
      res.status(400).json({
        error:
          "Bundles do not hold physical stock — batch tracking is not allowed on bundle items.",
      });
      return;
    }
    let parentVariantOptions: { axes: string[] } | null = null;
    if (hasVariants) {
      const parsed = parseAxes(b.variantOptions);
      if (!Array.isArray(parsed)) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      parentVariantOptions = { axes: parsed };
    }

    // Bundle components: parsed up front so a bad payload doesn't
    // result in a half-created item.
    let bundleComponents: ParsedComponent[] = [];
    if (isBundle) {
      const raw = b.components ?? [];
      const parsed = parseComponents(raw);
      if (!Array.isArray(parsed)) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      if (parsed.length === 0) {
        res.status(400).json({
          error: "A bundle must include at least one component",
        });
        return;
      }
      const check = await validateComponentsAreStockable(
        t.organizationId,
        null,
        parsed,
      );
      if (!check.ok) {
        res.status(400).json({ error: check.error });
        return;
      }
      bundleComponents = parsed;
    }

    // Resolve opening stock + warehouse before the insert so a failed
    // ownership check can't orphan a half-created item row. Bundles
    // don't carry physical stock — they get their on-hand from
    // components — so opening stock is rejected there.
    let openingStock = 0;
    let openingWarehouseId: number | null = null;
    if (isBundle && toNum(b.openingStock) !== 0) {
      res.status(400).json({
        error: "Bundles have no physical stock — opening stock is not allowed",
      });
      return;
    }
    if (!hasVariants && !isBundle) {
      openingStock = toNum(b.openingStock);
      if (openingStock > 0) {
        const requestedWh = Number(b.openingWarehouseId);
        if (requestedWh) {
          const own = await assertOwnership({
            organizationId: t.organizationId,
            warehouseIds: [requestedWh],
          });
          if (!own.ok) {
            res.status(400).json({ error: `Invalid ${own.missing}` });
            return;
          }
          openingWarehouseId = requestedWh;
        } else {
          openingWarehouseId = await getDefaultWarehouseId(t.organizationId);
        }
      }
    }

    const userBarcode = (() => {
      if (b.barcode == null) return null;
      const s = String(b.barcode).trim();
      return s ? s : null;
    })();
    if (userBarcode !== null && userBarcode.length > 64) {
      res.status(400).json({ error: "barcode must be 64 characters or fewer" });
      return;
    }
    if (userBarcode !== null) {
      const owner = await findBarcodeOwner(t.organizationId, userBarcode);
      if (owner) {
        res.status(409).json({
          error: `Barcode "${userBarcode}" is already used by ${owner.sku} (${owner.name}).`,
          conflictItemId: owner.id,
        });
        return;
      }
    }
    // Parents/bundles get a barcode just like leaf items so labels can
    // be printed for any catalog row. Auto-generate when the user
    // didn't supply one. We retry on the per-org partial unique index
    // collision (race with another concurrent insert) by regenerating
    // the auto value; manual values surface as a 409 immediately.
    let item: typeof itemsTable.$inferSelect | undefined;
    let lastBarcodeVal: string | null = null;
    const isManualBarcode = userBarcode !== null;
    const MAX_AUTOGEN_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_AUTOGEN_RETRIES; attempt++) {
      try {
        item = await db.transaction(async (tx) => {
          let barcodeVal: string | null = userBarcode;
          let barcodeSource: "manual" | "auto" | null = null;
          if (barcodeVal !== null) {
            barcodeSource = "manual";
          } else {
            barcodeVal = await generateUniqueBarcode(t.organizationId, tx);
            barcodeSource = "auto";
          }
          lastBarcodeVal = barcodeVal;
          const inserted = await tx
            .insert(itemsTable)
            .values({
              organizationId: t.organizationId,
              sku: b.sku,
              name: b.name,
              description: b.description ?? null,
              category: b.category ?? null,
              unit: b.unit,
              barcode: barcodeVal,
              barcodeSource,
              salePrice: toStr(b.salePrice ?? 0),
              purchasePrice: toStr(b.purchasePrice ?? 0),
              hsnCode: b.hsnCode ?? null,
              taxRate: toStr(b.taxRate ?? 0),
              reorderLevel: toStr(b.reorderLevel ?? 0),
              imageUrl: b.imageUrl ?? null,
              hasVariants,
              isBundle,
              trackBatches,
              variantOptions: parentVariantOptions,
            })
            .returning();
          const created = inserted[0]!;
          if (!hasVariants && !isBundle && openingStock > 0 && openingWarehouseId) {
            await tx.insert(itemWarehouseStockTable).values({
              organizationId: t.organizationId,
              itemId: created.id,
              warehouseId: openingWarehouseId,
              quantity: toStr(openingStock),
            });
            await tx.insert(stockMovementsTable).values({
              organizationId: t.organizationId,
              itemId: created.id,
              warehouseId: openingWarehouseId,
              movementType: "opening",
              quantity: toStr(openingStock),
              notes: "Opening stock",
            });
          }
          if (isBundle && bundleComponents.length > 0) {
            await tx.insert(itemBundleComponentsTable).values(
              bundleComponents.map((c) => ({
                organizationId: t.organizationId,
                parentItemId: created.id,
                componentItemId: c.componentItemId,
                quantityPerBundle: toStr(c.quantityPerBundle),
              })),
            );
          }
          return created;
        });
        break;
      } catch (err) {
        if (isBarcodeUniqueViolation(err)) {
          if (isManualBarcode) {
            const owner = await findBarcodeOwner(t.organizationId, userBarcode!);
            res.status(409).json({
              error: owner
                ? `Barcode "${userBarcode}" is already used by ${owner.sku} (${owner.name}).`
                : `Barcode "${userBarcode}" is already in use.`,
              conflictItemId: owner?.id ?? null,
            });
            return;
          }
          if (attempt < MAX_AUTOGEN_RETRIES - 1) continue;
          res.status(409).json({
            error: `Could not allocate a unique auto-barcode after ${MAX_AUTOGEN_RETRIES} attempts. Please retry.`,
            conflictItemId: null,
          });
          return;
        }
        throw err;
      }
    }
    if (!item) {
      // Should be unreachable — retry loop either succeeds or returns a
      // 409 above. Defensive guard so TypeScript narrows the variable.
      throw new Error(`Failed to insert item (last barcode: ${lastBarcodeVal})`);
    }
    if (!hasVariants && !isBundle && openingStock > 0) {
      pushStockToShopify(t.organizationId, item.id);
    }

    res.status(201).json(serializeItem(item, openingStock));
  } catch (err) {
    next(err);
  }
});

const MAX_BULK_IMPORT_ROWS = 1000;

interface BulkParsedRow {
  index: number;
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  unit: string;
  barcode: string | null;
  salePrice: number;
  purchasePrice: number;
  hsnCode: string | null;
  taxRate: number;
  reorderLevel: number;
}

interface BulkResultRow {
  index: number;
  sku: string;
  action: "create" | "update" | "error";
  error?: string;
}

function bulkFieldString(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function bulkOptionalString(v: unknown): string | null {
  const s = bulkFieldString(v);
  return s ? s : null;
}

function bulkParseNumber(
  v: unknown,
  defaultVal: number,
): { ok: true; value: number } | { ok: false } {
  if (v == null || v === "") return { ok: true, value: defaultVal };
  const n = Number(v);
  if (!Number.isFinite(n)) return { ok: false };
  return { ok: true, value: n };
}

router.post("/items/bulk-import", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const body = req.body ?? {};
    const mode: "create" | "upsert" =
      body.mode === "upsert" ? "upsert" : "create";
    const dryRun = !!body.dryRun;
    const rawRows = Array.isArray(body.rows) ? body.rows : null;
    if (!rawRows) {
      res.status(400).json({ error: "rows must be an array" });
      return;
    }
    if (rawRows.length === 0) {
      res.status(400).json({ error: "rows is empty" });
      return;
    }
    if (rawRows.length > MAX_BULK_IMPORT_ROWS) {
      res
        .status(400)
        .json({ error: `Maximum ${MAX_BULK_IMPORT_ROWS} rows per import` });
      return;
    }

    const parsedRows: (BulkParsedRow | null)[] = [];
    const results: BulkResultRow[] = [];
    const seenSkus = new Map<string, number>(); // sku -> first 1-based index

    rawRows.forEach((row: unknown, i: number) => {
      const idx = i + 1;
      const r = (row as Record<string, unknown>) ?? {};
      const sku = bulkFieldString(r.sku);
      const name = bulkFieldString(r.name);
      const fail = (error: string) => {
        parsedRows.push(null);
        results.push({ index: idx, sku, action: "error", error });
      };
      if (!sku) {
        fail("sku is required");
        return;
      }
      if (!name) {
        fail("name is required");
        return;
      }
      if (sku.length > 100) {
        fail("sku must be 100 characters or fewer");
        return;
      }
      if (name.length > 200) {
        fail("name must be 200 characters or fewer");
        return;
      }
      const seenAt = seenSkus.get(sku);
      if (seenAt != null) {
        fail(`Duplicate sku in upload (also on row ${seenAt})`);
        return;
      }
      seenSkus.set(sku, idx);

      const sale = bulkParseNumber(r.salePrice, 0);
      if (!sale.ok) {
        fail("salePrice is not a number");
        return;
      }
      const purchase = bulkParseNumber(r.purchasePrice, 0);
      if (!purchase.ok) {
        fail("purchasePrice is not a number");
        return;
      }
      const tax = bulkParseNumber(r.taxRate, 0);
      if (!tax.ok) {
        fail("taxRate is not a number");
        return;
      }
      const reorder = bulkParseNumber(r.reorderLevel, 0);
      if (!reorder.ok) {
        fail("reorderLevel is not a number");
        return;
      }
      if (sale.value < 0 || purchase.value < 0 || reorder.value < 0) {
        fail("Prices and reorder level cannot be negative");
        return;
      }
      if (tax.value < 0 || tax.value > 100) {
        fail("taxRate must be between 0 and 100");
        return;
      }

      const unit = bulkFieldString(r.unit) || "pcs";
      const description = bulkOptionalString(r.description);
      const category = bulkOptionalString(r.category);
      const hsnCode = bulkOptionalString(r.hsnCode);
      const barcode = bulkOptionalString(r.barcode);
      if (description !== null && description.length > 2000) {
        fail("description is too long (max 2000)");
        return;
      }
      if (category !== null && category.length > 100) {
        fail("category is too long (max 100)");
        return;
      }
      if (hsnCode !== null && hsnCode.length > 32) {
        fail("hsnCode is too long (max 32)");
        return;
      }
      if (unit.length > 32) {
        fail("unit is too long (max 32)");
        return;
      }
      if (barcode !== null && barcode.length > 64) {
        fail("barcode is too long (max 64)");
        return;
      }

      parsedRows.push({
        index: idx,
        sku,
        name,
        description,
        category,
        unit,
        barcode,
        salePrice: sale.value,
        purchasePrice: purchase.value,
        hsnCode,
        taxRate: tax.value,
        reorderLevel: reorder.value,
      });
      results.push({ index: idx, sku, action: "create" });
    });

    // Look up existing items by sku for this organization
    const candidateSkus = parsedRows
      .filter((r): r is BulkParsedRow => r !== null)
      .map((r) => r.sku);
    const existingMap = new Map<
      string,
      {
        id: number;
        hasVariants: boolean;
        isBundle: boolean;
        parentItemId: number | null;
        trackBatches: boolean;
      }
    >();
    if (candidateSkus.length > 0) {
      const existing = await db
        .select({
          id: itemsTable.id,
          sku: itemsTable.sku,
          hasVariants: itemsTable.hasVariants,
          isBundle: itemsTable.isBundle,
          parentItemId: itemsTable.parentItemId,
          trackBatches: itemsTable.trackBatches,
        })
        .from(itemsTable)
        .where(
          and(
            eq(itemsTable.organizationId, t.organizationId),
            inArray(itemsTable.sku, candidateSkus),
            // Mirror the partial unique index: archived rows never
            // count as a SKU collision, so bulk-import can re-use
            // a SKU previously held by an archived item.
            sql`${itemsTable.archivedAt} IS NULL`,
          ),
        );
      for (const e of existing) {
        existingMap.set(e.sku, {
          id: e.id,
          hasVariants: e.hasVariants,
          isBundle: e.isBundle,
          parentItemId: e.parentItemId,
          trackBatches: e.trackBatches,
        });
      }
    }

    // Resolve final action per row
    for (let i = 0; i < parsedRows.length; i++) {
      const p = parsedRows[i];
      if (!p) continue;
      const existing = existingMap.get(p.sku);
      if (!existing) {
        results[i] = { ...results[i], action: "create" };
        continue;
      }
      if (mode === "create") {
        results[i] = {
          ...results[i],
          action: "error",
          error:
            "sku already exists. Choose Upsert mode to update existing items.",
        };
        parsedRows[i] = null;
        continue;
      }
      // Upsert mode — refuse to clobber complex items.
      if (
        existing.hasVariants ||
        existing.isBundle ||
        existing.parentItemId != null ||
        existing.trackBatches
      ) {
        results[i] = {
          ...results[i],
          action: "error",
          error:
            "Existing item is a variant, bundle, or batch-tracked. Bulk update is not supported — edit it individually.",
        };
        parsedRows[i] = null;
        continue;
      }
      results[i] = { ...results[i], action: "update" };
    }

    const counts = {
      create: results.filter((r) => r.action === "create").length,
      update: results.filter((r) => r.action === "update").length,
      error: results.filter((r) => r.action === "error").length,
    };

    if (dryRun) {
      res.status(200).json({ results, counts });
      return;
    }
    if (counts.error > 0) {
      res.status(400).json({ results, counts });
      return;
    }

    // Pre-flight: any user-supplied barcode in a CREATE row must be
    // free in this org (we let the unique index catch races, but the
    // upfront check produces a friendly error message tied to the row
    // index). Also reject intra-batch duplicate barcodes.
    {
      const seenBarcodes = new Map<string, number>();
      const userBarcodes: string[] = [];
      for (let i = 0; i < parsedRows.length; i++) {
        const p = parsedRows[i];
        if (!p || !p.barcode) continue;
        const r = results[i];
        if (r.action !== "create" && r.action !== "update") continue;
        const seenAt = seenBarcodes.get(p.barcode);
        if (seenAt !== undefined) {
          results[i] = {
            ...results[i],
            action: "error",
            error: `Duplicate barcode in upload (also on row ${seenAt})`,
          };
          parsedRows[i] = null;
          continue;
        }
        seenBarcodes.set(p.barcode, p.index);
        userBarcodes.push(p.barcode);
      }
      if (userBarcodes.length > 0) {
        const taken = await db
          .select({
            id: itemsTable.id,
            sku: itemsTable.sku,
            barcode: itemsTable.barcode,
          })
          .from(itemsTable)
          .where(
            and(
              eq(itemsTable.organizationId, t.organizationId),
              inArray(itemsTable.barcode, userBarcodes),
              sql`${itemsTable.archivedAt} IS NULL`,
            ),
          );
        const takenMap = new Map(taken.map((r) => [r.barcode!, r]));
        for (let i = 0; i < parsedRows.length; i++) {
          const p = parsedRows[i];
          if (!p || !p.barcode) continue;
          const owner = takenMap.get(p.barcode);
          if (!owner) continue;
          // For an update row matching its own existing item, allow it.
          if (results[i].action === "update") {
            const existing = existingMap.get(p.sku);
            if (existing && existing.id === owner.id) continue;
          }
          results[i] = {
            ...results[i],
            action: "error",
            error: `Barcode "${p.barcode}" is already used by ${owner.sku}`,
          };
          parsedRows[i] = null;
        }
      }
      // Recount after barcode-duplicate downgrades.
      counts.create = results.filter((r) => r.action === "create").length;
      counts.update = results.filter((r) => r.action === "update").length;
      counts.error = results.filter((r) => r.action === "error").length;
      if (counts.error > 0) {
        res.status(400).json({ results, counts });
        return;
      }
    }

    // Commit. Bounded retry around the whole txn so a per-org
    // unique-barcode race (another writer claimed the same auto value
    // between our generation and our insert) re-runs with a fresh
    // sequence lookup instead of failing the whole batch.
    const MAX_BULK_RETRIES = 3;
    let bulkCommitted = false;
    for (let attempt = 0; attempt < MAX_BULK_RETRIES; attempt++) {
      try {
        await db.transaction(async (tx) => {
      for (let i = 0; i < parsedRows.length; i++) {
        const p = parsedRows[i];
        if (!p) continue;
        const r = results[i];
        if (r.action === "create") {
          // Auto-generate inside the txn (passing `tx` as executor) so
          // freshly inserted values from earlier rows in this same
          // batch participate in the next sequence lookup. Each call
          // already checks for uniqueness; the partial unique index
          // is the final guard.
          let bc: string | null = p.barcode;
          let bcSrc: "manual" | "auto" = "manual";
          if (bc === null) {
            bc = await generateUniqueBarcode(t.organizationId, tx);
            bcSrc = "auto";
          }
          await tx.insert(itemsTable).values({
            organizationId: t.organizationId,
            sku: p.sku,
            name: p.name,
            description: p.description,
            category: p.category,
            unit: p.unit,
            barcode: bc,
            barcodeSource: bcSrc,
            salePrice: toStr(p.salePrice),
            purchasePrice: toStr(p.purchasePrice),
            hsnCode: p.hsnCode,
            taxRate: toStr(p.taxRate),
            reorderLevel: toStr(p.reorderLevel),
          });
        } else if (r.action === "update") {
          const existing = existingMap.get(p.sku)!;
          // In upsert mode we only overwrite barcode when the row
          // actually carries one — leaving the existing value in place
          // when the CSV column is blank avoids surprising
          // "bulk-import wiped my barcodes" reports. When we DO update
          // the barcode we also flip `barcodeSource` to `manual` so the
          // Auto/Manual badge stays accurate for imported values.
          const barcodeUpdate =
            p.barcode === null
              ? {}
              : {
                  barcode: p.barcode,
                  barcodeSource: "manual" as const,
                };
          await tx
            .update(itemsTable)
            .set({
              name: p.name,
              description: p.description,
              category: p.category,
              unit: p.unit,
              ...barcodeUpdate,
              salePrice: toStr(p.salePrice),
              purchasePrice: toStr(p.purchasePrice),
              hsnCode: p.hsnCode,
              taxRate: toStr(p.taxRate),
              reorderLevel: toStr(p.reorderLevel),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(itemsTable.id, existing.id),
                eq(itemsTable.organizationId, t.organizationId),
              ),
            );
        }
      }
        });
        bulkCommitted = true;
        break;
      } catch (err) {
        if (
          isBarcodeUniqueViolation(err) &&
          attempt < MAX_BULK_RETRIES - 1
        ) {
          continue;
        }
        throw err;
      }
    }
    if (!bulkCommitted) {
      res.status(409).json({
        error: `Could not allocate unique auto-barcodes for the batch after ${MAX_BULK_RETRIES} attempts. Please retry.`,
      });
      return;
    }

    res.status(200).json({ results, counts });
  } catch (err) {
    next(err);
  }
});

/**
 * Resolve a scanned/typed code to an item: barcode first (so a custom
 * barcode wins over a SKU collision), then sku. Used by the camera
 * scanner UX and by power users who type a code into the search bar.
 *
 * Multiple items with the same barcode is data-entry user error; we
 * return the first match deterministically and never throw — the UI
 * still has the manual fallback.
 *
 * Defined before /items/:id so the literal "lookup" segment doesn't
 * get parsed as an integer id and 404 in NaN-land.
 */
router.get("/items/lookup", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const raw = typeof req.query.code === "string" ? req.query.code.trim() : "";
    if (!raw) {
      res.status(400).json({ error: "code query parameter is required" });
      return;
    }
    if (raw.length > 128) {
      res.status(400).json({ error: "code is too long" });
      return;
    }
    // Single round-trip: prefer a barcode hit, fall back to sku.
    // Order by id so duplicate-barcode collisions resolve to the same
    // row across calls (deterministic) — the UI still has the manual
    // fallback when picks are ambiguous.
    const rows = await db
      .select()
      .from(itemsTable)
      .where(
        and(
          eq(itemsTable.organizationId, t.organizationId),
          // Archived items shouldn't show up in barcode scans or
          // SKU lookups used by pickers.
          sql`${itemsTable.archivedAt} IS NULL`,
          or(eq(itemsTable.barcode, raw), eq(itemsTable.sku, raw))!,
        ),
      )
      .orderBy(itemsTable.id)
      .limit(5);
    if (rows.length === 0) {
      res.status(404).json({ error: "No item found for that code" });
      return;
    }
    // Barcode match takes priority; fall back to first sku hit.
    const item =
      rows.find((r) => r.barcode === raw) ?? rows.find((r) => r.sku === raw)!;
    const stockMap = await totalStockFor(t.organizationId, [item.id]);
    res.json(serializeItem(item, stockMap.get(item.id) ?? 0));
  } catch (err) {
    next(err);
  }
});

router.get("/items/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const rows = await db
      .select()
      .from(itemsTable)
      .where(
        and(eq(itemsTable.id, id), eq(itemsTable.organizationId, t.organizationId)),
      )
      .limit(1);
    if (!rows[0]) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const item = rows[0];

    const stockRows = await db
      .select({
        warehouseId: itemWarehouseStockTable.warehouseId,
        warehouseName: warehousesTable.name,
        quantity: itemWarehouseStockTable.quantity,
      })
      .from(itemWarehouseStockTable)
      .innerJoin(
        warehousesTable,
        eq(warehousesTable.id, itemWarehouseStockTable.warehouseId),
      )
      .where(
        and(
          eq(itemWarehouseStockTable.organizationId, t.organizationId),
          eq(itemWarehouseStockTable.itemId, id),
        ),
      );

    let total = stockRows.reduce((s, r) => s + toNum(r.quantity), 0);

    // For a bundle, the per-warehouse and total stock returned are the
    // derived "how many bundles can I assemble" figures, not the raw
    // (always-zero) row in itemWarehouseStock.
    let bundleStockByWarehouse: Array<{
      warehouseId: number;
      warehouseName: string;
      quantity: number;
    }> = [];
    let components: Array<{
      id: number;
      componentItemId: number;
      componentSku: string;
      componentName: string;
      quantityPerBundle: number;
    }> = [];
    if (item.isBundle) {
      bundleStockByWarehouse = await computeBundleStockByWarehouse(
        t.organizationId,
        id,
      );
      total = bundleStockByWarehouse.reduce((s, r) => s + r.quantity, 0);
      components = await loadBundleComponents(t.organizationId, id);
    }

    // If this is a parent, load its variants with their per-warehouse
    // stock so the UI can render the variants matrix in one round-trip.
    let variants: Array<{
      item: ReturnType<typeof serializeItem>;
      stockByWarehouse: Array<{
        warehouseId: number;
        warehouseName: string;
        quantity: number;
      }>;
    }> = [];
    let variantCount = 0;
    if (item.hasVariants) {
      const childRows = await db
        .select()
        .from(itemsTable)
        .where(
          and(
            eq(itemsTable.organizationId, t.organizationId),
            eq(itemsTable.parentItemId, id),
            // Hide archived variants from the parent's variant
            // matrix (the working-set surface). Historical orders
            // that referenced an archived variant still resolve
            // it via GET /items/:id directly.
            sql`${itemsTable.archivedAt} IS NULL`,
          ),
        )
        .orderBy(asc(itemsTable.name));
      const childIds = childRows.map((r) => r.id);
      const stockTotals = await totalStockFor(t.organizationId, childIds);
      // Per-variant per-warehouse stock map (single batched query).
      const perWh = new Map<
        number,
        Array<{ warehouseId: number; warehouseName: string; quantity: number }>
      >();
      if (childIds.length > 0) {
        const wRows = await db
          .select({
            itemId: itemWarehouseStockTable.itemId,
            warehouseId: itemWarehouseStockTable.warehouseId,
            warehouseName: warehousesTable.name,
            quantity: itemWarehouseStockTable.quantity,
          })
          .from(itemWarehouseStockTable)
          .innerJoin(
            warehousesTable,
            eq(warehousesTable.id, itemWarehouseStockTable.warehouseId),
          )
          .where(
            and(
              eq(itemWarehouseStockTable.organizationId, t.organizationId),
              inArray(itemWarehouseStockTable.itemId, childIds),
            ),
          );
        for (const r of wRows) {
          if (!perWh.has(r.itemId)) perWh.set(r.itemId, []);
          perWh.get(r.itemId)!.push({
            warehouseId: r.warehouseId,
            warehouseName: r.warehouseName,
            quantity: toNum(r.quantity),
          });
        }
      }
      variants = childRows.map((c) => ({
        item: serializeItem(c, stockTotals.get(c.id) ?? 0),
        stockByWarehouse: perWh.get(c.id) ?? [],
      }));
      variantCount = childRows.length;
    }

    const stockByWarehouse = item.isBundle
      ? bundleStockByWarehouse
      : stockRows.map((r) => ({
          warehouseId: r.warehouseId,
          warehouseName: r.warehouseName,
          quantity: toNum(r.quantity),
        }));

    res.json({
      item: serializeItem(item, total, undefined, variantCount),
      stockByWarehouse,
      variants,
      components,
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/items/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const updates: Record<string, unknown> = {};
    for (const k of [
      "sku",
      "name",
      "description",
      "category",
      "unit",
      "hsnCode",
      "imageUrl",
    ]) {
      if (k in b) updates[k] = b[k];
    }
    if ("barcode" in b) {
      const raw = b.barcode;
      if (raw == null) {
        updates["barcode"] = null;
        // Clearing the barcode also clears its source so a later
        // assign-missing run can adopt the row again.
        updates["barcodeSource"] = null;
      } else {
        const s = String(raw).trim();
        if (s.length > 64) {
          res
            .status(400)
            .json({ error: "barcode must be 64 characters or fewer" });
          return;
        }
        const trimmed = s ? s : null;
        if (trimmed !== null) {
          const owner = await findBarcodeOwner(
            t.organizationId,
            trimmed,
            Number(req.params.id),
          );
          if (owner) {
            res.status(409).json({
              error: `Barcode "${trimmed}" is already used by ${owner.sku} (${owner.name}).`,
              conflictItemId: owner.id,
            });
            return;
          }
        }
        updates["barcode"] = trimmed;
        // Any value the user typed in is "manual" by definition; only
        // the auto-generator and the assign-missing endpoint mark a
        // value as "auto".
        updates["barcodeSource"] = trimmed === null ? null : "manual";
      }
    }
    for (const k of ["salePrice", "purchasePrice", "taxRate", "reorderLevel"]) {
      if (k in b) updates[k] = toStr(b[k]);
    }
    // variantOptions can only be updated on parents; keep existing axes
    // structure validated.
    let nextVariantOptions: { axes: string[] } | undefined;
    if ("variantOptions" in b && b.variantOptions != null) {
      const parsed = parseAxes(b.variantOptions);
      if (!Array.isArray(parsed)) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      nextVariantOptions = { axes: parsed };
    }

    // Check current row up front so we can decide whether to propagate
    // shared fields to children.
    const beforeRows = await db
      .select()
      .from(itemsTable)
      .where(
        and(
          eq(itemsTable.id, id),
          eq(itemsTable.organizationId, t.organizationId),
        ),
      )
      .limit(1);
    const before = beforeRows[0];
    if (!before) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // hasVariants transitions: false->true requires variantOptions and
    // forbids variants-of-variants; true->false requires zero children.
    let nextHasVariants: boolean | undefined;
    if ("hasVariants" in b && typeof b.hasVariants === "boolean") {
      nextHasVariants = b.hasVariants;
    }

    // isBundle transitions: false->true requires components and the row
    // must not currently be a variant parent or a variant child;
    // true->false drops the components in the same transaction.
    let nextIsBundle: boolean | undefined;
    if ("isBundle" in b && typeof b.isBundle === "boolean") {
      nextIsBundle = b.isBundle;
    }
    // trackBatches transitions: false->true allowed when not a parent
    // and not a bundle; true->false only when no item_batches rows
    // exist for this item (otherwise we'd orphan ledger history).
    let nextTrackBatches: boolean | undefined;
    if ("trackBatches" in b && typeof b.trackBatches === "boolean") {
      nextTrackBatches = b.trackBatches;
    }
    let nextComponents: ParsedComponent[] | undefined;
    if ("components" in b) {
      const parsed = parseComponents(b.components);
      if (!Array.isArray(parsed)) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      nextComponents = parsed;
    }
    const willBeBundle =
      nextIsBundle === undefined ? before.isBundle : nextIsBundle;
    const willHaveVariants =
      nextHasVariants === undefined ? before.hasVariants : nextHasVariants;
    const willTrackBatches =
      nextTrackBatches === undefined
        ? before.trackBatches
        : nextTrackBatches;
    if (willBeBundle && willHaveVariants) {
      res.status(400).json({
        error: "An item cannot be both a variant parent and a bundle",
      });
      return;
    }
    if (willTrackBatches && willHaveVariants) {
      res.status(400).json({
        error:
          "Variant parents do not hold physical stock. Enable batch tracking on each variant instead.",
      });
      return;
    }
    if (willTrackBatches && willBeBundle) {
      res.status(400).json({
        error:
          "Bundles do not hold physical stock — batch tracking is not allowed on bundle items.",
      });
      return;
    }
    if (nextIsBundle === true && before.parentItemId != null) {
      res.status(400).json({
        error: "Cannot turn a variant row into a bundle",
      });
      return;
    }
    if (willBeBundle && nextComponents !== undefined) {
      // Validate the new component list before we touch anything.
      const check = await validateComponentsAreStockable(
        t.organizationId,
        id,
        nextComponents,
      );
      if (!check.ok) {
        res.status(400).json({ error: check.error });
        return;
      }
      if (nextComponents.length === 0) {
        res.status(400).json({
          error: "A bundle must include at least one component",
        });
        return;
      }
    }
    // Enable bundle without supplying components: require components in
    // the same request so we never end up in a bundle-with-no-components
    // state.
    if (
      willBeBundle &&
      nextComponents === undefined &&
      !before.isBundle
    ) {
      res.status(400).json({
        error:
          "A bundle must include at least one component. Provide a non-empty components array.",
      });
      return;
    }
    if (nextIsBundle !== undefined && nextIsBundle !== before.isBundle) {
      updates["isBundle"] = nextIsBundle;
    }

    if (nextTrackBatches !== undefined && nextTrackBatches !== before.trackBatches) {
      if (nextTrackBatches === false) {
        // on -> off only allowed when no batches have ever been
        // captured for this item. We deliberately count regardless of
        // current on-hand so we don't orphan ledger history.
        const batchCount = await db
          .select({ c: sql<number>`count(*)::int` })
          .from(itemBatchesTable)
          .where(
            and(
              eq(itemBatchesTable.organizationId, t.organizationId),
              eq(itemBatchesTable.itemId, id),
            ),
          );
        if ((batchCount[0]?.c ?? 0) > 0) {
          res.status(400).json({
            error:
              "Cannot disable batch tracking once batches have been recorded for this item.",
          });
          return;
        }
      } else {
        // off -> on requires zero on-hand stock so we don't strand
        // legacy quantity that has no batch identity. Future shipments
        // for this item will require batch picks, and that pre-existing
        // stock would never be shippable.
        const onHandRow = await db
          .select({
            qty: sql<string>`COALESCE(SUM(${itemWarehouseStockTable.quantity}), 0)`,
          })
          .from(itemWarehouseStockTable)
          .where(
            and(
              eq(itemWarehouseStockTable.organizationId, t.organizationId),
              eq(itemWarehouseStockTable.itemId, id),
            ),
          );
          if (toNum(onHandRow[0]?.qty ?? "0") > 1e-6) {
            res.status(400).json({
              error:
                "Cannot enable batch tracking while this item has on-hand stock. Adjust stock to zero first, then enable batch tracking and receive new stock with batch numbers.",
            });
            return;
          }
      }
      updates["trackBatches"] = nextTrackBatches;
    }

    if (nextHasVariants === true && !before.hasVariants) {
      if (before.parentItemId != null) {
        res.status(400).json({
          error: "Cannot convert a variant into a parent",
        });
        return;
      }
      if (!nextVariantOptions) {
        res.status(400).json({
          error: "variantOptions (axes) is required when enabling hasVariants",
        });
        return;
      }
      updates["hasVariants"] = true;
      updates["variantOptions"] = nextVariantOptions;
    } else if (nextHasVariants === false && before.hasVariants) {
      const childCount = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(itemsTable)
        .where(
          and(
            eq(itemsTable.organizationId, t.organizationId),
            eq(itemsTable.parentItemId, id),
          ),
        );
      if ((childCount[0]?.c ?? 0) > 0) {
        res.status(400).json({
          error:
            "Cannot disable variants while child variants exist. Delete them first.",
        });
        return;
      }
      updates["hasVariants"] = false;
      updates["variantOptions"] = null;
    } else if (nextVariantOptions !== undefined) {
      if (!before.hasVariants) {
        res.status(400).json({
          error: "variantOptions can only be set on items with hasVariants=true",
        });
        return;
      }
      // Lock axes once children exist (UI mirrors this rule).
      const beforeAxesRaw = (
        before.variantOptions as { axes?: string[] } | null
      )?.axes;
      const sameAxes =
        Array.isArray(beforeAxesRaw) &&
        beforeAxesRaw.length === nextVariantOptions.axes.length &&
        beforeAxesRaw.every((a, i) => a === nextVariantOptions!.axes[i]);
      if (!sameAxes) {
        const childCount = await db
          .select({ c: sql<number>`count(*)::int` })
          .from(itemsTable)
          .where(
            and(
              eq(itemsTable.organizationId, t.organizationId),
              eq(itemsTable.parentItemId, id),
            ),
          );
        if ((childCount[0]?.c ?? 0) > 0) {
          res.status(400).json({
            error:
              "Variant axes are locked once variants exist. Delete all variants first.",
          });
          return;
        }
      }
      updates["variantOptions"] = nextVariantOptions;
    }

    const updated = await db.transaction(async (tx) => {
      const u = await tx
        .update(itemsTable)
        .set(updates)
        .where(
          and(
            eq(itemsTable.id, id),
            eq(itemsTable.organizationId, t.organizationId),
          ),
        )
        .returning();
      // Propagate shared fields (unit, category, hsnCode, taxRate) from
      // a parent to all of its variants, atomically. We deliberately do
      // NOT propagate sku/salePrice/purchasePrice/reorderLevel/imageUrl
      // — those are the per-variant attributes.
      if (u[0] && before.hasVariants) {
        const propagate: Record<string, unknown> = {};
        if ("unit" in updates) propagate["unit"] = updates["unit"];
        if ("category" in updates) propagate["category"] = updates["category"];
        if ("hsnCode" in updates) propagate["hsnCode"] = updates["hsnCode"];
        if ("taxRate" in updates) propagate["taxRate"] = updates["taxRate"];
        if (Object.keys(propagate).length > 0) {
          await tx
            .update(itemsTable)
            .set(propagate)
            .where(
              and(
                eq(itemsTable.organizationId, t.organizationId),
                eq(itemsTable.parentItemId, id),
              ),
            );
        }
      }
      // Bundle component management. Replace-all semantics: if the
      // caller sent `components`, the new list completely replaces the
      // previous one. If the row is no longer a bundle, drop them.
      if (u[0]) {
        if (willBeBundle && nextComponents !== undefined) {
          await tx
            .delete(itemBundleComponentsTable)
            .where(
              and(
                eq(itemBundleComponentsTable.organizationId, t.organizationId),
                eq(itemBundleComponentsTable.parentItemId, id),
              ),
            );
          if (nextComponents.length > 0) {
            await tx.insert(itemBundleComponentsTable).values(
              nextComponents.map((c) => ({
                organizationId: t.organizationId,
                parentItemId: id,
                componentItemId: c.componentItemId,
                quantityPerBundle: toStr(c.quantityPerBundle),
              })),
            );
          }
        } else if (nextIsBundle === false && before.isBundle) {
          await tx
            .delete(itemBundleComponentsTable)
            .where(
              and(
                eq(itemBundleComponentsTable.organizationId, t.organizationId),
                eq(itemBundleComponentsTable.parentItemId, id),
              ),
            );
        }
      }
      return u;
    });
    if (!updated[0]) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const stockMap = await totalStockFor(t.organizationId, [id]);
    res.json(serializeItem(updated[0], stockMap.get(id) ?? 0));
  } catch (err) {
    next(err);
  }
});

/**
 * Regenerate the auto-barcode for a single item, replacing whatever
 * the row currently carries. Always marks the resulting value as
 * `auto`. Used by the per-item "Regenerate" action and the bulk
 * `assign-missing` workflow's per-row retry path.
 */
router.post("/items/:id/barcode/regenerate", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0 || !Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid item id" });
      return;
    }
    const before = await db
      .select({ id: itemsTable.id })
      .from(itemsTable)
      .where(
        and(
          eq(itemsTable.id, id),
          eq(itemsTable.organizationId, t.organizationId),
          sql`${itemsTable.archivedAt} IS NULL`,
        ),
      )
      .limit(1);
    if (!before[0]) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    let updated;
    for (let attempt = 0; attempt < 3; attempt++) {
      const value = await generateUniqueBarcode(t.organizationId);
      try {
        updated = await db
          .update(itemsTable)
          .set({
            barcode: value,
            barcodeSource: "auto",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(itemsTable.id, id),
              eq(itemsTable.organizationId, t.organizationId),
            ),
          )
          .returning();
        break;
      } catch (err) {
        if (isBarcodeUniqueViolation(err) && attempt < 2) continue;
        throw err;
      }
    }
    if (!updated || !updated[0]) {
      res.status(500).json({ error: "Failed to assign a unique barcode" });
      return;
    }
    const stockMap = await totalStockFor(t.organizationId, [id]);
    res.json(serializeItem(updated[0], stockMap.get(id) ?? 0));
  } catch (err) {
    next(err);
  }
});

/**
 * Assign auto-generated barcodes to every active item in this org
 * that doesn't have one yet. Skips archived rows. Returns the count
 * assigned. Idempotent — re-running it after a successful pass is a
 * no-op.
 */
router.post("/items/barcodes/assign-missing", async (req, res, next) => {
  try {
    const t = req.tenant!;
    // Pull the candidate ids upfront so we know exactly how many we
    // touched. We don't UPDATE in a single statement because each
    // generated value is unique and depends on the prior insert/update.
    const candidates = await db
      .select({ id: itemsTable.id })
      .from(itemsTable)
      .where(
        and(
          eq(itemsTable.organizationId, t.organizationId),
          sql`${itemsTable.archivedAt} IS NULL`,
          sql`(${itemsTable.barcode} IS NULL OR ${itemsTable.barcode} = '')`,
        ),
      )
      .orderBy(itemsTable.id);
    let assigned = 0;
    let failed = 0;
    for (const c of candidates) {
      let ok = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const value = await generateUniqueBarcode(t.organizationId);
        try {
          const u = await db
            .update(itemsTable)
            .set({
              barcode: value,
              barcodeSource: "auto",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(itemsTable.id, c.id),
                eq(itemsTable.organizationId, t.organizationId),
                // Only fill in rows still missing a barcode — a
                // concurrent manual edit wins.
                sql`(${itemsTable.barcode} IS NULL OR ${itemsTable.barcode} = '')`,
              ),
            )
            .returning({ id: itemsTable.id });
          if (u.length > 0) {
            assigned++;
          }
          ok = true;
          break;
        } catch (err) {
          if (isBarcodeUniqueViolation(err) && attempt < 2) continue;
          ok = false;
          break;
        }
      }
      if (!ok) failed++;
    }
    res.json({ candidates: candidates.length, assigned, failed });
  } catch (err) {
    next(err);
  }
});

router.delete("/items/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const rows = await db
      .select({
        hasVariants: itemsTable.hasVariants,
        archivedAt: itemsTable.archivedAt,
      })
      .from(itemsTable)
      .where(
        and(
          eq(itemsTable.id, id),
          eq(itemsTable.organizationId, t.organizationId),
        ),
      )
      .limit(1);
    if (!rows[0]) {
      res.status(204).send();
      return;
    }
    // Already archived -- treat as a no-op success so repeated
    // clicks from the UI stay idempotent.
    if (rows[0].archivedAt) {
      res.status(204).send();
      return;
    }
    if (rows[0].hasVariants) {
      // Only count ACTIVE (non-archived) child variants. An archived
      // parent with archived children is fine to soft-delete.
      const childCount = await db
        .select({ c: sql<string>`COUNT(*)` })
        .from(itemsTable)
        .where(
          and(
            eq(itemsTable.organizationId, t.organizationId),
            eq(itemsTable.parentItemId, id),
            sql`${itemsTable.archivedAt} IS NULL`,
          ),
        );
      const n = Number(childCount[0]?.c ?? 0);
      if (n > 0) {
        res.status(400).json({
          error: `This item has ${n} variant(s). Delete the variants first, then delete the parent.`,
        });
        return;
      }
    }
    // Soft delete: stamp archived_at instead of issuing DELETE. The
    // row stays in place so historical sales orders, purchase orders,
    // stock transfers, job-work orders, shipments, and bundles that
    // reference this item continue to resolve correctly. The catalog
    // list, lookup, and pickers all filter on archived_at IS NULL,
    // so the user sees the item disappear from their working surfaces.
    await db
      .update(itemsTable)
      .set({ archivedAt: new Date() })
      .where(
        and(
          eq(itemsTable.id, id),
          eq(itemsTable.organizationId, t.organizationId),
        ),
      );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/**
 * Bulk-create variants under a parent item. Each variant inherits the
 * parent's unit, category, hsnCode, and taxRate. The variant's
 * `variantOptions` must include exactly the parent's declared axes.
 */
router.post("/items/:id/variants", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const parentId = Number(req.params.id);
    const b = req.body ?? {};
    if (!Array.isArray(b.variants) || b.variants.length === 0) {
      res.status(400).json({ error: "variants array is required" });
      return;
    }
    const parentRows = await db
      .select()
      .from(itemsTable)
      .where(
        and(
          eq(itemsTable.id, parentId),
          eq(itemsTable.organizationId, t.organizationId),
        ),
      )
      .limit(1);
    const parent = parentRows[0];
    if (!parent) {
      res.status(404).json({ error: "Parent item not found" });
      return;
    }
    if (!parent.hasVariants) {
      res.status(400).json({
        error: "Item is not a parent. Mark it as having variants first.",
      });
      return;
    }
    const axesParsed = parseAxes(parent.variantOptions);
    if (!Array.isArray(axesParsed)) {
      res.status(400).json({
        error: "Parent has invalid variantOptions; set its axes first.",
      });
      return;
    }
    const axes = axesParsed;
    const axesKey = axes.slice().sort().join("|");

    type ParsedVariant = {
      sku: string;
      name: string;
      options: Record<string, string>;
      salePrice: string;
      purchasePrice: string;
      imageUrl: string | null;
      openingStock: number;
      openingWarehouseId: number | null;
    };
    const parsed: ParsedVariant[] = [];
    const seenCombos = new Set<string>();
    const seenSkus = new Set<string>();
    for (const v of b.variants) {
      if (!v || typeof v !== "object") {
        res.status(400).json({ error: "Each variant must be an object" });
        return;
      }
      const sku = typeof v.sku === "string" ? v.sku.trim() : "";
      if (!sku) {
        res.status(400).json({ error: "Each variant must have a sku" });
        return;
      }
      if (seenSkus.has(sku)) {
        res.status(400).json({ error: `Duplicate sku in payload: ${sku}` });
        return;
      }
      seenSkus.add(sku);
      const opts = v.options;
      if (!opts || typeof opts !== "object") {
        res
          .status(400)
          .json({ error: "Each variant must have an options object" });
        return;
      }
      const optKeys = Object.keys(opts).sort().join("|");
      if (optKeys !== axesKey) {
        res.status(400).json({
          error: `Variant options must include exactly the parent axes: ${axes.join(", ")}`,
        });
        return;
      }
      const cleaned: Record<string, string> = {};
      for (const a of axes) {
        const val = (opts as Record<string, unknown>)[a];
        if (typeof val !== "string" || val.trim().length === 0) {
          res.status(400).json({
            error: `Variant axis "${a}" must be a non-empty string`,
          });
          return;
        }
        cleaned[a] = val.trim();
      }
      const comboKey = axes.map((a) => cleaned[a]).join("\u0000");
      if (seenCombos.has(comboKey)) {
        res.status(400).json({
          error: `Duplicate variant combination: ${axes
            .map((a) => `${a}=${cleaned[a]}`)
            .join(", ")}`,
        });
        return;
      }
      seenCombos.add(comboKey);

      const variantNameSuffix = axes.map((a) => cleaned[a]).join(" / ");
      parsed.push({
        sku,
        name: typeof v.name === "string" && v.name.trim()
          ? v.name.trim()
          : `${parent.name} — ${variantNameSuffix}`,
        options: cleaned,
        salePrice: toStr(v.salePrice ?? parent.salePrice),
        purchasePrice: toStr(v.purchasePrice ?? parent.purchasePrice),
        imageUrl:
          typeof v.imageUrl === "string" && v.imageUrl.trim()
            ? v.imageUrl.trim()
            : null,
        openingStock:
          v.openingStock != null ? toNum(v.openingStock) : 0,
        openingWarehouseId:
          v.openingWarehouseId != null ? Number(v.openingWarehouseId) : null,
      });
    }

    // Validate that no variant SKU collides with an existing one for the
    // org (handled at the unique index too, but a clean 400 is friendlier).
    const allSkus = parsed.map((p) => p.sku);
    const collisions = await db
      .select({ sku: itemsTable.sku })
      .from(itemsTable)
      .where(
        and(
          eq(itemsTable.organizationId, t.organizationId),
          inArray(itemsTable.sku, allSkus),
          // Mirror the partial unique index — archived siblings
          // don't count as a collision.
          sql`${itemsTable.archivedAt} IS NULL`,
        ),
      );
    if (collisions.length > 0) {
      res.status(400).json({
        error: `SKU already in use: ${collisions.map((c) => c.sku).join(", ")}`,
      });
      return;
    }

    // Reject combos that already exist under this parent.
    const existingChildren = await db
      .select({ variantOptions: itemsTable.variantOptions })
      .from(itemsTable)
      .where(
        and(
          eq(itemsTable.organizationId, t.organizationId),
          eq(itemsTable.parentItemId, parent.id),
        ),
      );
    const existingComboKeys = new Set<string>();
    for (const ec of existingChildren) {
      const opts = ec.variantOptions as Record<string, unknown> | null;
      if (!opts) continue;
      const k = axes
        .map((a) => (typeof opts[a] === "string" ? (opts[a] as string) : ""))
        .join("\u0000");
      existingComboKeys.add(k);
    }
    for (const p of parsed) {
      const k = axes.map((a) => p.options[a]).join("\u0000");
      if (existingComboKeys.has(k)) {
        res.status(400).json({
          error: `Variant combination already exists: ${axes
            .map((a) => `${a}=${p.options[a]}`)
            .join(", ")}`,
        });
        return;
      }
    }

    // Validate any opening warehouse ids belong to the org.
    const whIds = parsed
      .map((p) => p.openingWarehouseId)
      .filter((n): n is number => Number.isFinite(n) && (n ?? 0) > 0);
    if (whIds.length > 0) {
      const own = await assertOwnership({
        organizationId: t.organizationId,
        warehouseIds: Array.from(new Set(whIds)),
      });
      if (!own.ok) {
        res.status(400).json({ error: `Invalid ${own.missing}` });
        return;
      }
    }
    const defaultWh = await getDefaultWarehouseId(t.organizationId);

    // Variant children are real, stockable items, so they participate
    // in barcode auto-generation just like leaf items created via
    // POST /items. Generated inside the txn (passing `tx` as executor)
    // so each fresh value sees the prior insert.
    const insertedItems = await db.transaction(async (tx) => {
      const variantBarcodes: string[] = [];
      for (let i = 0; i < parsed.length; i++) {
        variantBarcodes.push(
          await generateUniqueBarcode(t.organizationId, tx),
        );
      }
      const created = await tx
        .insert(itemsTable)
        .values(
          parsed.map((p, i) => ({
            organizationId: t.organizationId,
            sku: p.sku,
            name: p.name,
            description: parent.description,
            category: parent.category,
            unit: parent.unit,
            barcode: variantBarcodes[i],
            barcodeSource: "auto" as const,
            salePrice: p.salePrice,
            purchasePrice: p.purchasePrice,
            hsnCode: parent.hsnCode,
            taxRate: parent.taxRate,
            reorderLevel: parent.reorderLevel,
            imageUrl: p.imageUrl,
            parentItemId: parent.id,
            hasVariants: false,
            variantOptions: p.options,
          })),
        )
        .returning();
      for (let i = 0; i < created.length; i++) {
        const c = created[i]!;
        const p = parsed[i]!;
        if (p.openingStock > 0) {
          const wh = p.openingWarehouseId ?? defaultWh;
          await tx.insert(itemWarehouseStockTable).values({
            organizationId: t.organizationId,
            itemId: c.id,
            warehouseId: wh,
            quantity: toStr(p.openingStock),
          });
          await tx.insert(stockMovementsTable).values({
            organizationId: t.organizationId,
            itemId: c.id,
            warehouseId: wh,
            movementType: "opening",
            quantity: toStr(p.openingStock),
            notes: "Opening stock (variant)",
          });
        }
      }
      return created;
    });

    const stockMap = await totalStockFor(
      t.organizationId,
      insertedItems.map((c) => c.id),
    );
    res
      .status(201)
      .json(
        insertedItems.map((c) =>
          serializeItem(c, stockMap.get(c.id) ?? 0),
        ),
      );
  } catch (err) {
    next(err);
  }
});

router.delete(
  "/items/:parentId/variants/:variantId",
  async (req, res, next) => {
    try {
      const t = req.tenant!;
      const parentId = Number(req.params.parentId);
      const variantId = Number(req.params.variantId);
      const rows = await db
        .select({ archivedAt: itemsTable.archivedAt })
        .from(itemsTable)
        .where(
          and(
            eq(itemsTable.id, variantId),
            eq(itemsTable.organizationId, t.organizationId),
            eq(itemsTable.parentItemId, parentId),
          ),
        )
        .limit(1);
      if (!rows[0]) {
        res.status(404).json({ error: "Variant not found" });
        return;
      }
      // Idempotent: already archived → 204.
      if (rows[0].archivedAt) {
        res.status(204).send();
        return;
      }
      // Soft delete the variant for the same reason as the parent
      // delete: variants may be referenced by historical orders.
      await db
        .update(itemsTable)
        .set({ archivedAt: new Date() })
        .where(
          and(
            eq(itemsTable.id, variantId),
            eq(itemsTable.organizationId, t.organizationId),
          ),
        );
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

router.get("/items/:id/batches", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    let warehouseId: number | undefined;
    if (
      req.query.warehouseId !== undefined &&
      req.query.warehouseId !== ""
    ) {
      const n = Number(req.query.warehouseId);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        res.status(400).json({
          error: "warehouseId must be a positive integer",
        });
        return;
      }
      warehouseId = n;
    }
    const itemRows = await db
      .select()
      .from(itemsTable)
      .where(
        and(
          eq(itemsTable.id, id),
          eq(itemsTable.organizationId, t.organizationId),
        ),
      )
      .limit(1);
    const item = itemRows[0];
    if (!item) {
      res.status(404).json({ error: "Item not found" });
      return;
    }
    if (!item.trackBatches) {
      res.status(400).json({
        error: "This item is not batch-tracked.",
      });
      return;
    }
    const onHand = await getBatchAvailability(
      t.organizationId,
      id,
      warehouseId,
    );

    // For the "Batches" tab on item detail we also want to include
    // batches that exist but currently have zero stock at every
    // warehouse. The availability join hides those, so we union them
    // in if no warehouse filter was set.
    let allBatches: Array<ReturnType<typeof serializeItemBatch>> = [];
    if (warehouseId === undefined) {
      const rows = await db
        .select()
        .from(itemBatchesTable)
        .where(
          and(
            eq(itemBatchesTable.organizationId, t.organizationId),
            eq(itemBatchesTable.itemId, id),
          ),
        );
      allBatches = rows.map((r) => serializeItemBatch(r));
    }
    res.json({ onHand, batches: allBatches });
  } catch (err) {
    next(err);
  }
});

router.post("/items/:id/adjust-stock", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    if (!b.warehouseId || b.quantity === undefined || !b.reason) {
      res.status(400).json({ error: "warehouseId, quantity and reason are required" });
      return;
    }
    const itemRows = await db
      .select()
      .from(itemsTable)
      .where(
        and(eq(itemsTable.id, id), eq(itemsTable.organizationId, t.organizationId)),
      )
      .limit(1);
    const item = itemRows[0];
    if (!item) {
      res.status(404).json({ error: "Item not found" });
      return;
    }
    if (item.hasVariants) {
      res.status(400).json({
        error:
          "Cannot adjust stock on a parent item. Adjust stock on a specific variant instead.",
      });
      return;
    }
    if (item.isBundle) {
      res.status(400).json({
        error:
          "Cannot adjust stock on a bundle. Adjust stock on the bundle's components instead.",
      });
      return;
    }
    if (item.trackBatches) {
      res.status(400).json({
        error:
          "This item is batch-tracked. Stock changes must come from goods receipts, shipments, or transfers so a batch can be captured or selected.",
      });
      return;
    }
    const warehouseRows = await db
      .select()
      .from(warehousesTable)
      .where(
        and(
          eq(warehousesTable.id, b.warehouseId),
          eq(warehousesTable.organizationId, t.organizationId),
        ),
      )
      .limit(1);
    const warehouse = warehouseRows[0];
    if (!warehouse) {
      res.status(404).json({ error: "Warehouse not found" });
      return;
    }

    const qty = toNum(b.quantity);
    const stockRows = await db
      .select()
      .from(itemWarehouseStockTable)
      .where(
        and(
          eq(itemWarehouseStockTable.organizationId, t.organizationId),
          eq(itemWarehouseStockTable.itemId, id),
          eq(itemWarehouseStockTable.warehouseId, b.warehouseId),
        ),
      )
      .limit(1);
    if (stockRows[0]) {
      await db
        .update(itemWarehouseStockTable)
        .set({ quantity: toStr(toNum(stockRows[0].quantity) + qty) })
        .where(
          and(
            eq(itemWarehouseStockTable.organizationId, t.organizationId),
            eq(itemWarehouseStockTable.id, stockRows[0].id),
          ),
        );
    } else {
      await db.insert(itemWarehouseStockTable).values({
        organizationId: t.organizationId,
        itemId: id,
        warehouseId: b.warehouseId,
        quantity: toStr(qty),
      });
    }

    const movement = await db
      .insert(stockMovementsTable)
      .values({
        organizationId: t.organizationId,
        itemId: id,
        warehouseId: b.warehouseId,
        movementType: b.reason,
        quantity: toStr(qty),
        notes: b.notes ?? null,
      })
      .returning();

    pushStockToShopify(t.organizationId, id);

    res.status(201).json(
      serializeStockMovement(movement[0]!, item.name, warehouse.name),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
