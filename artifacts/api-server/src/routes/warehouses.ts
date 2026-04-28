import { Router, type IRouter } from "express";
import { and, eq, asc, ne } from "drizzle-orm";
import { db, warehousesTable, organizationsTable, itemsTable } from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import { serializeWarehouse } from "../lib/serializers";
import { fetchAllShopifyLocations, findMissingShopifyScopes } from "../lib/shopify";
import { pushStockToShopify } from "../lib/shopifyOutbound";

const router: IRouter = Router();
router.use(tenantMiddleware);

router.get("/warehouses", async (req, res, next) => {
  try {
    const t = req.tenant!;
    // Virtual warehouses (job-worker premises) are hidden from the
    // standard list since they shouldn't appear in inventory pickers
    // (e.g. sales orders, transfers, GRNs). Callers that need to
    // operate on them — the job-work UI, reports — opt in with
    // `?includeVirtual=true`.
    const includeVirtual = req.query.includeVirtual === "true";
    const conds = [eq(warehousesTable.organizationId, t.organizationId)];
    if (!includeVirtual) {
      conds.push(eq(warehousesTable.isVirtual, false));
    }
    const rows = await db
      .select()
      .from(warehousesTable)
      .where(and(...conds))
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

    // Shopify location mapping. Accept either both fields or just id.
    // Setting id=null also clears the cached name. When mapping to a new
    // location, validate the id is one Shopify actually returns for this
    // shop, and ensure another warehouse in the same org isn't already
    // bound to it (DB unique index would catch it, but a clean 400 is
    // friendlier than a 500).
    let mappingChanged = false;
    if ("shopifyLocationId" in b) {
      mappingChanged = true;
      const newId = b.shopifyLocationId;
      if (newId === null || newId === "") {
        updates.shopifyLocationId = null;
        updates.shopifyLocationName = null;
      } else if (typeof newId === "string") {
        const orgRows = await db
          .select({
            shopDomain: organizationsTable.shopifyShopDomain,
            accessToken: organizationsTable.shopifyAccessToken,
            scopes: organizationsTable.shopifyScopes,
          })
          .from(organizationsTable)
          .where(eq(organizationsTable.id, t.organizationId))
          .limit(1);
        const org = orgRows[0];
        if (!org?.shopDomain || !org?.accessToken) {
          res.status(400).json({ error: "Shopify is not connected" });
          return;
        }
        const missingScopes = findMissingShopifyScopes(org.scopes);
        if (missingScopes.length > 0) {
          res.status(409).json({
            error: "shopify_reinstall_required",
            message:
              "Your Shopify connection is missing required permissions. Please reconnect to grant updated access.",
            missingScopes,
          });
          return;
        }
        const locations = await fetchAllShopifyLocations(
          org.shopDomain,
          org.accessToken,
        );
        const match = locations.find((l) => l.id === newId);
        if (!match) {
          res.status(400).json({ error: "Unknown Shopify location id" });
          return;
        }
        const conflict = await db
          .select({ id: warehousesTable.id })
          .from(warehousesTable)
          .where(
            and(
              eq(warehousesTable.organizationId, t.organizationId),
              eq(warehousesTable.shopifyLocationId, newId),
              ne(warehousesTable.id, id),
            ),
          )
          .limit(1);
        if (conflict[0]) {
          res.status(400).json({
            error: "Another warehouse is already mapped to that Shopify location",
          });
          return;
        }
        updates.shopifyLocationId = newId;
        updates.shopifyLocationName = match.name;
      } else {
        res.status(400).json({ error: "shopifyLocationId must be a string or null" });
        return;
      }
    }

    if (b.isDefault === true) {
      await db
        .update(warehousesTable)
        .set({ isDefault: false })
        .where(eq(warehousesTable.organizationId, t.organizationId));
    }
    let updated;
    try {
      updated = await db
        .update(warehousesTable)
        .set(updates)
        .where(
          and(
            eq(warehousesTable.id, id),
            eq(warehousesTable.organizationId, t.organizationId),
          ),
        )
        .returning();
    } catch (err: unknown) {
      // Postgres unique_violation (23505) on warehouses_org_shopify_location_idx:
      // a concurrent request claimed this Shopify location first. Translate
      // to a deterministic 400 instead of leaking a 500.
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? (err as { code?: unknown }).code
          : undefined;
      if (code === "23505") {
        res.status(400).json({
          error: "Another warehouse is already mapped to that Shopify location",
        });
        return;
      }
      throw err;
    }
    if (!updated[0]) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // When the mapping changes we should re-push every item's stock so
    // Shopify's view of this warehouse's location matches ours. Best-effort:
    // fan out fire-and-forget pushes; the per-(orgId,itemId) collapsing
    // logic in shopifyOutbound debounces them naturally.
    if (mappingChanged) {
      try {
        const items = await db
          .select({ id: itemsTable.id })
          .from(itemsTable)
          .where(eq(itemsTable.organizationId, t.organizationId));
        for (const it of items) pushStockToShopify(t.organizationId, it.id);
      } catch {
        // non-fatal
      }
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
