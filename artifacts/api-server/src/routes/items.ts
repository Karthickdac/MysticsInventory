import { Router, type IRouter } from "express";
import { and, eq, ilike, or, sql, asc, inArray } from "drizzle-orm";
import {
  db,
  itemsTable,
  itemWarehouseStockTable,
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
  serializeStockMovement,
} from "../lib/serializers";
import { toNum, toStr } from "../lib/numeric";
import { pushStockToShopify } from "../lib/shopifyOutbound";

const router: IRouter = Router();
router.use(tenantMiddleware);

async function totalStockFor(itemIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (itemIds.length === 0) return map;
  const rows = await db
    .select({
      itemId: itemWarehouseStockTable.itemId,
      qty: sql<string>`COALESCE(SUM(${itemWarehouseStockTable.quantity}), 0)`,
    })
    .from(itemWarehouseStockTable)
    .where(inArray(itemWarehouseStockTable.itemId, itemIds))
    .groupBy(itemWarehouseStockTable.itemId);
  for (const r of rows) map.set(r.itemId, toNum(r.qty));
  return map;
}

async function variantCountsFor(
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
    .where(inArray(itemsTable.parentItemId, parentIds))
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
    const conds = [eq(itemsTable.organizationId, t.organizationId)];
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
    const stockMap = await totalStockFor(itemIds);
    const parentIds = rows
      .filter((r) => r.hasVariants)
      .map((r) => r.id);
    const vcountMap = await variantCountsFor(parentIds);

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
    }

    let result = rows.map((r) =>
      serializeItem(
        r,
        stockMap.get(r.id) ?? 0,
        warehouseId ? (warehouseStockMap.get(r.id) ?? 0) : undefined,
        vcountMap.get(r.id) ?? 0,
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
    let parentVariantOptions: { axes: string[] } | null = null;
    if (hasVariants) {
      const parsed = parseAxes(b.variantOptions);
      if (!Array.isArray(parsed)) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      parentVariantOptions = { axes: parsed };
    }
    // Resolve opening stock + warehouse BEFORE the insert so a failed
    // ownership check doesn't leave an orphan item row behind.
    let openingStock = 0;
    let openingWarehouseId: number | null = null;
    if (!hasVariants) {
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

    // Wrap item + opening-stock + opening-movement in one transaction so
    // a failure in any step rolls back the item creation.
    const item = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(itemsTable)
        .values({
          organizationId: t.organizationId,
          sku: b.sku,
          name: b.name,
          description: b.description ?? null,
          category: b.category ?? null,
          unit: b.unit,
          salePrice: toStr(b.salePrice ?? 0),
          purchasePrice: toStr(b.purchasePrice ?? 0),
          hsnCode: b.hsnCode ?? null,
          taxRate: toStr(b.taxRate ?? 0),
          reorderLevel: toStr(b.reorderLevel ?? 0),
          imageUrl: b.imageUrl ?? null,
          hasVariants,
          variantOptions: parentVariantOptions,
        })
        .returning();
      const created = inserted[0]!;
      if (!hasVariants && openingStock > 0 && openingWarehouseId) {
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
      return created;
    });
    if (!hasVariants && openingStock > 0) {
      pushStockToShopify(t.organizationId, item.id);
    }

    res.status(201).json(serializeItem(item, openingStock));
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
      .where(eq(itemWarehouseStockTable.itemId, id));

    const total = stockRows.reduce((s, r) => s + toNum(r.quantity), 0);

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
          ),
        )
        .orderBy(asc(itemsTable.name));
      const childIds = childRows.map((r) => r.id);
      const stockTotals = await totalStockFor(childIds);
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
          .where(inArray(itemWarehouseStockTable.itemId, childIds));
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

    res.json({
      item: serializeItem(item, total, undefined, variantCount),
      stockByWarehouse: stockRows.map((r) => ({
        warehouseId: r.warehouseId,
        warehouseName: r.warehouseName,
        quantity: toNum(r.quantity),
      })),
      variants,
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

    if (nextVariantOptions !== undefined) {
      if (!before.hasVariants) {
        res.status(400).json({
          error: "variantOptions can only be set on items with hasVariants=true",
        });
        return;
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
      return u;
    });
    if (!updated[0]) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const stockMap = await totalStockFor([id]);
    res.json(serializeItem(updated[0], stockMap.get(id) ?? 0));
  } catch (err) {
    next(err);
  }
});

router.delete("/items/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const rows = await db
      .select({ hasVariants: itemsTable.hasVariants })
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
    if (rows[0].hasVariants) {
      const childCount = await db
        .select({ c: sql<string>`COUNT(*)` })
        .from(itemsTable)
        .where(
          and(
            eq(itemsTable.organizationId, t.organizationId),
            eq(itemsTable.parentItemId, id),
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
    await db
      .delete(itemsTable)
      .where(
        and(eq(itemsTable.id, id), eq(itemsTable.organizationId, t.organizationId)),
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
        ),
      );
    if (collisions.length > 0) {
      res.status(400).json({
        error: `SKU already in use: ${collisions.map((c) => c.sku).join(", ")}`,
      });
      return;
    }

    // Reject combos that already exist under this parent. Without this
    // check, two consecutive POSTs with the same Size/Color combo would
    // each succeed (different SKUs) and produce duplicate rows.
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

    const insertedItems = await db.transaction(async (tx) => {
      const created = await tx
        .insert(itemsTable)
        .values(
          parsed.map((p) => ({
            organizationId: t.organizationId,
            sku: p.sku,
            name: p.name,
            description: parent.description,
            category: parent.category,
            unit: parent.unit,
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

    const stockMap = await totalStockFor(insertedItems.map((c) => c.id));
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
        .select()
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
      await db.delete(itemsTable).where(eq(itemsTable.id, variantId));
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

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
        .where(eq(itemWarehouseStockTable.id, stockRows[0].id));
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
