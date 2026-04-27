import { Router, type IRouter } from "express";
import { and, eq, ilike, or, asc } from "drizzle-orm";
import { db, customersTable } from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import { serializeCustomer } from "../lib/serializers";

const router: IRouter = Router();
router.use(tenantMiddleware);

router.get("/customers", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const conds = [eq(customersTable.organizationId, t.organizationId)];
    if (search) {
      conds.push(
        or(
          ilike(customersTable.name, `%${search}%`),
          ilike(customersTable.email, `%${search}%`),
          ilike(customersTable.company, `%${search}%`),
        )!,
      );
    }
    const rows = await db
      .select()
      .from(customersTable)
      .where(and(...conds))
      .orderBy(asc(customersTable.name));
    res.json(rows.map(serializeCustomer));
  } catch (err) {
    next(err);
  }
});

router.post("/customers", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const b = req.body ?? {};
    if (!b.name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const inserted = await db
      .insert(customersTable)
      .values({
        organizationId: t.organizationId,
        name: b.name,
        email: b.email ?? null,
        phone: b.phone ?? null,
        company: b.company ?? null,
        gstNumber: b.gstNumber ?? null,
        billingAddress: b.billingAddress ?? null,
        shippingAddress: b.shippingAddress ?? null,
        placeOfSupply: b.placeOfSupply ?? null,
        notes: b.notes ?? null,
      })
      .returning();
    res.status(201).json(serializeCustomer(inserted[0]!));
  } catch (err) {
    next(err);
  }
});

router.get("/customers/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const rows = await db
      .select()
      .from(customersTable)
      .where(
        and(eq(customersTable.id, id), eq(customersTable.organizationId, t.organizationId)),
      )
      .limit(1);
    if (!rows[0]) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(serializeCustomer(rows[0]));
  } catch (err) {
    next(err);
  }
});

router.patch("/customers/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const updates: Record<string, unknown> = {};
    for (const k of [
      "name",
      "email",
      "phone",
      "company",
      "gstNumber",
      "billingAddress",
      "shippingAddress",
      "placeOfSupply",
      "notes",
    ]) {
      if (k in b) updates[k] = b[k];
    }
    const updated = await db
      .update(customersTable)
      .set(updates)
      .where(
        and(eq(customersTable.id, id), eq(customersTable.organizationId, t.organizationId)),
      )
      .returning();
    if (!updated[0]) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(serializeCustomer(updated[0]));
  } catch (err) {
    next(err);
  }
});

router.delete("/customers/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    await db
      .delete(customersTable)
      .where(
        and(eq(customersTable.id, id), eq(customersTable.organizationId, t.organizationId)),
      );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
