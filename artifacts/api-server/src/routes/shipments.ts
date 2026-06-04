import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  salesOrdersTable,
  salesOrderLinesTable,
  shipmentsTable,
  shipmentLinesTable,
  itemsTable,
  itemBatchesTable,
  itemBatchWarehouseStockTable,
  itemBundleComponentsTable,
  itemWarehouseStockTable,
  stockMovementsTable,
} from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import {
  serializeShipment,
  serializeShipmentLine,
} from "../lib/serializers";
import { nextOrderNumber } from "../lib/orderHelpers";
import { toNum, toStr } from "../lib/numeric";
import { pushFulfillmentToShopify, pushStockToShopify } from "../lib/shopifyOutbound";
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

const SHIPPABLE_ORDER_STATUSES = ["confirmed", "partially_shipped"] as const;
const CANCEL_SHIPMENT_ORDER_STATUSES = ["shipped", "partially_shipped"] as const;

async function deriveAndUpdateOrderStatus(
  tx: Tx,
  orgId: number,
  orderId: number,
) {
  const lines = await tx
    .select({
      quantity: salesOrderLinesTable.quantity,
      quantityShipped: salesOrderLinesTable.quantityShipped,
    })
    .from(salesOrderLinesTable)
    .where(eq(salesOrderLinesTable.salesOrderId, orderId));
  let totalOrdered = 0;
  let totalShipped = 0;
  for (const l of lines) {
    totalOrdered += toNum(l.quantity);
    totalShipped += toNum(l.quantityShipped);
  }
  let nextStatus: "confirmed" | "partially_shipped" | "shipped";
  if (totalShipped <= 0) nextStatus = "confirmed";
  else if (totalShipped < totalOrdered) nextStatus = "partially_shipped";
  else nextStatus = "shipped";
  await tx
    .update(salesOrdersTable)
    .set({ status: nextStatus })
    .where(
      and(
        eq(salesOrdersTable.id, orderId),
        eq(salesOrdersTable.organizationId, orgId),
      ),
    );
  return nextStatus;
}

async function loadShipmentsForOrder(orgId: number, orderId: number) {
  const shipments = await db
    .select()
    .from(shipmentsTable)
    .where(
      and(
        eq(shipmentsTable.organizationId, orgId),
        eq(shipmentsTable.salesOrderId, orderId),
      ),
    )
    .orderBy(desc(shipmentsTable.createdAt));
  if (shipments.length === 0) return [];
  const ids = shipments.map((s) => s.id);
  const lineRows = await db
    .select({
      line: shipmentLinesTable,
      itemName: itemsTable.name,
      sku: itemsTable.sku,
      salesOrderLineId: salesOrderLinesTable.id,
    })
    .from(shipmentLinesTable)
    .innerJoin(
      salesOrderLinesTable,
      eq(salesOrderLinesTable.id, shipmentLinesTable.salesOrderLineId),
    )
    .innerJoin(itemsTable, eq(itemsTable.id, salesOrderLinesTable.itemId))
    .where(
      and(
        eq(shipmentLinesTable.organizationId, orgId),
        inArray(shipmentLinesTable.shipmentId, ids),
      ),
    );
  const linesByShipment = new Map<number, typeof lineRows>();
  for (const r of lineRows) {
    const arr = linesByShipment.get(r.line.shipmentId) ?? [];
    arr.push(r);
    linesByShipment.set(r.line.shipmentId, arr);
  }
  return shipments.map((s) => ({
    ...serializeShipment(s),
    lines: (linesByShipment.get(s.id) ?? []).map((r) =>
      serializeShipmentLine(r.line, r.itemName, r.sku, r.salesOrderLineId),
    ),
  }));
}

router.get("/sales-orders/:id/shipments", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orderId = Number(req.params.id);
    const owner = await db
      .select({ id: salesOrdersTable.id })
      .from(salesOrdersTable)
      .where(
        and(
          eq(salesOrdersTable.id, orderId),
          eq(salesOrdersTable.organizationId, t.organizationId),
        ),
      )
      .limit(1);
    if (!owner[0]) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const shipments = await loadShipmentsForOrder(t.organizationId, orderId);
    res.json(shipments);
  } catch (err) {
    next(err);
  }
});

router.post("/sales-orders/:id/shipments", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const orderId = Number(req.params.id);
    const b = req.body ?? {};
    const inputLines = Array.isArray(b.lines) ? b.lines : [];
    if (inputLines.length === 0) {
      res.status(400).json({ error: "At least one shipment line is required" });
      return;
    }
    type Input = {
      salesOrderLineId: number;
      quantity: number;
      batchesRaw: unknown;
    };
    const parsed: Input[] = [];
    for (const l of inputLines) {
      const lineId = Number(l?.salesOrderLineId);
      const qty = toNum(l?.quantity);
      if (!Number.isFinite(lineId) || lineId <= 0) {
        res.status(400).json({ error: "Each line must include salesOrderLineId" });
        return;
      }
      if (!(qty > 0)) {
        res.status(400).json({ error: "Each line quantity must be greater than zero" });
        return;
      }
      parsed.push({
        salesOrderLineId: lineId,
        quantity: qty,
        batchesRaw: l && typeof l === "object" ? (l as { batches?: unknown }).batches : undefined,
      });
    }
    const lineIds = parsed.map((p) => p.salesOrderLineId);
    if (new Set(lineIds).size !== lineIds.length) {
      res.status(400).json({ error: "Duplicate salesOrderLineId in shipment lines" });
      return;
    }

    let shipDate: string;
    if (typeof b.shipDate === "string" && b.shipDate.trim()) {
      const raw = b.shipDate.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        res.status(400).json({
          error: "shipDate must be an ISO date in YYYY-MM-DD format",
        });
        return;
      }
      const d = new Date(`${raw}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
        res.status(400).json({ error: "shipDate is not a valid date" });
        return;
      }
      shipDate = raw;
    } else {
      shipDate = new Date().toISOString().slice(0, 10);
    }
    const notes =
      typeof b.notes === "string" && b.notes.trim() ? String(b.notes).trim() : null;

    const result = await db.transaction(async (tx) => {
      const orderRows = await tx
        .select()
        .from(salesOrdersTable)
        .where(
          and(
            eq(salesOrdersTable.id, orderId),
            eq(salesOrdersTable.organizationId, t.organizationId),
          ),
        )
        .for("update")
        .limit(1);
      const order = orderRows[0];
      if (!order) return { kind: "notfound" as const };
      if (
        !(SHIPPABLE_ORDER_STATUSES as readonly string[]).includes(order.status)
      ) {
        return {
          kind: "bad" as const,
          message: `Only confirmed or partially-shipped orders can record shipments (current: ${order.status}).`,
        };
      }

      const lineRows = await tx
        .select()
        .from(salesOrderLinesTable)
        .where(eq(salesOrderLinesTable.salesOrderId, orderId));
      const linesById = new Map(lineRows.map((l) => [l.id, l]));

      for (const p of parsed) {
        const line = linesById.get(p.salesOrderLineId);
        if (!line) {
          return {
            kind: "bad" as const,
            message: `Line ${p.salesOrderLineId} does not belong to this order`,
          };
        }
        const ordered = toNum(line.quantity);
        const alreadyShipped = toNum(line.quantityShipped);
        const remaining = ordered - alreadyShipped;
        if (p.quantity - remaining > 1e-6) {
          return {
            kind: "bad" as const,
            message: `Line ${p.salesOrderLineId}: cannot ship ${p.quantity} (remaining ${remaining}).`,
          };
        }
      }

      // Pre-load referenced items so we can detect bundles and fan out
      // their stock decrement to each component in a single transaction.
      const itemIdsInShipment = Array.from(
        new Set(parsed.map((p) => linesById.get(p.salesOrderLineId)!.itemId)),
      );
      const itemRows = itemIdsInShipment.length
        ? await tx
            .select({
              id: itemsTable.id,
              isBundle: itemsTable.isBundle,
              trackBatches: itemsTable.trackBatches,
              sku: itemsTable.sku,
              name: itemsTable.name,
            })
            .from(itemsTable)
            .where(
              and(
                eq(itemsTable.organizationId, t.organizationId),
                inArray(itemsTable.id, itemIdsInShipment),
              ),
            )
        : [];
      const itemById = new Map(itemRows.map((r) => [r.id, r]));
      const bundleParentIds = itemRows
        .filter((r) => r.isBundle)
        .map((r) => r.id);
      // For every bundle in the shipment, load its current components.
      const componentsByParent = new Map<
        number,
        Array<{ componentItemId: number; quantityPerBundle: number }>
      >();
      if (bundleParentIds.length > 0) {
        const compRows = await tx
          .select({
            parentItemId: itemBundleComponentsTable.parentItemId,
            componentItemId: itemBundleComponentsTable.componentItemId,
            quantityPerBundle: itemBundleComponentsTable.quantityPerBundle,
          })
          .from(itemBundleComponentsTable)
          .where(
            and(
              eq(
                itemBundleComponentsTable.organizationId,
                t.organizationId,
              ),
              inArray(itemBundleComponentsTable.parentItemId, bundleParentIds),
            ),
          );
        for (const c of compRows) {
          const arr = componentsByParent.get(c.parentItemId) ?? [];
          arr.push({
            componentItemId: c.componentItemId,
            quantityPerBundle: toNum(c.quantityPerBundle),
          });
          componentsByParent.set(c.parentItemId, arr);
        }
        // A bundle without components in the database is a misconfiguration
        // and we refuse to ship it rather than silently no-op the stock.
        for (const id of bundleParentIds) {
          const arr = componentsByParent.get(id);
          if (!arr || arr.length === 0) {
            const sku = itemById.get(id)?.sku ?? `#${id}`;
            return {
              kind: "bad" as const,
              message: `Bundle ${sku} has no components configured`,
            };
          }
        }
        // P0: reject bundles that contain batch-tracked components.
        // Mixing batch picks with bundle expansion is a P1 concern.
        const componentIds = Array.from(
          new Set(
            Array.from(componentsByParent.values()).flatMap((arr) =>
              arr.map((c) => c.componentItemId),
            ),
          ),
        );
        if (componentIds.length > 0) {
          const trackedComps = await tx
            .select({
              id: itemsTable.id,
              sku: itemsTable.sku,
              name: itemsTable.name,
            })
            .from(itemsTable)
            .where(
              and(
                eq(itemsTable.organizationId, t.organizationId),
                inArray(itemsTable.id, componentIds),
                eq(itemsTable.trackBatches, true),
              ),
            );
          if (trackedComps.length > 0) {
            return {
              kind: "bad" as const,
              message: `Cannot ship a bundle containing batch-tracked components: ${trackedComps
                .map((c) => `${c.name} (${c.sku})`)
                .join(", ")}. Disable bundle and ship the components individually.`,
            };
          }
        }
      }

      // Validate batch picks for tracked items; reject batch payloads
      // for non-tracked items so UI bugs are visible.
      const lineBatchPicks = new Map<number, ParsedBatchPick[]>();
      for (const p of parsed) {
        const line = linesById.get(p.salesOrderLineId)!;
        const itemMeta = itemById.get(line.itemId);
        const tracked = !!itemMeta?.trackBatches;
        if (tracked) {
          const parsedPicks = parseBatchPicks(p.batchesRaw, p.quantity);
          if (!parsedPicks.ok) {
            const label = itemMeta
              ? `${itemMeta.name} (${itemMeta.sku})`
              : `item ${line.itemId}`;
            return {
              kind: "bad" as const,
              message: `${label}: ${parsedPicks.error}`,
            };
          }
          lineBatchPicks.set(p.salesOrderLineId, parsedPicks.rows);
        } else if (
          p.batchesRaw !== undefined &&
          Array.isArray(p.batchesRaw) &&
          p.batchesRaw.length > 0
        ) {
          const label = itemMeta
            ? `${itemMeta.name} (${itemMeta.sku})`
            : `item ${line.itemId}`;
          return {
            kind: "bad" as const,
            message: `${label} is not batch-tracked; remove the batches array from this line`,
          };
        }
      }

      // Verify each picked batch belongs to the right item, and the
      // source warehouse has enough on-hand for that batch (FOR UPDATE
      // locks on the batch-warehouse cells).
      for (const p of parsed) {
        const line = linesById.get(p.salesOrderLineId)!;
        const picks = lineBatchPicks.get(p.salesOrderLineId);
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
                eq(itemBatchWarehouseStockTable.warehouseId, order.warehouseId),
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

      const inserted = await tx
        .insert(shipmentsTable)
        .values({
          organizationId: t.organizationId,
          salesOrderId: orderId,
          shipmentNumber: nextOrderNumber("SHIP"),
          shipDate,
          status: "shipped",
          notes,
        })
        .returning();
      const shipment = inserted[0]!;

      await tx.insert(shipmentLinesTable).values(
        parsed.map((p) => ({
          organizationId: t.organizationId,
          shipmentId: shipment.id,
          salesOrderLineId: p.salesOrderLineId,
          quantity: toStr(p.quantity),
        })),
      );

      // Helper: atomically decrement a single (item, warehouse) by qty
      // and write a matching stock movement row. Uses SQL `quantity =
      // quantity - delta` (row-locked by Postgres for the duration of
      // this transaction) so concurrent shipments / cancellations on
      // the same cell can't lose updates. Returns the inserted parent
      // stockMovementId for batch ledger fan-out.
      const decrementStock = async (
        itemId: number,
        warehouseId: number,
        qty: number,
        notesText: string,
      ): Promise<number> => {
        const updated = await tx
          .update(itemWarehouseStockTable)
          .set({
            quantity: sql`${itemWarehouseStockTable.quantity} - ${toStr(qty)}::numeric`,
          })
          .where(
            and(
              eq(itemWarehouseStockTable.organizationId, t.organizationId),
              eq(itemWarehouseStockTable.itemId, itemId),
              eq(itemWarehouseStockTable.warehouseId, warehouseId),
            ),
          )
          .returning({ id: itemWarehouseStockTable.id });
        if (updated.length === 0) {
          await tx.insert(itemWarehouseStockTable).values({
            organizationId: t.organizationId,
            itemId,
            warehouseId,
            quantity: toStr(-qty),
          });
        }
        const mvt = await tx
          .insert(stockMovementsTable)
          .values({
            organizationId: t.organizationId,
            itemId,
            warehouseId: warehouseId,
            movementType: "sale",
            quantity: toStr(-qty),
            referenceType: "shipment",
            referenceId: shipment.id,
            notes: notesText,
          })
          .returning({ id: stockMovementsTable.id });
        return mvt[0]!.id;
      };

      const touchedItems = new Set<number>();
      for (const p of parsed) {
        const line = linesById.get(p.salesOrderLineId)!;
        const qty = p.quantity;
        const item = itemById.get(line.itemId);
        const baseNote = `Shipment ${shipment.shipmentNumber} for order ${order.orderNumber}`;
        if (item?.isBundle) {
          // Bundle: fan out per component. The shipment line still
          // records the bundle quantity, but stock & movements are at
          // the component level so reporting and reorder rules work.
          // Bundles with batch-tracked components were rejected up
          // front, so component decrements never need batch fan-out.
          const comps = componentsByParent.get(line.itemId)!;
          for (const c of comps) {
            const compQty = qty * c.quantityPerBundle;
            await decrementStock(
              c.componentItemId,
              order.warehouseId,
              compQty,
              `${baseNote} (component of bundle ${item.sku})`,
            );
            touchedItems.add(c.componentItemId);
          }
          // Also mark the bundle itself so Shopify gets a stock push
          // (its derived total just changed).
          touchedItems.add(line.itemId);
        } else {
          const parentMovementId = await decrementStock(
            line.itemId,
            order.warehouseId,
            qty,
            baseNote,
          );
          // For batch-tracked items, fan the parent decrement out
          // across the picked batches.
          const picks = lineBatchPicks.get(p.salesOrderLineId);
          if (picks) {
            for (const pick of picks) {
              await applyBatchStockChange(
                tx,
                t.organizationId,
                pick.itemBatchId,
                order.warehouseId,
                -pick.quantity,
              );
              await insertBatchMovement(
                tx,
                t.organizationId,
                parentMovementId,
                pick.itemBatchId,
                order.warehouseId,
                -pick.quantity,
              );
            }
          }
          touchedItems.add(line.itemId);
        }
        await tx
          .update(salesOrderLinesTable)
          .set({
            quantityShipped: toStr(toNum(line.quantityShipped) + qty),
          })
          .where(eq(salesOrderLinesTable.id, line.id));
      }

      await deriveAndUpdateOrderStatus(tx, t.organizationId, orderId);
      return {
        kind: "ok" as const,
        shipmentId: shipment.id,
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
    pushFulfillmentToShopify(t.organizationId, orderId);
    const shipments = await loadShipmentsForOrder(t.organizationId, orderId);
    const created = shipments.find((s) => s.id === result.shipmentId);
    res.status(201).json(created ?? null);
  } catch (err) {
    next(err);
  }
});

const CANCEL_REASON_CODES = new Set([
  "customer_changed_mind",
  "damaged",
  "wrong_item",
  "defective",
  "pricing_error",
  "duplicate",
  "other",
]);

router.post("/shipments/:shipmentId/cancel", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const shipmentId = Number(req.params.shipmentId);
    // Optional cancel-reason metadata (Feature 4 — return reason
    // tracking). Body is optional; if reasonCode is supplied it must be
    // one of CANCEL_REASON_CODES, otherwise we 400 rather than silently
    // dropping data the user expected to be persisted.
    const body = (req.body ?? {}) as {
      reasonCode?: unknown;
      reasonNotes?: unknown;
    };
    let reasonCode: string | null = null;
    if (body.reasonCode !== undefined && body.reasonCode !== null) {
      if (
        typeof body.reasonCode !== "string" ||
        !CANCEL_REASON_CODES.has(body.reasonCode)
      ) {
        res.status(400).json({ error: "Invalid cancel reasonCode" });
        return;
      }
      reasonCode = body.reasonCode;
    }
    let reasonNotes: string | null = null;
    if (body.reasonNotes !== undefined && body.reasonNotes !== null) {
      if (typeof body.reasonNotes !== "string") {
        res.status(400).json({ error: "reasonNotes must be a string" });
        return;
      }
      const trimmed = body.reasonNotes.trim();
      if (trimmed.length > 1000) {
        res
          .status(400)
          .json({ error: "reasonNotes must be 1000 chars or fewer" });
        return;
      }
      reasonNotes = trimmed.length > 0 ? trimmed : null;
    }

    const result = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(shipmentsTable)
        .where(
          and(
            eq(shipmentsTable.id, shipmentId),
            eq(shipmentsTable.organizationId, t.organizationId),
          ),
        )
        .for("update")
        .limit(1);
      const shipment = rows[0];
      if (!shipment) return { kind: "notfound" as const };
      if (shipment.status === "cancelled") {
        return {
          kind: "bad" as const,
          message: "Shipment is already cancelled",
        };
      }
      const orderRows = await tx
        .select()
        .from(salesOrdersTable)
        .where(
          and(
            eq(salesOrdersTable.id, shipment.salesOrderId),
            eq(salesOrdersTable.organizationId, t.organizationId),
          ),
        )
        .for("update")
        .limit(1);
      const order = orderRows[0];
      if (!order) return { kind: "notfound" as const };
      if (
        !(CANCEL_SHIPMENT_ORDER_STATUSES as readonly string[]).includes(
          order.status,
        )
      ) {
        return {
          kind: "bad" as const,
          message: `Cannot cancel a shipment when the order is ${order.status}.`,
        };
      }

      const shipLines = await tx
        .select({
          line: shipmentLinesTable,
          itemId: salesOrderLinesTable.itemId,
          orderLineId: salesOrderLinesTable.id,
          orderLineQuantityShipped: salesOrderLinesTable.quantityShipped,
        })
        .from(shipmentLinesTable)
        .innerJoin(
          salesOrderLinesTable,
          eq(salesOrderLinesTable.id, shipmentLinesTable.salesOrderLineId),
        )
        .where(
          and(
            eq(shipmentLinesTable.organizationId, t.organizationId),
            eq(shipmentLinesTable.shipmentId, shipmentId),
          ),
        );

      await tx
        .update(shipmentsTable)
        .set({
          status: "cancelled",
          cancelReasonCode: reasonCode,
          cancelReasonNotes: reasonNotes,
          cancelledAt: new Date(),
        })
        .where(
          and(
            eq(shipmentsTable.organizationId, t.organizationId),
            eq(shipmentsTable.id, shipmentId),
          ),
        );

      // Cancellation reverses exactly what was decremented at ship time
      // by reading the original `sale` stockMovements rows for this
      // shipment. This is correct even when the item has since been
      // toggled to/from a bundle or its component set has changed —
      // we never recompute the bundle expansion at cancel time.
      const saleMovements = await tx
        .select({
          id: stockMovementsTable.id,
          itemId: stockMovementsTable.itemId,
          warehouseId: stockMovementsTable.warehouseId,
          quantity: stockMovementsTable.quantity,
          notes: stockMovementsTable.notes,
        })
        .from(stockMovementsTable)
        .where(
          and(
            eq(stockMovementsTable.organizationId, t.organizationId),
            eq(stockMovementsTable.referenceType, "shipment"),
            eq(stockMovementsTable.referenceId, shipmentId),
            eq(stockMovementsTable.movementType, "sale"),
          ),
        );

      const allBatchMvts = await loadBatchMovementsForParents(
        t.organizationId,
        saleMovements.map((m) => m.id),
      );
      const batchByParent = new Map<number, typeof allBatchMvts>();
      for (const m of allBatchMvts) {
        const arr = batchByParent.get(m.stockMovementId) ?? [];
        arr.push(m);
        batchByParent.set(m.stockMovementId, arr);
      }

      // Atomic increment using SQL `quantity = quantity + delta` so
      // concurrent shipment / cancel writes on the same (item, warehouse)
      // cell don't lose updates. Returns the new parent movement id so
      // batch ledger reversals can be tied to it.
      const incrementStock = async (
        itemId: number,
        warehouseId: number,
        qty: number,
        notesText: string,
      ): Promise<number> => {
        const updated = await tx
          .update(itemWarehouseStockTable)
          .set({
            quantity: sql`${itemWarehouseStockTable.quantity} + ${toStr(qty)}::numeric`,
          })
          .where(
            and(
              eq(itemWarehouseStockTable.organizationId, t.organizationId),
              eq(itemWarehouseStockTable.itemId, itemId),
              eq(itemWarehouseStockTable.warehouseId, warehouseId),
            ),
          )
          .returning({ id: itemWarehouseStockTable.id });
        if (updated.length === 0) {
          await tx.insert(itemWarehouseStockTable).values({
            organizationId: t.organizationId,
            itemId,
            warehouseId,
            quantity: toStr(qty),
          });
        }
        const mvt = await tx
          .insert(stockMovementsTable)
          .values({
            organizationId: t.organizationId,
            itemId,
            warehouseId,
            movementType: "shipment_cancelled",
            quantity: toStr(qty),
            referenceType: "shipment",
            referenceId: shipmentId,
            notes: notesText,
          })
          .returning({ id: stockMovementsTable.id });
        return mvt[0]!.id;
      };

      const touchedItems = new Set<number>();
      const baseNote = `Cancelled shipment ${shipment.shipmentNumber}`;
      // Reverse every original `sale` movement: ship-time wrote
      // negative quantities (e.g. -5), so the original quantity is
      // already the negation of what we need to add back.
      for (const m of saleMovements) {
        const original = toNum(m.quantity); // negative
        const refund = -original; // positive
        const cancelParentId = await incrementStock(
          m.itemId,
          m.warehouseId,
          refund,
          m.notes ? `${baseNote} — ${m.notes}` : baseNote,
        );
        for (const bm of batchByParent.get(m.id) ?? []) {
          // bm.quantity was the original negative batch qty. Add the
          // positive equivalent back to the (batch, warehouse) cell.
          await applyBatchStockChange(
            tx,
            t.organizationId,
            bm.itemBatchId,
            bm.warehouseId,
            -bm.quantity,
          );
          await insertBatchMovement(
            tx,
            t.organizationId,
            cancelParentId,
            bm.itemBatchId,
            bm.warehouseId,
            -bm.quantity,
          );
        }
        touchedItems.add(m.itemId);
      }

      // Update each SO line's quantityShipped using the bundle qty
      // recorded on the shipment line (this is independent of bundle
      // expansion — it tracks order fulfillment, not stock).
      for (const sl of shipLines) {
        const qty = toNum(sl.line.quantity);
        await tx
          .update(salesOrderLinesTable)
          .set({
            quantityShipped: toStr(
              Math.max(0, toNum(sl.orderLineQuantityShipped) - qty),
            ),
          })
          .where(eq(salesOrderLinesTable.id, sl.orderLineId));
        // Make sure the SO line item (which may be a bundle) also gets
        // a Shopify push, since its derived total just changed.
        touchedItems.add(sl.itemId);
      }

      await deriveAndUpdateOrderStatus(tx, t.organizationId, shipment.salesOrderId);
      return {
        kind: "ok" as const,
        salesOrderId: shipment.salesOrderId,
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
    const shipments = await loadShipmentsForOrder(
      t.organizationId,
      result.salesOrderId,
    );
    const updated = shipments.find((s) => s.id === shipmentId);
    res.json(updated ?? null);
  } catch (err) {
    next(err);
  }
});

export default router;
export { loadShipmentsForOrder, deriveAndUpdateOrderStatus };
