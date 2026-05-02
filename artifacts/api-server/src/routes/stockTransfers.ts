import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  db,
  stockTransfersTable,
  stockTransferLinesTable,
  warehousesTable,
  itemsTable,
  itemBatchesTable,
  itemBatchWarehouseStockTable,
  itemWarehouseStockTable,
  stockMovementsTable,
} from "@workspace/db";
import {
  tenantMiddleware,
  assertOwnership,
  findParentItems,
  findBundleItems,
} from "../lib/tenant";
import {
  serializeStockTransfer,
  serializeStockTransferLine,
} from "../lib/serializers";
import { nextOrderNumber } from "../lib/orderHelpers";
import { toNum, toStr } from "../lib/numeric";
import { pushStockToShopify } from "../lib/shopifyOutbound";
import {
  applyBatchStockChange,
  insertBatchMovement,
  loadBatchMovementsForParents,
  parseBatchPicks,
  type ParsedBatchPick,
} from "../lib/batches";

const router: IRouter = Router();
router.use(tenantMiddleware);

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const FROM_WH = "from_wh";
const TO_WH = "to_wh";

async function loadDetail(orgId: number, transferId: number) {
  const rows = await db
    .select({
      transfer: stockTransfersTable,
      fromName: sql<string>`${sql.identifier(FROM_WH)}.name`,
      toName: sql<string>`${sql.identifier(TO_WH)}.name`,
    })
    .from(stockTransfersTable)
    .innerJoin(
      sql`${warehousesTable} AS ${sql.identifier(FROM_WH)}`,
      sql`${sql.identifier(FROM_WH)}.id = ${stockTransfersTable.fromWarehouseId}`,
    )
    .innerJoin(
      sql`${warehousesTable} AS ${sql.identifier(TO_WH)}`,
      sql`${sql.identifier(TO_WH)}.id = ${stockTransfersTable.toWarehouseId}`,
    )
    .where(
      and(
        eq(stockTransfersTable.id, transferId),
        eq(stockTransfersTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!rows[0]) return null;
  const lineRows = await db
    .select({
      line: stockTransferLinesTable,
      itemName: itemsTable.name,
      sku: itemsTable.sku,
      variantOptions: itemsTable.variantOptions,
      trackBatches: itemsTable.trackBatches,
    })
    .from(stockTransferLinesTable)
    .innerJoin(itemsTable, eq(itemsTable.id, stockTransferLinesTable.itemId))
    .where(
      and(
        eq(stockTransferLinesTable.organizationId, orgId),
        eq(stockTransferLinesTable.stockTransferId, transferId),
      ),
    );
  return {
    transfer: serializeStockTransfer(
      rows[0].transfer,
      rows[0].fromName,
      rows[0].toName,
    ),
    lines: lineRows.map((r) =>
      serializeStockTransferLine(
        r.line,
        r.itemName,
        r.sku,
        (r.variantOptions as Record<string, string> | null) ?? null,
        !!r.trackBatches,
      ),
    ),
  };
}

// Returns the parsed positive integer if `raw` is a valid positive integer
// query-string value. Returns `null` when the param is absent. Returns the
// string "invalid" when present but malformed so the caller can return 400.
function parsePositiveIntParam(
  raw: unknown,
): number | null | "invalid" {
  if (raw === undefined || raw === "") return null;
  if (typeof raw !== "string") return "invalid";
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return "invalid";
  return n;
}

// Validates a YYYY-MM-DD string AND that it parses to a real calendar date
// (so e.g. 2026-02-30 is rejected).
function isValidIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

router.get("/stock-transfers", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const conds = [eq(stockTransfersTable.organizationId, t.organizationId)];
    if (req.query.status) {
      conds.push(eq(stockTransfersTable.status, String(req.query.status)));
    }
    const intParams = {
      fromWarehouseId: parsePositiveIntParam(req.query.fromWarehouseId),
      toWarehouseId: parsePositiveIntParam(req.query.toWarehouseId),
      warehouseId: parsePositiveIntParam(req.query.warehouseId),
      itemId: parsePositiveIntParam(req.query.itemId),
    };
    for (const [name, val] of Object.entries(intParams)) {
      if (val === "invalid") {
        res
          .status(400)
          .json({ error: `${name} must be a positive integer` });
        return;
      }
    }
    if (intParams.fromWarehouseId !== null) {
      conds.push(
        eq(
          stockTransfersTable.fromWarehouseId,
          intParams.fromWarehouseId as number,
        ),
      );
    }
    if (intParams.toWarehouseId !== null) {
      conds.push(
        eq(
          stockTransfersTable.toWarehouseId,
          intParams.toWarehouseId as number,
        ),
      );
    }
    if (intParams.warehouseId !== null) {
      const wid = intParams.warehouseId as number;
      conds.push(
        or(
          eq(stockTransfersTable.fromWarehouseId, wid),
          eq(stockTransfersTable.toWarehouseId, wid),
        )!,
      );
    }
    if (req.query.fromDate !== undefined && req.query.fromDate !== "") {
      if (!isValidIsoDate(req.query.fromDate)) {
        res
          .status(400)
          .json({ error: "fromDate must be a valid YYYY-MM-DD date" });
        return;
      }
      conds.push(
        sql`${stockTransfersTable.transferDate} >= ${req.query.fromDate}`,
      );
    }
    if (req.query.toDate !== undefined && req.query.toDate !== "") {
      if (!isValidIsoDate(req.query.toDate)) {
        res
          .status(400)
          .json({ error: "toDate must be a valid YYYY-MM-DD date" });
        return;
      }
      conds.push(
        sql`${stockTransfersTable.transferDate} <= ${req.query.toDate}`,
      );
    }
    if (intParams.itemId !== null) {
      const itemId = intParams.itemId as number;
      const lineRows = await db
        .select({ id: stockTransferLinesTable.stockTransferId })
        .from(stockTransferLinesTable)
        .where(
          and(
            eq(stockTransferLinesTable.organizationId, t.organizationId),
            eq(stockTransferLinesTable.itemId, itemId),
          ),
        );
      const ids = Array.from(new Set(lineRows.map((r) => r.id)));
      if (ids.length === 0) {
        res.json([]);
        return;
      }
      conds.push(inArray(stockTransfersTable.id, ids));
    }
    const rows = await db
      .select({
        transfer: stockTransfersTable,
        fromName: sql<string>`${sql.identifier(FROM_WH)}.name`,
        toName: sql<string>`${sql.identifier(TO_WH)}.name`,
      })
      .from(stockTransfersTable)
      .innerJoin(
        sql`${warehousesTable} AS ${sql.identifier(FROM_WH)}`,
        sql`${sql.identifier(FROM_WH)}.id = ${stockTransfersTable.fromWarehouseId}`,
      )
      .innerJoin(
        sql`${warehousesTable} AS ${sql.identifier(TO_WH)}`,
        sql`${sql.identifier(TO_WH)}.id = ${stockTransfersTable.toWarehouseId}`,
      )
      .where(and(...conds))
      .orderBy(desc(stockTransfersTable.createdAt));
    res.json(
      rows.map((r) =>
        serializeStockTransfer(r.transfer, r.fromName, r.toName),
      ),
    );
  } catch (err) {
    next(err);
  }
});

router.post("/stock-transfers", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const b = req.body ?? {};
    const fromWarehouseId = Number(b.fromWarehouseId);
    const toWarehouseId = Number(b.toWarehouseId);
    if (!fromWarehouseId || !toWarehouseId) {
      res.status(400).json({
        error: "fromWarehouseId and toWarehouseId are required",
      });
      return;
    }
    if (fromWarehouseId === toWarehouseId) {
      res.status(400).json({
        error: "Source and destination warehouses must be different",
      });
      return;
    }
    if (
      typeof b.transferDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(b.transferDate)
    ) {
      res
        .status(400)
        .json({ error: "transferDate must be in YYYY-MM-DD format" });
      return;
    }
    const inputLines = Array.isArray(b.lines) ? b.lines : [];
    if (inputLines.length === 0) {
      res
        .status(400)
        .json({ error: "At least one transfer line is required" });
      return;
    }
    type Input = { itemId: number; quantity: number };
    const parsed: Input[] = [];
    for (const l of inputLines) {
      const itemId = Number(l?.itemId);
      const qty = toNum(l?.quantity);
      if (!Number.isFinite(itemId) || itemId <= 0) {
        res.status(400).json({ error: "Each line must include itemId" });
        return;
      }
      if (!(qty > 0)) {
        res
          .status(400)
          .json({ error: "Each line quantity must be greater than zero" });
        return;
      }
      parsed.push({ itemId, quantity: qty });
    }
    const itemIds = parsed.map((p) => p.itemId);
    if (new Set(itemIds).size !== itemIds.length) {
      res.status(400).json({
        error: "Duplicate itemId in transfer lines",
      });
      return;
    }
    const own = await assertOwnership({
      organizationId: t.organizationId,
      warehouseIds: [fromWarehouseId, toWarehouseId],
      itemIds,
    });
    if (!own.ok) {
      res.status(400).json({ error: `Invalid ${own.missing}` });
      return;
    }
    const parents = await findParentItems(t.organizationId, itemIds);
    if (parents.length > 0) {
      res.status(400).json({
        error: `Cannot transfer parent items. Pick a variant instead. Offending: ${parents
          .map((p) => p.sku)
          .join(", ")}`,
      });
      return;
    }
    const bundles = await findBundleItems(t.organizationId, itemIds);
    if (bundles.length > 0) {
      res.status(400).json({
        error: `Cannot transfer bundle items. Transfer their components instead. Offending: ${bundles
          .map((p) => p.sku)
          .join(", ")}`,
      });
      return;
    }
    const notes =
      typeof b.notes === "string" && b.notes.trim()
        ? String(b.notes).trim()
        : null;

    const transferId = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(stockTransfersTable)
        .values({
          organizationId: t.organizationId,
          transferNumber: nextOrderNumber("TRF"),
          fromWarehouseId,
          toWarehouseId,
          transferDate: b.transferDate,
          status: "draft",
          notes,
        })
        .returning({ id: stockTransfersTable.id });
      const newId = inserted[0]!.id;
      await tx.insert(stockTransferLinesTable).values(
        parsed.map((p) => ({
          organizationId: t.organizationId,
          stockTransferId: newId,
          itemId: p.itemId,
          quantity: toStr(p.quantity),
        })),
      );
      return newId;
    });

    const detail = await loadDetail(t.organizationId, transferId);
    res.status(201).json(detail);
  } catch (err) {
    next(err);
  }
});

router.get("/stock-transfers/:id/pdf", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "Invalid transfer id" });
      return;
    }
    const { loadStockTransferPdf } = await import(
      "../lib/stockTransferPdfData"
    );
    const result = await loadStockTransferPdf(t.organizationId, id);
    if ("notFound" in result) {
      res.status(404).json({ error: "Stock transfer not found" });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="transfer-${result.transferNumber}.pdf"`,
    );
    res.setHeader("Cache-Control", "private, max-age=0, no-store");
    res.setHeader("Content-Length", String(result.pdf.length));
    res.send(result.pdf);
  } catch (err) {
    next(err);
  }
});

router.get("/stock-transfers/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const detail = await loadDetail(t.organizationId, Number(req.params.id));
    if (!detail) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

router.patch("/stock-transfers/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const existingRows = await db
      .select()
      .from(stockTransfersTable)
      .where(
        and(
          eq(stockTransfersTable.id, id),
          eq(stockTransfersTable.organizationId, t.organizationId),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (existing.status !== "draft") {
      res.status(400).json({
        error:
          "Only draft transfers can be edited. Cancel and recreate to change a dispatched transfer.",
      });
      return;
    }
    const b = req.body ?? {};
    const fromWarehouseId = b.fromWarehouseId
      ? Number(b.fromWarehouseId)
      : existing.fromWarehouseId;
    const toWarehouseId = b.toWarehouseId
      ? Number(b.toWarehouseId)
      : existing.toWarehouseId;
    if (fromWarehouseId === toWarehouseId) {
      res.status(400).json({
        error: "Source and destination warehouses must be different",
      });
      return;
    }
    if (
      b.transferDate !== undefined &&
      (typeof b.transferDate !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(b.transferDate))
    ) {
      res
        .status(400)
        .json({ error: "transferDate must be in YYYY-MM-DD format" });
      return;
    }

    let parsedLines: Array<{ itemId: number; quantity: number }> | null = null;
    if (Array.isArray(b.lines)) {
      const inputLines = b.lines;
      if (inputLines.length === 0) {
        res
          .status(400)
          .json({ error: "At least one transfer line is required" });
        return;
      }
      parsedLines = [];
      for (const l of inputLines) {
        const itemId = Number(l?.itemId);
        const qty = toNum(l?.quantity);
        if (!Number.isFinite(itemId) || itemId <= 0) {
          res.status(400).json({ error: "Each line must include itemId" });
          return;
        }
        if (!(qty > 0)) {
          res
            .status(400)
            .json({ error: "Each line quantity must be greater than zero" });
          return;
        }
        parsedLines.push({ itemId, quantity: qty });
      }
      const ids = parsedLines.map((p) => p.itemId);
      if (new Set(ids).size !== ids.length) {
        res.status(400).json({ error: "Duplicate itemId in transfer lines" });
        return;
      }
    }

    const own = await assertOwnership({
      organizationId: t.organizationId,
      warehouseIds:
        fromWarehouseId !== existing.fromWarehouseId ||
        toWarehouseId !== existing.toWarehouseId
          ? [fromWarehouseId, toWarehouseId]
          : undefined,
      itemIds: parsedLines ? parsedLines.map((l) => l.itemId) : undefined,
    });
    if (!own.ok) {
      res.status(400).json({ error: `Invalid ${own.missing}` });
      return;
    }
    if (parsedLines) {
      const tIds = parsedLines.map((l) => l.itemId);
      const parents = await findParentItems(t.organizationId, tIds);
      if (parents.length > 0) {
        res.status(400).json({
          error: `Cannot transfer parent items. Pick a variant instead. Offending: ${parents
            .map((p) => p.sku)
            .join(", ")}`,
        });
        return;
      }
      const bundles = await findBundleItems(t.organizationId, tIds);
      if (bundles.length > 0) {
        res.status(400).json({
          error: `Cannot transfer bundle items. Transfer their components instead. Offending: ${bundles
            .map((p) => p.sku)
            .join(", ")}`,
        });
        return;
      }
    }

    await db.transaction(async (tx) => {
      await tx
        .update(stockTransfersTable)
        .set({
          fromWarehouseId,
          toWarehouseId,
          transferDate: b.transferDate
            ? String(b.transferDate)
            : existing.transferDate,
          notes: b.notes === undefined ? existing.notes : b.notes,
        })
        .where(
          and(
            eq(stockTransfersTable.id, id),
            eq(stockTransfersTable.organizationId, t.organizationId),
          ),
        );
      if (parsedLines) {
        await tx
          .delete(stockTransferLinesTable)
          .where(
            and(
              eq(stockTransferLinesTable.organizationId, t.organizationId),
              eq(stockTransferLinesTable.stockTransferId, id),
            ),
          );
        await tx.insert(stockTransferLinesTable).values(
          parsedLines.map((p) => ({
            organizationId: t.organizationId,
            stockTransferId: id,
            itemId: p.itemId,
            quantity: toStr(p.quantity),
          })),
        );
      }
    });

    const detail = await loadDetail(t.organizationId, id);
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

router.delete("/stock-transfers/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const rows = await db
      .select()
      .from(stockTransfersTable)
      .where(
        and(
          eq(stockTransfersTable.id, id),
          eq(stockTransfersTable.organizationId, t.organizationId),
        ),
      )
      .limit(1);
    const existing = rows[0];
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (existing.status !== "draft") {
      res.status(400).json({
        error: "Only draft transfers can be deleted. Cancel it instead.",
      });
      return;
    }
    await db
      .delete(stockTransfersTable)
      .where(
        and(
          eq(stockTransfersTable.id, id),
          eq(stockTransfersTable.organizationId, t.organizationId),
        ),
      );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Atomic stock change. The `UPDATE ... SET quantity = quantity + :delta`
// statement is row-locked by Postgres for the duration of the transaction,
// so concurrent updates on the same (org, item, warehouse) tuple are
// serialized correctly (no lost updates).
async function applyStockChange(
  tx: Tx,
  orgId: number,
  itemId: number,
  warehouseId: number,
  delta: number,
) {
  const updated = await tx
    .update(itemWarehouseStockTable)
    .set({
      quantity: sql`${itemWarehouseStockTable.quantity} + ${toStr(delta)}::numeric`,
    })
    .where(
      and(
        eq(itemWarehouseStockTable.organizationId, orgId),
        eq(itemWarehouseStockTable.itemId, itemId),
        eq(itemWarehouseStockTable.warehouseId, warehouseId),
      ),
    )
    .returning({ id: itemWarehouseStockTable.id });
  if (updated.length === 0) {
    // No row exists for this (org, item, warehouse). For increments this
    // is the first stock event for the cell; for decrements it means the
    // caller failed to validate on-hand first (delta < 0 should have
    // been rejected with "Insufficient stock" earlier).
    await tx.insert(itemWarehouseStockTable).values({
      organizationId: orgId,
      itemId,
      warehouseId,
      quantity: toStr(delta),
    });
  }
}

router.post("/stock-transfers/:id/dispatch", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);

    // Optional batch picks per line. Shape: { lines: [{itemId, batches:
    // [{itemBatchId, quantity}, ...]}] }. Body itemId-keyed because a
    // transfer cannot have duplicate itemIds (enforced at create/edit).
    const body = req.body ?? {};
    const inputBatchPicksByItem = new Map<number, unknown>();
    if (Array.isArray(body.lines)) {
      for (const l of body.lines) {
        if (!l || typeof l !== "object") continue;
        const rec = l as { itemId?: unknown; batches?: unknown };
        const itemId = Number(rec.itemId);
        if (!Number.isFinite(itemId) || itemId <= 0) continue;
        inputBatchPicksByItem.set(itemId, rec.batches);
      }
    }

    const result = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(stockTransfersTable)
        .where(
          and(
            eq(stockTransfersTable.id, id),
            eq(stockTransfersTable.organizationId, t.organizationId),
          ),
        )
        .for("update")
        .limit(1);
      const transfer = rows[0];
      if (!transfer) return { kind: "notfound" as const };
      if (transfer.status !== "draft") {
        return {
          kind: "bad" as const,
          message: `Only draft transfers can be dispatched (current: ${transfer.status}).`,
        };
      }
      const lines = await tx
        .select()
        .from(stockTransferLinesTable)
        .where(
          and(
            eq(stockTransferLinesTable.organizationId, t.organizationId),
            eq(stockTransferLinesTable.stockTransferId, id),
          ),
        );
      if (lines.length === 0) {
        return {
          kind: "bad" as const,
          message: "Transfer has no lines to dispatch.",
        };
      }

      // Re-check that no line item has been toggled to a bundle since
      // the draft transfer was created. Bundles never hold physical
      // stock, so they cannot be moved between warehouses.
      const dispatchItemIds = Array.from(
        new Set(lines.map((l) => l.itemId)),
      );
      const dispatchBundles = await findBundleItems(
        t.organizationId,
        dispatchItemIds,
      );
      if (dispatchBundles.length > 0) {
        return {
          kind: "bad" as const,
          message:
            "Cannot dispatch a transfer line whose item is now a bundle. Bundles do not hold physical stock.",
        };
      }

      // Pre-load item meta so we can require batch picks for tracked
      // items and reject batch payloads on non-tracked ones.
      const itemRows = await tx
        .select({
          id: itemsTable.id,
          name: itemsTable.name,
          sku: itemsTable.sku,
          trackBatches: itemsTable.trackBatches,
        })
        .from(itemsTable)
        .where(
          and(
            eq(itemsTable.organizationId, t.organizationId),
            inArray(itemsTable.id, dispatchItemIds),
          ),
        );
      const itemById = new Map(itemRows.map((r) => [r.id, r]));

      // Validate source has enough stock for every line. Lock each stock
      // row FOR UPDATE so concurrent shipments / transfers on the same
      // (item, warehouse) cell can't both pass validation.
      for (const line of lines) {
        const stockRows = await tx
          .select({ quantity: itemWarehouseStockTable.quantity })
          .from(itemWarehouseStockTable)
          .where(
            and(
              eq(itemWarehouseStockTable.organizationId, t.organizationId),
              eq(itemWarehouseStockTable.itemId, line.itemId),
              eq(
                itemWarehouseStockTable.warehouseId,
                transfer.fromWarehouseId,
              ),
            ),
          )
          .for("update")
          .limit(1);
        const onHand = stockRows[0] ? toNum(stockRows[0].quantity) : 0;
        const need = toNum(line.quantity);
        if (need - onHand > 1e-6) {
          const meta = itemById.get(line.itemId);
          const label = meta
            ? `${meta.name} (${meta.sku})`
            : `item ${line.itemId}`;
          return {
            kind: "bad" as const,
            message: `Insufficient stock at source for ${label}: need ${need}, on hand ${onHand}.`,
          };
        }
      }

      // Validate batch picks for tracked items.
      const lineBatchPicks = new Map<number, ParsedBatchPick[]>();
      for (const line of lines) {
        const meta = itemById.get(line.itemId);
        const tracked = !!meta?.trackBatches;
        const rawPicks = inputBatchPicksByItem.get(line.itemId);
        if (tracked) {
          const parsedPicks = parseBatchPicks(
            rawPicks,
            toNum(line.quantity),
          );
          if (!parsedPicks.ok) {
            const label = meta
              ? `${meta.name} (${meta.sku})`
              : `item ${line.itemId}`;
            return {
              kind: "bad" as const,
              message: `${label}: ${parsedPicks.error}`,
            };
          }
          lineBatchPicks.set(line.itemId, parsedPicks.rows);
        } else if (
          rawPicks !== undefined &&
          Array.isArray(rawPicks) &&
          rawPicks.length > 0
        ) {
          const label = meta
            ? `${meta.name} (${meta.sku})`
            : `item ${line.itemId}`;
          return {
            kind: "bad" as const,
            message: `${label} is not batch-tracked; remove the batches array from this line`,
          };
        }
      }

      // Verify each picked batch ownership and per-batch on-hand at the
      // source warehouse (FOR UPDATE locks).
      for (const line of lines) {
        const picks = lineBatchPicks.get(line.itemId);
        if (!picks) continue;
        const ids = picks.map((x) => x.itemBatchId);
        const batchRows = await tx
          .select({
            id: itemBatchesTable.id,
            itemId: itemBatchesTable.itemId,
            batchNumber: itemBatchesTable.batchNumber,
          })
          .from(itemBatchesTable)
          .where(
            and(
              eq(itemBatchesTable.organizationId, t.organizationId),
              inArray(itemBatchesTable.id, ids),
            ),
          );
        const batchById = new Map(batchRows.map((r) => [r.id, r]));
        for (const pick of picks) {
          const br = batchById.get(pick.itemBatchId);
          if (!br) {
            return {
              kind: "bad" as const,
              message: `Batch ${pick.itemBatchId} not found for this organization`,
            };
          }
          if (br.itemId !== line.itemId) {
            return {
              kind: "bad" as const,
              message: `Batch ${br.batchNumber} does not belong to the line item`,
            };
          }
        }
        for (const pick of picks) {
          const stockRows = await tx
            .select({ quantity: itemBatchWarehouseStockTable.quantity })
            .from(itemBatchWarehouseStockTable)
            .where(
              and(
                eq(itemBatchWarehouseStockTable.organizationId, t.organizationId),
                eq(itemBatchWarehouseStockTable.itemBatchId, pick.itemBatchId),
                eq(
                  itemBatchWarehouseStockTable.warehouseId,
                  transfer.fromWarehouseId,
                ),
              ),
            )
            .for("update")
            .limit(1);
          const onHand = stockRows[0] ? toNum(stockRows[0].quantity) : 0;
          if (pick.quantity - onHand > 1e-6) {
            const br = batchById.get(pick.itemBatchId)!;
            return {
              kind: "bad" as const,
              message: `Insufficient stock for batch ${br.batchNumber} at the source warehouse: need ${pick.quantity}, on hand ${onHand}.`,
            };
          }
        }
      }

      await tx
        .update(stockTransfersTable)
        .set({ status: "in_transit" })
        .where(
          and(
            eq(stockTransfersTable.id, id),
            eq(stockTransfersTable.organizationId, t.organizationId),
          ),
        );

      const touchedItems = new Set<number>();
      for (const line of lines) {
        const qty = toNum(line.quantity);
        await applyStockChange(
          tx,
          t.organizationId,
          line.itemId,
          transfer.fromWarehouseId,
          -qty,
        );
        const mvt = await tx
          .insert(stockMovementsTable)
          .values({
            organizationId: t.organizationId,
            itemId: line.itemId,
            warehouseId: transfer.fromWarehouseId,
            movementType: "transfer_out",
            quantity: toStr(-qty),
            referenceType: "stock_transfer",
            referenceId: id,
            notes: `Dispatched via transfer ${transfer.transferNumber}`,
          })
          .returning({ id: stockMovementsTable.id });
        const parentMovementId = mvt[0]!.id;

        const picks = lineBatchPicks.get(line.itemId);
        if (picks) {
          for (const pick of picks) {
            await applyBatchStockChange(
              tx,
              t.organizationId,
              pick.itemBatchId,
              transfer.fromWarehouseId,
              -pick.quantity,
            );
            await insertBatchMovement(
              tx,
              t.organizationId,
              parentMovementId,
              pick.itemBatchId,
              transfer.fromWarehouseId,
              -pick.quantity,
            );
          }
        }
        touchedItems.add(line.itemId);
      }

      return {
        kind: "ok" as const,
        itemIds: Array.from(touchedItems),
      };
    });

    if (result.kind === "notfound") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (result.kind === "bad") {
      res.status(400).json({ error: result.message });
      return;
    }
    for (const itemId of result.itemIds) {
      pushStockToShopify(t.organizationId, itemId);
    }
    const detail = await loadDetail(t.organizationId, id);
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

router.post("/stock-transfers/:id/complete", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);

    const result = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(stockTransfersTable)
        .where(
          and(
            eq(stockTransfersTable.id, id),
            eq(stockTransfersTable.organizationId, t.organizationId),
          ),
        )
        .for("update")
        .limit(1);
      const transfer = rows[0];
      if (!transfer) return { kind: "notfound" as const };
      if (transfer.status !== "in_transit") {
        return {
          kind: "bad" as const,
          message: `Only in-transit transfers can be completed (current: ${transfer.status}).`,
        };
      }
      const lines = await tx
        .select()
        .from(stockTransferLinesTable)
        .where(
          and(
            eq(stockTransferLinesTable.organizationId, t.organizationId),
            eq(stockTransferLinesTable.stockTransferId, id),
          ),
        );

      // Re-check that no line item has been toggled to a bundle since
      // dispatch. Bundles cannot receive physical stock at the
      // destination warehouse.
      const completeItemIds = Array.from(
        new Set(lines.map((l) => l.itemId)),
      );
      const completeBundles = await findBundleItems(
        t.organizationId,
        completeItemIds,
      );
      if (completeBundles.length > 0) {
        return {
          kind: "bad" as const,
          message:
            "Cannot complete a transfer line whose item is now a bundle. Bundles do not hold physical stock.",
        };
      }

      // Load original transfer_out parent movements + their batch
      // ledger entries so we can mirror them onto the destination
      // warehouse at completion time (no UI re-pick needed).
      const dispatchParents = await tx
        .select({
          id: stockMovementsTable.id,
          itemId: stockMovementsTable.itemId,
          quantity: stockMovementsTable.quantity,
        })
        .from(stockMovementsTable)
        .where(
          and(
            eq(stockMovementsTable.organizationId, t.organizationId),
            eq(stockMovementsTable.referenceType, "stock_transfer"),
            eq(stockMovementsTable.referenceId, id),
            eq(stockMovementsTable.movementType, "transfer_out"),
          ),
        );
      const dispatchBatchMvts = await loadBatchMovementsForParents(
        t.organizationId,
        dispatchParents.map((p) => p.id),
      );
      const dispatchBatchByParent = new Map<
        number,
        typeof dispatchBatchMvts
      >();
      for (const m of dispatchBatchMvts) {
        const arr = dispatchBatchByParent.get(m.stockMovementId) ?? [];
        arr.push(m);
        dispatchBatchByParent.set(m.stockMovementId, arr);
      }
      // Group dispatch parents by itemId so we can pair to each line.
      const dispatchParentsByItem = new Map<
        number,
        typeof dispatchParents
      >();
      for (const dp of dispatchParents) {
        const arr = dispatchParentsByItem.get(dp.itemId) ?? [];
        arr.push(dp);
        dispatchParentsByItem.set(dp.itemId, arr);
      }

      await tx
        .update(stockTransfersTable)
        .set({ status: "completed" })
        .where(
          and(
            eq(stockTransfersTable.id, id),
            eq(stockTransfersTable.organizationId, t.organizationId),
          ),
        );

      const touchedItems = new Set<number>();
      for (const line of lines) {
        const qty = toNum(line.quantity);
        await applyStockChange(
          tx,
          t.organizationId,
          line.itemId,
          transfer.toWarehouseId,
          qty,
        );
        const mvt = await tx
          .insert(stockMovementsTable)
          .values({
            organizationId: t.organizationId,
            itemId: line.itemId,
            warehouseId: transfer.toWarehouseId,
            movementType: "transfer_in",
            quantity: toStr(qty),
            referenceType: "stock_transfer",
            referenceId: id,
            notes: `Received via transfer ${transfer.transferNumber}`,
          })
          .returning({ id: stockMovementsTable.id });
        const parentMovementId = mvt[0]!.id;

        // Mirror dispatch's per-batch fan-out onto destination wh.
        // For each dispatch parent for this itemId, pull its batch
        // ledger and write positive (qty) entries at destination.
        const itemDispatchParents =
          dispatchParentsByItem.get(line.itemId) ?? [];
        for (const dp of itemDispatchParents) {
          for (const bm of dispatchBatchByParent.get(dp.id) ?? []) {
            // bm.quantity was negative at dispatch; flip to positive.
            const recvQty = -bm.quantity;
            await applyBatchStockChange(
              tx,
              t.organizationId,
              bm.itemBatchId,
              transfer.toWarehouseId,
              recvQty,
            );
            await insertBatchMovement(
              tx,
              t.organizationId,
              parentMovementId,
              bm.itemBatchId,
              transfer.toWarehouseId,
              recvQty,
            );
          }
        }
        touchedItems.add(line.itemId);
      }

      return {
        kind: "ok" as const,
        itemIds: Array.from(touchedItems),
      };
    });

    if (result.kind === "notfound") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (result.kind === "bad") {
      res.status(400).json({ error: result.message });
      return;
    }
    for (const itemId of result.itemIds) {
      pushStockToShopify(t.organizationId, itemId);
    }
    const detail = await loadDetail(t.organizationId, id);
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

router.post("/stock-transfers/:id/cancel", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);

    const result = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(stockTransfersTable)
        .where(
          and(
            eq(stockTransfersTable.id, id),
            eq(stockTransfersTable.organizationId, t.organizationId),
          ),
        )
        .for("update")
        .limit(1);
      const transfer = rows[0];
      if (!transfer) return { kind: "notfound" as const };
      if (transfer.status === "cancelled") {
        return {
          kind: "bad" as const,
          message: "Transfer is already cancelled.",
        };
      }
      if (transfer.status === "completed") {
        return {
          kind: "bad" as const,
          message:
            "Completed transfers cannot be cancelled. Create a new transfer to reverse the move.",
        };
      }
      const lines = await tx
        .select()
        .from(stockTransferLinesTable)
        .where(
          and(
            eq(stockTransferLinesTable.organizationId, t.organizationId),
            eq(stockTransferLinesTable.stockTransferId, id),
          ),
        );

      await tx
        .update(stockTransfersTable)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(stockTransfersTable.id, id),
            eq(stockTransfersTable.organizationId, t.organizationId),
          ),
        );

      // Only in_transit → cancelled needs to re-credit the source. Draft
      // → cancelled has not moved any stock yet.
      const touchedItems = new Set<number>();
      if (transfer.status === "in_transit") {
        // Pull the original transfer_out batch fan-out so we can
        // mirror it back to the source as positive batch movements.
        const dispatchParents = await tx
          .select({
            id: stockMovementsTable.id,
            itemId: stockMovementsTable.itemId,
          })
          .from(stockMovementsTable)
          .where(
            and(
              eq(stockMovementsTable.organizationId, t.organizationId),
              eq(stockMovementsTable.referenceType, "stock_transfer"),
              eq(stockMovementsTable.referenceId, id),
              eq(stockMovementsTable.movementType, "transfer_out"),
            ),
          );
        const dispatchBatchMvts = await loadBatchMovementsForParents(
          t.organizationId,
          dispatchParents.map((p) => p.id),
        );
        const batchByParent = new Map<number, typeof dispatchBatchMvts>();
        for (const m of dispatchBatchMvts) {
          const arr = batchByParent.get(m.stockMovementId) ?? [];
          arr.push(m);
          batchByParent.set(m.stockMovementId, arr);
        }
        const parentsByItem = new Map<number, typeof dispatchParents>();
        for (const dp of dispatchParents) {
          const arr = parentsByItem.get(dp.itemId) ?? [];
          arr.push(dp);
          parentsByItem.set(dp.itemId, arr);
        }

        for (const line of lines) {
          const qty = toNum(line.quantity);
          await applyStockChange(
            tx,
            t.organizationId,
            line.itemId,
            transfer.fromWarehouseId,
            qty,
          );
          const mvt = await tx
            .insert(stockMovementsTable)
            .values({
              organizationId: t.organizationId,
              itemId: line.itemId,
              warehouseId: transfer.fromWarehouseId,
              movementType: "transfer_cancelled",
              quantity: toStr(qty),
              referenceType: "stock_transfer",
              referenceId: id,
              notes: `Cancelled transfer ${transfer.transferNumber}`,
            })
            .returning({ id: stockMovementsTable.id });
          const cancelParentId = mvt[0]!.id;

          // Reverse each original batch movement back to the source.
          for (const dp of parentsByItem.get(line.itemId) ?? []) {
            for (const bm of batchByParent.get(dp.id) ?? []) {
              const refund = -bm.quantity; // bm.quantity is negative
              await applyBatchStockChange(
                tx,
                t.organizationId,
                bm.itemBatchId,
                transfer.fromWarehouseId,
                refund,
              );
              await insertBatchMovement(
                tx,
                t.organizationId,
                cancelParentId,
                bm.itemBatchId,
                transfer.fromWarehouseId,
                refund,
              );
            }
          }
          touchedItems.add(line.itemId);
        }
      }

      return {
        kind: "ok" as const,
        itemIds: Array.from(touchedItems),
      };
    });

    if (result.kind === "notfound") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (result.kind === "bad") {
      res.status(400).json({ error: result.message });
      return;
    }
    for (const itemId of result.itemIds) {
      pushStockToShopify(t.organizationId, itemId);
    }
    const detail = await loadDetail(t.organizationId, id);
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

export default router;
