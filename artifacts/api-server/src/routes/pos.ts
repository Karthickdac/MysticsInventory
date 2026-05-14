import { Router, type IRouter } from "express";
import { and, eq, ilike, or, sql, asc } from "drizzle-orm";
import {
  db,
  itemsTable,
  itemWarehouseStockTable,
  warehousesTable,
} from "@workspace/db";
import { tenantMiddleware, getDefaultWarehouseId } from "../lib/tenant";
import { toNum } from "../lib/numeric";
import {
  executePosCheckout,
  PosValidationError,
  POS_PAYMENT_MODES,
  POS_SALE_CHANNELS,
  type PosCheckoutInput,
  type PosSaleChannel,
} from "../lib/posCheckout";

const router: IRouter = Router();
router.use(tenantMiddleware);

router.get("/pos/items/lookup", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      res.status(400).json({ error: "Query parameter q is required" });
      return;
    }
    const limit = Math.min(
      Math.max(Number(req.query.limit) || 20, 1),
      50,
    );
    let warehouseId: number;
    if (Number(req.query.warehouseId) > 0) {
      warehouseId = Number(req.query.warehouseId);
      // Validate ownership — never let the cashier silently get a
      // zeroed-out result from a warehouseId that belongs to another
      // org or doesn't exist.
      const owned = await db
        .select({ id: warehousesTable.id })
        .from(warehousesTable)
        .where(
          and(
            eq(warehousesTable.id, warehouseId),
            eq(warehousesTable.organizationId, t.organizationId),
          ),
        )
        .limit(1);
      if (!owned[0]) {
        res.status(404).json({ error: "Warehouse not found" });
        return;
      }
    } else {
      warehouseId = await getDefaultWarehouseId(t.organizationId);
    }

    // Match priority: exact barcode > exact SKU > prefix on
    // sku/name. The exact-match branch lets a barcode scan resolve
    // in one query without opening the search dropdown.
    const exactRows = await db
      .select({
        id: itemsTable.id,
        sku: itemsTable.sku,
        name: itemsTable.name,
        barcode: itemsTable.barcode,
        salePrice: itemsTable.salePrice,
        taxRate: itemsTable.taxRate,
        isBundle: itemsTable.isBundle,
        trackBatches: itemsTable.trackBatches,
        unit: itemsTable.unit,
        imageUrl: itemsTable.imageUrl,
      })
      .from(itemsTable)
      .where(
        and(
          eq(itemsTable.organizationId, t.organizationId),
          sql`${itemsTable.archivedAt} IS NULL`,
          eq(itemsTable.hasVariants, false),
          or(eq(itemsTable.barcode, q), eq(itemsTable.sku, q)),
        ),
      )
      .limit(limit);

    let rows = exactRows;
    if (rows.length === 0) {
      const like = `${q}%`;
      rows = await db
        .select({
          id: itemsTable.id,
          sku: itemsTable.sku,
          name: itemsTable.name,
          barcode: itemsTable.barcode,
          salePrice: itemsTable.salePrice,
          taxRate: itemsTable.taxRate,
          isBundle: itemsTable.isBundle,
          trackBatches: itemsTable.trackBatches,
          unit: itemsTable.unit,
          imageUrl: itemsTable.imageUrl,
        })
        .from(itemsTable)
        .where(
          and(
            eq(itemsTable.organizationId, t.organizationId),
            sql`${itemsTable.archivedAt} IS NULL`,
            eq(itemsTable.hasVariants, false),
            or(
              ilike(itemsTable.sku, like),
              ilike(itemsTable.name, `%${q}%`),
            ),
          ),
        )
        .orderBy(asc(itemsTable.name))
        .limit(limit);
    }

    // Tack on on-hand for the chosen warehouse so the cashier sees
    // stock at a glance.
    const ids = rows.map((r) => r.id);
    const stockMap = new Map<number, number>();
    if (ids.length > 0) {
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
              ids.map((i) => sql`${i}`),
              sql`, `,
            )})`,
          ),
        );
      for (const s of stockRows) stockMap.set(s.itemId, toNum(s.quantity));
    }

    res.json({
      warehouseId,
      items: rows.map((r) => ({
        id: r.id,
        sku: r.sku,
        name: r.name,
        barcode: r.barcode,
        salePrice: r.salePrice,
        taxRate: r.taxRate,
        unit: r.unit,
        imageUrl: r.imageUrl,
        isBundle: r.isBundle,
        trackBatches: r.trackBatches,
        onHand: stockMap.get(r.id) ?? 0,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/pos/checkout", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const b = req.body ?? {};
    const customerName =
      typeof b.customerName === "string" ? b.customerName.trim() : "";
    const customerPhone =
      typeof b.customerPhone === "string" ? b.customerPhone.trim() : "";
    if (!customerName) {
      res.status(400).json({ error: "Customer name is required" });
      return;
    }
    if (!customerPhone) {
      res.status(400).json({ error: "Phone is required" });
      return;
    }
    const input: PosCheckoutInput = {
      lines: Array.isArray(b.lines) ? b.lines : [],
      customerId: b.customerId ? Number(b.customerId) : null,
      warehouseId: b.warehouseId ? Number(b.warehouseId) : null,
      payment: {
        mode: b.payment?.mode,
        amount: Number(b.payment?.amount),
        referenceNumber: b.payment?.referenceNumber ?? null,
        bankAccountLabel: b.payment?.bankAccountLabel ?? null,
        notes: b.payment?.notes ?? null,
      },
      notes: b.notes ?? null,
      customerName: customerName.slice(0, 200),
      customerPhone: customerPhone.slice(0, 50),
      saleChannel:
        typeof b.saleChannel === "string" &&
        (POS_SALE_CHANNELS as readonly string[]).includes(b.saleChannel)
          ? (b.saleChannel as PosSaleChannel)
          : null,
    };
    try {
      const out = await executePosCheckout(t.organizationId, input);
      res.status(201).json(out);
    } catch (err) {
      if (err instanceof PosValidationError) {
        res.status(err.httpStatus).json({ error: err.httpMessage });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

export const POS_PAYMENT_MODES_EXPORT = POS_PAYMENT_MODES;
export default router;
