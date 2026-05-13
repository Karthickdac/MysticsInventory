import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import {
  db,
  stockMovementsTable,
  itemsTable,
  warehousesTable,
  goodsReceiptsTable,
  shipmentsTable,
} from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import { serializeStockMovement } from "../lib/serializers";

const router: IRouter = Router();
router.use(tenantMiddleware);

router.get("/stock-movements", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const conds = [eq(stockMovementsTable.organizationId, t.organizationId)];
    if (req.query.itemId) {
      conds.push(eq(stockMovementsTable.itemId, Number(req.query.itemId)));
    }
    if (req.query.warehouseId) {
      conds.push(eq(stockMovementsTable.warehouseId, Number(req.query.warehouseId)));
    }
    if (req.query.referenceType) {
      conds.push(eq(stockMovementsTable.referenceType, String(req.query.referenceType)));
    }
    if (req.query.referenceId) {
      conds.push(eq(stockMovementsTable.referenceId, Number(req.query.referenceId)));
    }
    if (req.query.purchaseOrderId) {
      const poId = Number(req.query.purchaseOrderId);
      const receiptIds = await db
        .select({ id: goodsReceiptsTable.id })
        .from(goodsReceiptsTable)
        .where(
          and(
            eq(goodsReceiptsTable.organizationId, t.organizationId),
            eq(goodsReceiptsTable.purchaseOrderId, poId),
          ),
        );
      const ids = receiptIds.map((r) => r.id);
      const goodsReceiptCond =
        ids.length > 0
          ? and(
              eq(stockMovementsTable.referenceType, "goods_receipt"),
              inArray(stockMovementsTable.referenceId, ids),
            )
          : undefined;
      const purchaseOrderCond = and(
        eq(stockMovementsTable.referenceType, "purchase_order"),
        eq(stockMovementsTable.referenceId, poId),
      );
      conds.push(
        goodsReceiptCond
          ? or(purchaseOrderCond, goodsReceiptCond)!
          : purchaseOrderCond!,
      );
    }
    if (req.query.salesOrderId) {
      const soId = Number(req.query.salesOrderId);
      const shipmentIds = await db
        .select({ id: shipmentsTable.id })
        .from(shipmentsTable)
        .where(
          and(
            eq(shipmentsTable.organizationId, t.organizationId),
            eq(shipmentsTable.salesOrderId, soId),
          ),
        );
      const ids = shipmentIds.map((r) => r.id);
      const shipmentCond =
        ids.length > 0
          ? and(
              eq(stockMovementsTable.referenceType, "shipment"),
              inArray(stockMovementsTable.referenceId, ids),
            )
          : undefined;
      const salesOrderCond = and(
        eq(stockMovementsTable.referenceType, "sales_order"),
        eq(stockMovementsTable.referenceId, soId),
      );
      conds.push(
        shipmentCond
          ? or(salesOrderCond, shipmentCond)!
          : salesOrderCond!,
      );
    }
    const rows = await db
      .select({
        movement: stockMovementsTable,
        itemName: itemsTable.name,
        itemSku: itemsTable.sku,
        itemBarcode: itemsTable.barcode,
        itemCategory: itemsTable.category,
        warehouseName: warehousesTable.name,
      })
      .from(stockMovementsTable)
      .innerJoin(itemsTable, eq(itemsTable.id, stockMovementsTable.itemId))
      .innerJoin(
        warehousesTable,
        eq(warehousesTable.id, stockMovementsTable.warehouseId),
      )
      .where(and(...conds))
      .orderBy(desc(stockMovementsTable.createdAt))
      .limit(500);
    res.json(
      rows.map((r) =>
        serializeStockMovement(
          r.movement,
          r.itemName,
          r.warehouseName,
          r.itemSku,
          r.itemBarcode,
          r.itemCategory,
        ),
      ),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
