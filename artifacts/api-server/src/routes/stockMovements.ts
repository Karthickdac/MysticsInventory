import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  stockMovementsTable,
  itemsTable,
  warehousesTable,
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
    const rows = await db
      .select({
        movement: stockMovementsTable,
        itemName: itemsTable.name,
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
        serializeStockMovement(r.movement, r.itemName, r.warehouseName),
      ),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
