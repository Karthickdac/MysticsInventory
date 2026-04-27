import { Router, type IRouter } from "express";
import { and, eq, asc } from "drizzle-orm";
import { db, warehousesTable } from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import { serializeWarehouse } from "../lib/serializers";

const router: IRouter = Router();
router.use(tenantMiddleware);

router.get("/warehouses", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const rows = await db
      .select()
      .from(warehousesTable)
      .where(eq(warehousesTable.organizationId, t.organizationId))
      .orderBy(asc(warehousesTable.name));
    res.json(rows.map(serializeWarehouse));
  } catch (err) {
    next(err);
  }
});

router.post("/warehouses", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const b = req.body ?? {};
    if (!b.name || !b.code) {
      res.status(400).json({ error: "name and code are required" });
      return;
    }
    if (b.isDefault) {
      await db
        .update(warehousesTable)
        .set({ isDefault: false })
        .where(eq(warehousesTable.organizationId, t.organizationId));
    }
    const inserted = await db
      .insert(warehousesTable)
      .values({
        organizationId: t.organizationId,
        name: b.name,
        code: b.code,
        addressLine1: b.addressLine1 ?? null,
        city: b.city ?? null,
        state: b.state ?? null,
        country: b.country ?? null,
        isDefault: !!b.isDefault,
      })
      .returning();
    res.status(201).json(serializeWarehouse(inserted[0]!));
  } catch (err) {
    next(err);
  }
});

router.get("/warehouses/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const rows = await db
      .select()
      .from(warehousesTable)
      .where(
        and(
          eq(warehousesTable.id, id),
          eq(warehousesTable.organizationId, t.organizationId),
        ),
      )
      .limit(1);
    if (!rows[0]) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(serializeWarehouse(rows[0]));
  } catch (err) {
    next(err);
  }
});

router.patch("/warehouses/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const updates: Record<string, unknown> = {};
    for (const k of ["name", "code", "addressLine1", "city", "state", "country", "isDefault"]) {
      if (k in b) updates[k] = b[k];
    }
    if (b.isDefault === true) {
      await db
        .update(warehousesTable)
        .set({ isDefault: false })
        .where(eq(warehousesTable.organizationId, t.organizationId));
    }
    const updated = await db
      .update(warehousesTable)
      .set(updates)
      .where(
        and(
          eq(warehousesTable.id, id),
          eq(warehousesTable.organizationId, t.organizationId),
        ),
      )
      .returning();
    if (!updated[0]) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(serializeWarehouse(updated[0]));
  } catch (err) {
    next(err);
  }
});

router.delete("/warehouses/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    await db
      .delete(warehousesTable)
      .where(
        and(
          eq(warehousesTable.id, id),
          eq(warehousesTable.organizationId, t.organizationId),
        ),
      );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
