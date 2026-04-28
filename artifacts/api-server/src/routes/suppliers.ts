import { Router, type IRouter } from "express";
import { and, eq, ilike, or, asc } from "drizzle-orm";
import { db, suppliersTable } from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import { serializeSupplier } from "../lib/serializers";

const router: IRouter = Router();
router.use(tenantMiddleware);

router.get("/suppliers", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const conds = [eq(suppliersTable.organizationId, t.organizationId)];
    if (search) {
      conds.push(
        or(
          ilike(suppliersTable.name, `%${search}%`),
          ilike(suppliersTable.email, `%${search}%`),
          ilike(suppliersTable.company, `%${search}%`),
        )!,
      );
    }
    const rows = await db
      .select()
      .from(suppliersTable)
      .where(and(...conds))
      .orderBy(asc(suppliersTable.name));
    res.json(rows.map(serializeSupplier));
  } catch (err) {
    next(err);
  }
});

router.post("/suppliers", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const b = req.body ?? {};
    if (!b.name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const inserted = await db
      .insert(suppliersTable)
      .values({
        organizationId: t.organizationId,
        name: b.name,
        email: b.email ?? null,
        phone: b.phone ?? null,
        company: b.company ?? null,
        gstNumber: b.gstNumber ?? null,
        address: b.address ?? null,
        notes: b.notes ?? null,
        isJobWorker: b.isJobWorker === true,
      })
      .returning();
    res.status(201).json(serializeSupplier(inserted[0]!));
  } catch (err) {
    next(err);
  }
});

router.get("/suppliers/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const rows = await db
      .select()
      .from(suppliersTable)
      .where(
        and(eq(suppliersTable.id, id), eq(suppliersTable.organizationId, t.organizationId)),
      )
      .limit(1);
    if (!rows[0]) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(serializeSupplier(rows[0]));
  } catch (err) {
    next(err);
  }
});

router.patch("/suppliers/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const updates: Record<string, unknown> = {};
    for (const k of ["name", "email", "phone", "company", "gstNumber", "address", "notes"]) {
      if (k in b) updates[k] = b[k];
    }
    if ("isJobWorker" in b) updates.isJobWorker = b.isJobWorker === true;
    const updated = await db
      .update(suppliersTable)
      .set(updates)
      .where(
        and(eq(suppliersTable.id, id), eq(suppliersTable.organizationId, t.organizationId)),
      )
      .returning();
    if (!updated[0]) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(serializeSupplier(updated[0]));
  } catch (err) {
    next(err);
  }
});

router.delete("/suppliers/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    await db
      .delete(suppliersTable)
      .where(
        and(eq(suppliersTable.id, id), eq(suppliersTable.organizationId, t.organizationId)),
      );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
