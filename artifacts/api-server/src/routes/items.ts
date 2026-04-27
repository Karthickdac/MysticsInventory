import { Router, type IRouter } from "express";
import { and, eq, ilike, or, sql, asc } from "drizzle-orm";
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
    .where(
      sql`${itemWarehouseStockTable.itemId} IN (${sql.join(
        itemIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )
    .groupBy(itemWarehouseStockTable.itemId);
  for (const r of rows) map.set(r.itemId, toNum(r.qty));
  return map;
}

router.get("/items", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const lowStock = req.query.lowStock === "true";
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
    const rows = await db
      .select()
      .from(itemsTable)
      .where(and(...conds))
      .orderBy(asc(itemsTable.name));
    const itemIds = rows.map((r) => r.id);
    const stockMap = await totalStockFor(itemIds);

    // Optional per-warehouse stock map (used by the stock-transfer create
    // flow to show on-hand quantity at the source warehouse).
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
            sql`${itemWarehouseStockTable.itemId} IN (${sql.join(
              itemIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
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

router.post("/items", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const b = req.body ?? {};
    if (!b.sku || !b.name || !b.unit) {
      res.status(400).json({ error: "sku, name and unit are required" });
      return;
    }
    const inserted = await db
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
      })
      .returning();
    const item = inserted[0]!;

    let openingStock = toNum(b.openingStock);
    if (openingStock > 0) {
      let warehouseId = Number(b.openingWarehouseId);
      if (warehouseId) {
        const own = await assertOwnership({
          organizationId: t.organizationId,
          warehouseIds: [warehouseId],
        });
        if (!own.ok) {
          res.status(400).json({ error: `Invalid ${own.missing}` });
          return;
        }
      } else {
        warehouseId = await getDefaultWarehouseId(t.organizationId);
      }
      await db.insert(itemWarehouseStockTable).values({
        organizationId: t.organizationId,
        itemId: item.id,
        warehouseId,
        quantity: toStr(openingStock),
      });
      await db.insert(stockMovementsTable).values({
        organizationId: t.organizationId,
        itemId: item.id,
        warehouseId,
        movementType: "opening",
        quantity: toStr(openingStock),
        notes: "Opening stock",
      });
      pushStockToShopify(t.organizationId, item.id);
    } else {
      openingStock = 0;
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

    res.json({
      item: serializeItem(item, total),
      stockByWarehouse: stockRows.map((r) => ({
        warehouseId: r.warehouseId,
        warehouseName: r.warehouseName,
        quantity: toNum(r.quantity),
      })),
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
    const updated = await db
      .update(itemsTable)
      .set(updates)
      .where(
        and(eq(itemsTable.id, id), eq(itemsTable.organizationId, t.organizationId)),
      )
      .returning();
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
