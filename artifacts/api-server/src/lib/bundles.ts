import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  itemBundleComponentsTable,
  itemWarehouseStockTable,
  itemsTable,
  warehousesTable,
} from "@workspace/db";
import { toNum } from "./numeric";

type ComponentTuple = {
  parentItemId: number;
  componentItemId: number;
  quantityPerBundle: string;
};

export type BundleComponentDetail = {
  id: number;
  componentItemId: number;
  componentSku: string;
  componentName: string;
  quantityPerBundle: number;
};

/**
 * Load the components rows for a single bundle item, joined with the
 * component item's name/sku for display.
 */
export async function loadBundleComponents(
  organizationId: number,
  parentItemId: number,
): Promise<BundleComponentDetail[]> {
  const rows = await db
    .select({
      id: itemBundleComponentsTable.id,
      componentItemId: itemBundleComponentsTable.componentItemId,
      componentSku: itemsTable.sku,
      componentName: itemsTable.name,
      quantityPerBundle: itemBundleComponentsTable.quantityPerBundle,
    })
    .from(itemBundleComponentsTable)
    .innerJoin(
      itemsTable,
      eq(itemsTable.id, itemBundleComponentsTable.componentItemId),
    )
    .where(
      and(
        eq(itemBundleComponentsTable.organizationId, organizationId),
        eq(itemBundleComponentsTable.parentItemId, parentItemId),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    componentItemId: r.componentItemId,
    componentSku: r.componentSku,
    componentName: r.componentName,
    quantityPerBundle: toNum(r.quantityPerBundle),
  }));
}

/**
 * For each warehouse, derived bundle stock is
 *   floor( min( componentStock(component, wh) / qtyPerBundle ) )
 * across all components. A bundle with zero components has zero stock.
 */
export async function computeBundleStockByWarehouse(
  organizationId: number,
  parentItemId: number,
): Promise<Array<{ warehouseId: number; warehouseName: string; quantity: number }>> {
  const components = await loadBundleComponents(organizationId, parentItemId);
  const warehouses = await db
    .select({ id: warehousesTable.id, name: warehousesTable.name })
    .from(warehousesTable)
    .where(eq(warehousesTable.organizationId, organizationId));

  if (components.length === 0) {
    return warehouses.map((w) => ({
      warehouseId: w.id,
      warehouseName: w.name,
      quantity: 0,
    }));
  }

  const componentIds = components.map((c) => c.componentItemId);
  const stockRows = await db
    .select({
      itemId: itemWarehouseStockTable.itemId,
      warehouseId: itemWarehouseStockTable.warehouseId,
      quantity: itemWarehouseStockTable.quantity,
    })
    .from(itemWarehouseStockTable)
    .where(
      and(
        eq(itemWarehouseStockTable.organizationId, organizationId),
        inArray(itemWarehouseStockTable.itemId, componentIds),
      ),
    );
  // (itemId, warehouseId) -> quantity
  const stockMap = new Map<string, number>();
  for (const r of stockRows) {
    stockMap.set(`${r.itemId}:${r.warehouseId}`, toNum(r.quantity));
  }

  return warehouses.map((w) => {
    let derived = Number.POSITIVE_INFINITY;
    for (const c of components) {
      const q = stockMap.get(`${c.componentItemId}:${w.id}`) ?? 0;
      if (c.quantityPerBundle <= 0) {
        derived = 0;
        break;
      }
      const ratio = Math.floor(q / c.quantityPerBundle);
      if (ratio < derived) derived = ratio;
    }
    if (!Number.isFinite(derived)) derived = 0;
    return {
      warehouseId: w.id,
      warehouseName: w.name,
      quantity: Math.max(0, derived),
    };
  });
}

/**
 * Total derived stock across all warehouses for a single bundle.
 */
export async function computeBundleTotalStock(
  organizationId: number,
  parentItemId: number,
): Promise<number> {
  const perWh = await computeBundleStockByWarehouse(
    organizationId,
    parentItemId,
  );
  return perWh.reduce((s, w) => s + w.quantity, 0);
}

/**
 * Batched: total derived stock for many bundle items at once.
 * Used by GET /items so the list view doesn't N+1 when many bundles
 * are present.
 */
export async function computeBundleTotalsForMany(
  organizationId: number,
  parentItemIds: number[],
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (parentItemIds.length === 0) return result;

  const compRows = await db
    .select({
      parentItemId: itemBundleComponentsTable.parentItemId,
      componentItemId: itemBundleComponentsTable.componentItemId,
      quantityPerBundle: itemBundleComponentsTable.quantityPerBundle,
    })
    .from(itemBundleComponentsTable)
    .where(
      and(
        eq(itemBundleComponentsTable.organizationId, organizationId),
        inArray(itemBundleComponentsTable.parentItemId, parentItemIds),
      ),
    );
  const byParent = new Map<number, ComponentTuple[]>();
  for (const r of compRows) {
    if (!byParent.has(r.parentItemId)) byParent.set(r.parentItemId, []);
    byParent.get(r.parentItemId)!.push(r);
  }

  const componentIds = Array.from(
    new Set(compRows.map((r) => r.componentItemId)),
  );
  // Per-component, per-warehouse stock for the org so we can compute
  // assemblable bundles per warehouse and then sum (matches the detail
  // endpoint and the "no physical stock, derived" rule).
  // Map key: `${itemId}:${warehouseId}` -> quantity
  const perWhStock = new Map<string, number>();
  const warehouseIds = new Set<number>();
  if (componentIds.length > 0) {
    const stockRows = await db
      .select({
        itemId: itemWarehouseStockTable.itemId,
        warehouseId: itemWarehouseStockTable.warehouseId,
        quantity: itemWarehouseStockTable.quantity,
      })
      .from(itemWarehouseStockTable)
      .where(
        and(
          eq(itemWarehouseStockTable.organizationId, organizationId),
          inArray(itemWarehouseStockTable.itemId, componentIds),
        ),
      );
    for (const r of stockRows) {
      perWhStock.set(`${r.itemId}:${r.warehouseId}`, toNum(r.quantity));
      warehouseIds.add(r.warehouseId);
    }
  }

  for (const parentId of parentItemIds) {
    const comps = byParent.get(parentId) ?? [];
    if (comps.length === 0) {
      result.set(parentId, 0);
      continue;
    }
    let total = 0;
    for (const wid of warehouseIds) {
      let derived = Number.POSITIVE_INFINITY;
      for (const c of comps) {
        const per = toNum(c.quantityPerBundle);
        if (per <= 0) {
          derived = 0;
          break;
        }
        const q = perWhStock.get(`${c.componentItemId}:${wid}`) ?? 0;
        const ratio = Math.floor(q / per);
        if (ratio < derived) derived = ratio;
      }
      if (!Number.isFinite(derived)) derived = 0;
      total += Math.max(0, derived);
    }
    result.set(parentId, total);
  }
  return result;
}
