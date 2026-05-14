import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  salesOrdersTable,
  salesOrderLinesTable,
  shipmentsTable,
  shipmentLinesTable,
  itemsTable,
  itemBundleComponentsTable,
  itemWarehouseStockTable,
  stockMovementsTable,
  customersTable,
  warehousesTable,
  customerPaymentsTable,
  customerPaymentAllocationsTable,
} from "@workspace/db";
import { computeOrderTotals, nextOrderNumber } from "./orderHelpers";
import { toNum, toStr } from "./numeric";
import { getDefaultWarehouseId } from "./tenant";
import { getOrCreateWalkInCustomerId } from "./walkInCustomer";

export const POS_PAYMENT_MODES = [
  "cash",
  "card",
  "upi",
  "bank",
  "other",
] as const;
export type PosPaymentMode = (typeof POS_PAYMENT_MODES)[number];

export interface PosCheckoutLineInput {
  itemId: number;
  quantity: number;
  unitPrice?: number; // overrides item.salePrice when provided
  taxRate?: number; // overrides item.taxRate when provided
  description?: string | null;
}

export interface PosCheckoutInput {
  lines: PosCheckoutLineInput[];
  customerId?: number | null;
  warehouseId?: number | null;
  payment: {
    mode: PosPaymentMode;
    amount: number;
    referenceNumber?: string | null;
    bankAccountLabel?: string | null;
    notes?: string | null;
  };
  notes?: string | null;
  // Optional walk-in customer details. Captured on the order's `notes`
  // field — we deliberately do NOT create a permanent customer row for
  // walk-ins (per the task spec) so the customers list isn't polluted
  // with one-off retail buyers. Only used when no customerId is given.
  customerName?: string | null;
  customerPhone?: string | null;
  // Mode of sale captured at the POS (walk-in / website / store /
  // whatsapp / phone / instagram / other). Stored at the top of the
  // order's `notes` field so it shows up wherever sales-order notes
  // are displayed without requiring a schema migration.
  saleChannel?: PosSaleChannel | null;
}

export const POS_SALE_CHANNELS = [
  "walkin",
  "website",
  "store",
  "whatsapp",
  "phone",
  "instagram",
  "other",
] as const;
export type PosSaleChannel = (typeof POS_SALE_CHANNELS)[number];

const SALE_CHANNEL_LABELS: Record<PosSaleChannel, string> = {
  walkin: "Walk-in",
  website: "Website",
  store: "Store",
  whatsapp: "WhatsApp",
  phone: "Phone",
  instagram: "Instagram",
  other: "Other",
};

export interface PosCheckoutResult {
  salesOrderId: number;
  orderNumber: string;
  customerId: number;
  warehouseId: number;
  customerPaymentId: number;
  receiptUrl: string;
  subtotal: string;
  taxTotal: string;
  total: string;
}

export class PosValidationError extends Error {
  constructor(
    public httpMessage: string,
    public httpStatus: number = 400,
  ) {
    super(httpMessage);
  }
}

/**
 * One-shot retail checkout. Wraps everything in a single transaction
 * so a stock-out, payment write, or invoice insert that fails leaves
 * the org's books untouched.
 *
 * Stock semantics mirror `routes/shipments.ts` so reports, low-stock
 * alerts and Shopify pushes all see POS sales the same as any other
 * shipment. Differences kept intentional and minimal:
 *   - referenceType on stock_movements is "pos_sale" (vs "shipment")
 *     so finance can split POS revenue from regular fulfillment.
 *   - The created sales order is born `invoiced` (POS == invoice at
 *     point of sale) and is fully allocated to the captured payment.
 */
export async function executePosCheckout(
  organizationId: number,
  input: PosCheckoutInput,
): Promise<PosCheckoutResult> {
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new PosValidationError("At least one line item is required");
  }
  if (input.lines.length > 200) {
    throw new PosValidationError("Too many lines (max 200)");
  }
  const lines: Array<{
    itemId: number;
    quantity: number;
    unitPrice?: number;
    taxRate?: number;
    description?: string | null;
  }> = [];
  for (const l of input.lines) {
    const itemId = Number(l.itemId);
    const quantity = Number(l.quantity);
    if (!Number.isFinite(itemId) || itemId <= 0) {
      throw new PosValidationError("Every line needs a valid itemId");
    }
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) {
      throw new PosValidationError("Every line quantity must be > 0 and <= 1,000,000");
    }
    let unitPrice: number | undefined;
    if (l.unitPrice !== undefined && l.unitPrice !== null) {
      unitPrice = Number(l.unitPrice);
      if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 1e9) {
        throw new PosValidationError("Line unitPrice must be a finite number in [0, 1e9]");
      }
    }
    let taxRate: number | undefined;
    if (l.taxRate !== undefined && l.taxRate !== null) {
      taxRate = Number(l.taxRate);
      if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
        throw new PosValidationError("Line taxRate must be a finite number in [0, 100]");
      }
    }
    lines.push({
      itemId,
      quantity,
      unitPrice,
      taxRate,
      description: l.description ?? null,
    });
  }
  if (
    !input.payment ||
    !POS_PAYMENT_MODES.includes(input.payment.mode) ||
    !Number.isFinite(input.payment.amount) ||
    input.payment.amount <= 0 ||
    input.payment.amount > 1e9
  ) {
    throw new PosValidationError("Valid payment mode + amount in (0, 1e9] required");
  }

  // Resolve customer + warehouse OUTSIDE the transaction (shorter
  // critical section). The walk-in helper is idempotent.
  const isWalkIn = !(input.customerId && input.customerId > 0);
  const customerId = isWalkIn
    ? await getOrCreateWalkInCustomerId(db, organizationId)
    : input.customerId!;

  // Build the order notes string. For walk-in sales we prepend the
  // captured name/phone (if any) so the operator can see who bought
  // what when scanning the sales-orders list later.
  const walkInLabel = (() => {
    if (!isWalkIn) return null;
    const name = (input.customerName ?? "").trim();
    const phone = (input.customerPhone ?? "").trim();
    if (!name && !phone) return null;
    if (name && phone) return `Walk-in: ${name} (${phone})`;
    return `Walk-in: ${name || phone}`;
  })();
  const channelLabel =
    input.saleChannel && POS_SALE_CHANNELS.includes(input.saleChannel)
      ? `Channel: ${SALE_CHANNEL_LABELS[input.saleChannel]}`
      : null;
  const composedNotes = (() => {
    const parts: string[] = [];
    if (channelLabel) parts.push(channelLabel);
    if (walkInLabel) parts.push(walkInLabel);
    if (input.notes) parts.push(input.notes);
    return parts.length > 0 ? parts.join("\n") : null;
  })();
  const warehouseId =
    input.warehouseId && input.warehouseId > 0
      ? input.warehouseId
      : await getDefaultWarehouseId(organizationId);

  // Validate ownership of customer + warehouse + items up front.
  const itemIds = Array.from(new Set(lines.map((l) => l.itemId)));
  const [custCheck, whCheck, itemRows] = await Promise.all([
    db
      .select({ id: customersTable.id })
      .from(customersTable)
      .where(
        and(
          eq(customersTable.id, customerId),
          eq(customersTable.organizationId, organizationId),
        ),
      )
      .limit(1),
    db
      .select({ id: warehousesTable.id })
      .from(warehousesTable)
      .where(
        and(
          eq(warehousesTable.id, warehouseId),
          eq(warehousesTable.organizationId, organizationId),
        ),
      )
      .limit(1),
    db
      .select({
        id: itemsTable.id,
        sku: itemsTable.sku,
        name: itemsTable.name,
        salePrice: itemsTable.salePrice,
        taxRate: itemsTable.taxRate,
        isBundle: itemsTable.isBundle,
        trackBatches: itemsTable.trackBatches,
        parentItemId: itemsTable.parentItemId,
        archivedAt: itemsTable.archivedAt,
      })
      .from(itemsTable)
      .where(
        and(
          eq(itemsTable.organizationId, organizationId),
          inArray(itemsTable.id, itemIds),
        ),
      ),
  ]);
  if (!custCheck[0]) throw new PosValidationError("Invalid customer");
  if (!whCheck[0]) throw new PosValidationError("Invalid warehouse");
  const byId = new Map(itemRows.map((r) => [r.id, r]));
  for (const id of itemIds) {
    const it = byId.get(id);
    if (!it) throw new PosValidationError(`Item ${id} not found`);
    if (it.archivedAt) {
      throw new PosValidationError(`Item ${it.sku} is archived`);
    }
    if (it.parentItemId === null) {
      // root row — only OK if it isn't a parent-with-variants
    }
    if (it.trackBatches) {
      throw new PosValidationError(
        `Item ${it.sku} is batch-tracked. Sell batch-tracked items through Sales Orders instead — POS doesn't capture batch picks.`,
      );
    }
  }

  // Resolve effective line prices/tax from item defaults when caller
  // didn't override.
  const totals = computeOrderTotals(
    lines.map((l) => {
      const it = byId.get(l.itemId)!;
      return {
        itemId: l.itemId,
        quantity: l.quantity,
        unitPrice: l.unitPrice ?? toNum(it.salePrice),
        taxRate: l.taxRate ?? toNum(it.taxRate),
        description: l.description ?? null,
      };
    }),
  );

  // Bundle expansion: load components once.
  const bundleParentIds = itemRows
    .filter((r) => r.isBundle)
    .map((r) => r.id);
  const componentsByParent = new Map<
    number,
    Array<{ componentItemId: number; quantityPerBundle: number }>
  >();
  if (bundleParentIds.length > 0) {
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
    for (const id of bundleParentIds) {
      const arr = componentsByParent.get(id);
      if (!arr || arr.length === 0) {
        const sku = byId.get(id)?.sku ?? `#${id}`;
        throw new PosValidationError(
          `Bundle ${sku} has no components configured`,
        );
      }
    }
    // Reject bundles with batch-tracked components (matches shipments.ts).
    const componentIds = Array.from(
      new Set(
        Array.from(componentsByParent.values()).flatMap((arr) =>
          arr.map((c) => c.componentItemId),
        ),
      ),
    );
    if (componentIds.length > 0) {
      const trackedComps = await db
        .select({ id: itemsTable.id, sku: itemsTable.sku })
        .from(itemsTable)
        .where(
          and(
            eq(itemsTable.organizationId, organizationId),
            inArray(itemsTable.id, componentIds),
            eq(itemsTable.trackBatches, true),
          ),
        );
      if (trackedComps.length > 0) {
        throw new PosValidationError(
          `Bundle includes batch-tracked components (${trackedComps
            .map((c) => c.sku)
            .join(", ")}); sell those through Sales Orders.`,
        );
      }
    }
  }

  // Aggregate the actual stock decrement per (componentItemId) so we
  // can pre-check on-hand and emit one movement per item.
  const componentDelta = new Map<number, number>();
  for (const l of lines) {
    const it = byId.get(l.itemId)!;
    if (it.isBundle) {
      for (const c of componentsByParent.get(l.itemId)!) {
        componentDelta.set(
          c.componentItemId,
          (componentDelta.get(c.componentItemId) ?? 0) +
            l.quantity * c.quantityPerBundle,
        );
      }
    } else {
      componentDelta.set(
        l.itemId,
        (componentDelta.get(l.itemId) ?? 0) + l.quantity,
      );
    }
  }

  return await db.transaction(async (tx) => {
    // Pre-check on-hand for every component. We do this BEFORE the
    // sales-order insert so a stock shortage returns 409 without
    // leaving an empty order behind.
    const componentItemIds = Array.from(componentDelta.keys());
    if (componentItemIds.length > 0) {
      const stockRows = await tx
        .select({
          itemId: itemWarehouseStockTable.itemId,
          quantity: itemWarehouseStockTable.quantity,
        })
        .from(itemWarehouseStockTable)
        .where(
          and(
            eq(itemWarehouseStockTable.organizationId, organizationId),
            eq(itemWarehouseStockTable.warehouseId, warehouseId),
            inArray(itemWarehouseStockTable.itemId, componentItemIds),
          ),
        )
        .for("update");
      const onHand = new Map<number, number>();
      for (const s of stockRows) onHand.set(s.itemId, toNum(s.quantity));
      for (const [itemId, need] of componentDelta) {
        const have = onHand.get(itemId) ?? 0;
        if (need - have > 1e-6) {
          // Look up sku for a friendlier message.
          const skuRow = await tx
            .select({ sku: itemsTable.sku })
            .from(itemsTable)
            .where(
              and(
                eq(itemsTable.id, itemId),
                eq(itemsTable.organizationId, organizationId),
              ),
            )
            .limit(1);
          const sku = skuRow[0]?.sku ?? `#${itemId}`;
          throw new PosValidationError(
            `Insufficient stock for ${sku}: need ${need}, on hand ${have}`,
            409,
          );
        }
      }
    }

    // Insert the sales order in `invoiced` status — POS sales are
    // born final. amountPaid + balanceDue are updated below after we
    // know how much of the captured payment to allocate.
    const orderNumber = nextOrderNumber("POS");
    const today = new Date().toISOString().slice(0, 10);
    const allocAmount = Math.min(input.payment.amount, toNum(totals.total));
    const inserted = await tx
      .insert(salesOrdersTable)
      .values({
        organizationId,
        orderNumber,
        customerId,
        warehouseId,
        status: "invoiced",
        orderDate: today,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        amountPaid: toStr(allocAmount),
        balanceDue: toStr(toNum(totals.total) - allocAmount),
        notes: composedNotes,
        stockAppliedAt: new Date(),
      })
      .returning();
    const order = inserted[0]!;

    if (totals.lines.length > 0) {
      const lineRows = await tx
        .insert(salesOrderLinesTable)
        .values(
          totals.lines.map((l) => ({
            salesOrderId: order.id,
            itemId: l.itemId,
            description: l.description,
            quantity: l.quantity,
            // POS == fully shipped at the point of sale.
            quantityShipped: l.quantity,
            unitPrice: l.unitPrice,
            taxRate: l.taxRate,
            lineSubtotal: l.lineSubtotal,
            lineTax: l.lineTax,
            lineTotal: l.lineTotal,
          })),
        )
        .returning({ id: salesOrderLinesTable.id, itemId: salesOrderLinesTable.itemId });

      // Insert a shipment so downstream systems (reporting, Shopify
      // outbound) treat this as a fulfilled order.
      const shipInserted = await tx
        .insert(shipmentsTable)
        .values({
          organizationId,
          salesOrderId: order.id,
          shipmentNumber: nextOrderNumber("POS-SHIP"),
          shipDate: today,
          status: "shipped",
          notes: `POS sale ${orderNumber}`,
        })
        .returning();
      const shipment = shipInserted[0]!;
      await tx.insert(shipmentLinesTable).values(
        lineRows.map((lr, i) => ({
          organizationId,
          shipmentId: shipment.id,
          salesOrderLineId: lr.id,
          quantity: totals.lines[i]!.quantity,
        })),
      );

      // Apply stock decrements + movement ledger rows. We've already
      // verified on-hand under FOR UPDATE locks above, so the UPDATE
      // here cannot drive on-hand negative.
      for (const [itemId, qty] of componentDelta) {
        await tx
          .update(itemWarehouseStockTable)
          .set({
            quantity: sql`${itemWarehouseStockTable.quantity} - ${toStr(qty)}::numeric`,
          })
          .where(
            and(
              eq(itemWarehouseStockTable.organizationId, organizationId),
              eq(itemWarehouseStockTable.itemId, itemId),
              eq(itemWarehouseStockTable.warehouseId, warehouseId),
            ),
          );
        await tx.insert(stockMovementsTable).values({
          organizationId,
          itemId,
          warehouseId,
          movementType: "sale",
          quantity: toStr(-qty),
          referenceType: "pos_sale",
          referenceId: order.id,
          notes: `POS sale ${orderNumber}`,
        });
      }
    }

    // Capture the payment + allocation. We allocate min(captured,
    // total); any tendered overpay is recorded as an unallocated
    // advance against the customer (leaves outstandingBalance
    // negative for that customer, which is the right shape for
    // change due).
    const paymentRows = await tx
      .insert(customerPaymentsTable)
      .values({
        organizationId,
        customerId,
        paymentDate: today,
        amount: toStr(input.payment.amount),
        mode: input.payment.mode,
        referenceNumber: input.payment.referenceNumber ?? null,
        bankAccountLabel: input.payment.bankAccountLabel ?? null,
        notes:
          input.payment.notes ??
          (channelLabel
            ? `POS sale ${orderNumber} · ${channelLabel}`
            : `POS sale ${orderNumber}`),
      })
      .returning({ id: customerPaymentsTable.id });
    const customerPaymentId = paymentRows[0]!.id;

    if (allocAmount > 0) {
      await tx.insert(customerPaymentAllocationsTable).values({
        organizationId,
        paymentId: customerPaymentId,
        salesOrderId: order.id,
        amount: toStr(allocAmount),
      });
    }
    // NOTE: ::numeric cast on the parameter is required — without it,
    // Postgres treats the bound value as text and throws
    // `operator does not exist: numeric - text`, rolling back the
    // entire checkout transaction. (This was the silent saving bug.)
    await tx
      .update(customersTable)
      .set({
        outstandingBalance: sql`${customersTable.outstandingBalance} - ${toStr(input.payment.amount)}::numeric`,
      })
      .where(
        and(
          eq(customersTable.id, customerId),
          eq(customersTable.organizationId, organizationId),
        ),
      );

    return {
      salesOrderId: order.id,
      orderNumber,
      customerId,
      warehouseId,
      customerPaymentId,
      receiptUrl: `/api/customer-payments/${customerPaymentId}/receipt.pdf`,
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      total: totals.total,
    };
  });
}
