import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  itemBatchesTable,
  itemBatchWarehouseStockTable,
  itemsTable,
  stockBatchMovementsTable,
} from "@workspace/db";
import { toNum, toStr } from "./numeric";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type BatchTrackedItemRef = {
  id: number;
  name: string;
  sku: string;
};

/**
 * Returns the subset of `itemIds` that are flagged as batch-tracked.
 * Used to decide whether stock-in/stock-out endpoints must capture
 * per-batch detail.
 */
export async function findBatchTrackedItems(
  organizationId: number,
  itemIds: number[],
): Promise<BatchTrackedItemRef[]> {
  if (itemIds.length === 0) return [];
  const rows = await db
    .select({
      id: itemsTable.id,
      name: itemsTable.name,
      sku: itemsTable.sku,
    })
    .from(itemsTable)
    .where(
      and(
        eq(itemsTable.organizationId, organizationId),
        inArray(itemsTable.id, itemIds),
        eq(itemsTable.trackBatches, true),
      ),
    );
  return rows;
}

/**
 * Per-batch on-hand for an item. If `warehouseId` is provided, results
 * are scoped to that warehouse; otherwise rows for every warehouse are
 * returned. Sorted FEFO (earliest expiry first; nulls last; tiebreak
 * by mfgDate then createdAt).
 */
export async function getBatchAvailability(
  organizationId: number,
  itemId: number,
  warehouseId?: number,
): Promise<
  Array<{
    itemBatchId: number;
    batchNumber: string;
    mfgDate: string | null;
    expiryDate: string | null;
    costPrice: number | null;
    warehouseId: number;
    quantity: number;
  }>
> {
  const conds = [
    eq(itemBatchesTable.organizationId, organizationId),
    eq(itemBatchesTable.itemId, itemId),
  ];
  if (warehouseId !== undefined) {
    conds.push(eq(itemBatchWarehouseStockTable.warehouseId, warehouseId));
  }
  const rows = await db
    .select({
      itemBatchId: itemBatchesTable.id,
      batchNumber: itemBatchesTable.batchNumber,
      mfgDate: itemBatchesTable.mfgDate,
      expiryDate: itemBatchesTable.expiryDate,
      costPrice: itemBatchesTable.costPrice,
      createdAt: itemBatchesTable.createdAt,
      warehouseId: itemBatchWarehouseStockTable.warehouseId,
      quantity: itemBatchWarehouseStockTable.quantity,
    })
    .from(itemBatchesTable)
    .innerJoin(
      itemBatchWarehouseStockTable,
      eq(itemBatchWarehouseStockTable.itemBatchId, itemBatchesTable.id),
    )
    .where(and(...conds))
    .orderBy(
      // Nulls-last expiry asc, then mfg asc nulls-last, then createdAt asc.
      sql`${itemBatchesTable.expiryDate} ASC NULLS LAST`,
      sql`${itemBatchesTable.mfgDate} ASC NULLS LAST`,
      asc(itemBatchesTable.createdAt),
    );
  return rows.map((r) => ({
    itemBatchId: r.itemBatchId,
    batchNumber: r.batchNumber,
    mfgDate: r.mfgDate,
    expiryDate: r.expiryDate,
    costPrice: r.costPrice == null ? null : toNum(r.costPrice),
    warehouseId: r.warehouseId,
    quantity: toNum(r.quantity),
  }));
}

/**
 * Validate a YYYY-MM-DD date string AND that it parses to a real
 * calendar date.
 */
export function isValidIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

/**
 * Parsed and validated batch input for a stock-in event (goods
 * receipt or transfer-complete via a fresh batch — though we mirror
 * existing batches at transfer-complete, this struct is used for
 * receipt capture).
 */
export type ParsedBatchIn = {
  batchNumber: string;
  mfgDate: string | null;
  expiryDate: string | null;
  costPrice: number | null;
  quantity: number;
};

/**
 * Validate the `batches` array on a stock-in line. Returns the parsed
 * rows or an error message. Does NOT touch the DB.
 *
 *  - batchNumber required, non-empty after trim, max 64 chars.
 *  - mfgDate / expiryDate optional but if set must be valid ISO date.
 *  - if both set, mfgDate <= expiryDate.
 *  - quantity > 0.
 *  - sum of quantities must match the parent line quantity (within 1e-6).
 *  - duplicate batchNumbers within the same line are rejected.
 */
export function parseBatchInArray(
  batches: unknown,
  lineQty: number,
):
  | { ok: true; rows: ParsedBatchIn[] }
  | { ok: false; error: string } {
  if (!Array.isArray(batches) || batches.length === 0) {
    return { ok: false, error: "At least one batch is required" };
  }
  const rows: ParsedBatchIn[] = [];
  const seen = new Set<string>();
  let sum = 0;
  for (const b of batches) {
    if (!b || typeof b !== "object") {
      return { ok: false, error: "Each batch must be an object" };
    }
    const rec = b as Record<string, unknown>;
    const rawNum =
      typeof rec.batchNumber === "string" ? rec.batchNumber.trim() : "";
    if (!rawNum) {
      return { ok: false, error: "Each batch must have a batchNumber" };
    }
    if (rawNum.length > 64) {
      return {
        ok: false,
        error: "batchNumber must be 64 characters or fewer",
      };
    }
    if (seen.has(rawNum)) {
      return {
        ok: false,
        error: `Duplicate batchNumber on the same line: ${rawNum}`,
      };
    }
    seen.add(rawNum);
    let mfgDate: string | null = null;
    let expiryDate: string | null = null;
    if (rec.mfgDate !== undefined && rec.mfgDate !== null && rec.mfgDate !== "") {
      if (!isValidIsoDate(rec.mfgDate)) {
        return {
          ok: false,
          error: "mfgDate must be a valid YYYY-MM-DD date",
        };
      }
      mfgDate = rec.mfgDate;
    }
    if (
      rec.expiryDate !== undefined &&
      rec.expiryDate !== null &&
      rec.expiryDate !== ""
    ) {
      if (!isValidIsoDate(rec.expiryDate)) {
        return {
          ok: false,
          error: "expiryDate must be a valid YYYY-MM-DD date",
        };
      }
      expiryDate = rec.expiryDate;
    }
    if (mfgDate && expiryDate && mfgDate > expiryDate) {
      return {
        ok: false,
        error: `mfgDate (${mfgDate}) must be on or before expiryDate (${expiryDate}) for batch ${rawNum}`,
      };
    }
    let costPrice: number | null = null;
    if (rec.costPrice !== undefined && rec.costPrice !== null && rec.costPrice !== "") {
      const c = Number(rec.costPrice);
      if (!Number.isFinite(c) || c < 0) {
        return {
          ok: false,
          error: `costPrice must be a non-negative number for batch ${rawNum}`,
        };
      }
      costPrice = c;
    }
    const qty = Number(rec.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return {
        ok: false,
        error: `Each batch quantity must be greater than zero (batch ${rawNum})`,
      };
    }
    sum += qty;
    rows.push({
      batchNumber: rawNum,
      mfgDate,
      expiryDate,
      costPrice,
      quantity: qty,
    });
  }
  if (Math.abs(sum - lineQty) > 1e-6) {
    return {
      ok: false,
      error: `Sum of batch quantities (${sum}) must equal the line quantity (${lineQty})`,
    };
  }
  return { ok: true, rows };
}

export type ParsedBatchPick = {
  itemBatchId: number;
  quantity: number;
};

/**
 * Validate the `batches` array on a stock-out line (shipment, transfer
 * dispatch). Each entry must reference an existing itemBatchId and a
 * positive quantity; quantities sum to the line qty.
 *
 * NOTE: This only validates structure. The caller must verify that
 * each itemBatchId belongs to the line's item AND the source warehouse
 * has enough on-hand for that batch (under FOR UPDATE locks).
 */
export function parseBatchPicks(
  batches: unknown,
  lineQty: number,
):
  | { ok: true; rows: ParsedBatchPick[] }
  | { ok: false; error: string } {
  if (!Array.isArray(batches) || batches.length === 0) {
    return { ok: false, error: "At least one batch pick is required" };
  }
  const rows: ParsedBatchPick[] = [];
  const seen = new Set<number>();
  let sum = 0;
  for (const b of batches) {
    if (!b || typeof b !== "object") {
      return { ok: false, error: "Each batch pick must be an object" };
    }
    const rec = b as Record<string, unknown>;
    const id = Number(rec.itemBatchId);
    if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
      return { ok: false, error: "itemBatchId must be a positive integer" };
    }
    if (seen.has(id)) {
      return {
        ok: false,
        error: `Duplicate itemBatchId on the same line: ${id}`,
      };
    }
    seen.add(id);
    const qty = Number(rec.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return {
        ok: false,
        error: `Each batch pick quantity must be greater than zero (batch ${id})`,
      };
    }
    sum += qty;
    rows.push({ itemBatchId: id, quantity: qty });
  }
  if (Math.abs(sum - lineQty) > 1e-6) {
    return {
      ok: false,
      error: `Sum of batch pick quantities (${sum}) must equal the line quantity (${lineQty})`,
    };
  }
  return { ok: true, rows };
}

/**
 * Look up batches by ids in this org and this item. Returns a map by
 * id for easy lookup. Throws no error on missing — caller checks the
 * map size.
 */
export async function loadBatchesForItem(
  organizationId: number,
  itemId: number,
  ids: number[],
): Promise<Map<number, { id: number; itemId: number; batchNumber: string }>> {
  const out = new Map<
    number,
    { id: number; itemId: number; batchNumber: string }
  >();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: itemBatchesTable.id,
      itemId: itemBatchesTable.itemId,
      batchNumber: itemBatchesTable.batchNumber,
    })
    .from(itemBatchesTable)
    .where(
      and(
        eq(itemBatchesTable.organizationId, organizationId),
        eq(itemBatchesTable.itemId, itemId),
        inArray(itemBatchesTable.id, ids),
      ),
    );
  for (const r of rows) out.set(r.id, r);
  return out;
}

/**
 * Upsert an item_batches row by (itemId, batchNumber). If the row
 * exists, optional metadata (mfgDate, expiryDate, costPrice) on the
 * incoming payload must match (where set) — diverging dates raise an
 * error. Returns the existing or newly created batch id.
 */
export async function upsertBatchInTx(
  tx: Tx,
  organizationId: number,
  itemId: number,
  input: ParsedBatchIn,
): Promise<{ ok: true; itemBatchId: number } | { ok: false; error: string }> {
  // Race-safe insert: ON CONFLICT DO NOTHING on the unique (itemId,
  // batchNumber) index. Returns the new id for the winner; concurrent
  // losers get an empty array and fall through to the FOR UPDATE
  // fetch + metadata reconciliation below.
  const inserted = await tx
    .insert(itemBatchesTable)
    .values({
      organizationId,
      itemId,
      batchNumber: input.batchNumber,
      mfgDate: input.mfgDate,
      expiryDate: input.expiryDate,
      costPrice: input.costPrice == null ? null : toStr(input.costPrice),
    })
    .onConflictDoNothing({
      target: [itemBatchesTable.itemId, itemBatchesTable.batchNumber],
    })
    .returning({ id: itemBatchesTable.id });
  if (inserted[0]) {
    return { ok: true, itemBatchId: inserted[0].id };
  }

  // Existed (or lost the race). Lock the row for our metadata check.
  const existing = await tx
    .select()
    .from(itemBatchesTable)
    .where(
      and(
        eq(itemBatchesTable.organizationId, organizationId),
        eq(itemBatchesTable.itemId, itemId),
        eq(itemBatchesTable.batchNumber, input.batchNumber),
      ),
    )
    .for("update")
    .limit(1);
  const e = existing[0];
  if (!e) {
    return {
      ok: false,
      error: `Failed to upsert batch ${input.batchNumber}; please retry.`,
    };
  }
  if (input.mfgDate && e.mfgDate && input.mfgDate !== e.mfgDate) {
    return {
      ok: false,
      error: `Batch ${input.batchNumber} already exists with mfgDate ${e.mfgDate}; cannot change to ${input.mfgDate}`,
    };
  }
  if (
    input.expiryDate &&
    e.expiryDate &&
    input.expiryDate !== e.expiryDate
  ) {
    return {
      ok: false,
      error: `Batch ${input.batchNumber} already exists with expiryDate ${e.expiryDate}; cannot change to ${input.expiryDate}`,
    };
  }
  // Backfill missing metadata if the existing row had nulls.
  const patch: Record<string, unknown> = {};
  if (!e.mfgDate && input.mfgDate) patch.mfgDate = input.mfgDate;
  if (!e.expiryDate && input.expiryDate) patch.expiryDate = input.expiryDate;
  if (e.costPrice == null && input.costPrice != null) {
    patch.costPrice = toStr(input.costPrice);
  }
  if (Object.keys(patch).length > 0) {
    await tx
      .update(itemBatchesTable)
      .set(patch)
      .where(
        and(
          eq(itemBatchesTable.organizationId, organizationId),
          eq(itemBatchesTable.id, e.id),
        ),
      );
  }
  return { ok: true, itemBatchId: e.id };
}

/**
 * Atomically apply a delta to (itemBatchId, warehouseId) on-hand. Uses
 * the same UPDATE-then-INSERT pattern as item_warehouse_stock so
 * concurrent updates serialize through the row lock. The caller is
 * expected to have validated that decrements don't drive on-hand
 * negative.
 */
export async function applyBatchStockChange(
  tx: Tx,
  orgId: number,
  itemBatchId: number,
  warehouseId: number,
  delta: number,
): Promise<void> {
  // Race-safe upsert: INSERT ... ON CONFLICT DO UPDATE on the unique
  // (itemBatchId, warehouseId) index. The SET clause adds `delta` to
  // whichever quantity Postgres serializes against, so concurrent
  // first-writes never collide on the unique constraint.
  await tx
    .insert(itemBatchWarehouseStockTable)
    .values({
      organizationId: orgId,
      itemBatchId,
      warehouseId,
      quantity: toStr(delta),
    })
    .onConflictDoUpdate({
      target: [
        itemBatchWarehouseStockTable.itemBatchId,
        itemBatchWarehouseStockTable.warehouseId,
      ],
      set: {
        quantity: sql`${itemBatchWarehouseStockTable.quantity} + ${toStr(
          delta,
        )}::numeric`,
      },
    });
}

/**
 * Insert a stock_batch_movements row tied to a parent stockMovementId.
 */
export async function insertBatchMovement(
  tx: Tx,
  orgId: number,
  stockMovementId: number,
  itemBatchId: number,
  warehouseId: number,
  signedQty: number,
): Promise<void> {
  await tx.insert(stockBatchMovementsTable).values({
    organizationId: orgId,
    stockMovementId,
    itemBatchId,
    warehouseId,
    quantity: toStr(signedQty),
  });
}

/**
 * Look up the batch movements for a parent stockMovementId. Used by
 * cancel/reverse paths that mirror the forward batch ledger.
 */
export async function loadBatchMovementsForParents(
  orgId: number,
  parentMovementIds: number[],
): Promise<
  Array<{
    stockMovementId: number;
    itemBatchId: number;
    warehouseId: number;
    quantity: number;
  }>
> {
  if (parentMovementIds.length === 0) return [];
  const rows = await db
    .select({
      stockMovementId: stockBatchMovementsTable.stockMovementId,
      itemBatchId: stockBatchMovementsTable.itemBatchId,
      warehouseId: stockBatchMovementsTable.warehouseId,
      quantity: stockBatchMovementsTable.quantity,
    })
    .from(stockBatchMovementsTable)
    .where(
      and(
        eq(stockBatchMovementsTable.organizationId, orgId),
        inArray(stockBatchMovementsTable.stockMovementId, parentMovementIds),
      ),
    );
  return rows.map((r) => ({
    stockMovementId: r.stockMovementId,
    itemBatchId: r.itemBatchId,
    warehouseId: r.warehouseId,
    quantity: toNum(r.quantity),
  }));
}
