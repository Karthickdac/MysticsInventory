import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  organizationsTable,
  organizationMembersTable,
  shipmentsTable,
  shipmentLinesTable,
  salesOrdersTable,
  salesOrderLinesTable,
  customersTable,
  itemsTable,
} from "@workspace/db";
import { syncShiprocketTrackingForOrg } from "../lib/shiprocketSync";
import { tenantMiddleware } from "../lib/tenant";
import { serializeShipment, serializeShipmentLine } from "../lib/serializers";
import { toNum } from "../lib/numeric";
import { encryptString } from "../lib/encryption";
import {
  shiprocketLogin,
  createShiprocketOrder,
  assignShiprocketAwb,
  generateShiprocketLabel,
  listShiprocketCouriers,
  buildShiprocketTrackingUrl,
  ShiprocketAuthError,
  ShiprocketApiError,
  ShiprocketNotConnectedError,
  ShiprocketTokenExpiredError,
} from "../lib/shiprocket";
import { logger } from "../lib/logger";

const router: IRouter = Router();
router.use(tenantMiddleware);

// Translate the various Shiprocket-domain errors into HTTP responses.
// Returns true if a response was sent.
function handleShiprocketError(
  err: unknown,
  res: Response,
  ctx: { orgId: number; shipmentId?: number; op: string },
): boolean {
  if (err instanceof ShiprocketNotConnectedError) {
    res.status(400).json({ error: "Shiprocket is not connected" });
    return true;
  }
  if (err instanceof ShiprocketTokenExpiredError) {
    res.status(401).json({
      error:
        "Shiprocket session has expired. An admin needs to reconnect the integration.",
      code: "shiprocket_token_expired",
    });
    return true;
  }
  if (err instanceof ShiprocketApiError) {
    logger.warn(
      { ...ctx, status: err.status, body: err.body },
      `shiprocket: ${ctx.op} failed`,
    );
    res.status(502).json({ error: err.message });
    return true;
  }
  return false;
}

// Only owners and admins may manage the Shiprocket connection or trigger
// a manual tracking sync — these are integration control-plane actions.
async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const t = req.tenant;
  if (!t) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const rows = await db
    .select({ role: organizationMembersTable.role })
    .from(organizationMembersTable)
    .where(
      and(
        eq(organizationMembersTable.organizationId, t.organizationId),
        eq(organizationMembersTable.userId, t.userId),
      ),
    )
    .limit(1);
  const role = rows[0]?.role;
  if (role !== "owner" && role !== "admin") {
    res
      .status(403)
      .json({ error: "Only owners or admins can manage this integration" });
    return;
  }
  next();
}

// ──────────────────────────────────────────────────────────────────────
// Connection management
// ──────────────────────────────────────────────────────────────────────

router.get("/shiprocket/connection", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const rows = await db
      .select({
        email: organizationsTable.shiprocketEmail,
        tokenEncrypted: organizationsTable.shiprocketTokenEncrypted,
        tokenExpiresAt: organizationsTable.shiprocketTokenExpiresAt,
        lastSyncedAt: organizationsTable.shiprocketLastSyncedAt,
        pickupPincode: organizationsTable.shiprocketPickupPincode,
      })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, t.organizationId))
      .limit(1);
    const o = rows[0]!;
    // The integration is "connected" only while the cached token is
    // still valid. Shiprocket has no refresh-token API and we
    // deliberately do not store the password, so once the token
    // expires the admin must reconnect through the UI.
    const connected =
      !!o.tokenEncrypted &&
      !!o.tokenExpiresAt &&
      o.tokenExpiresAt.getTime() > Date.now();
    res.json({
      connected,
      email: o.email,
      tokenExpiresAt: o.tokenExpiresAt ? o.tokenExpiresAt.toISOString() : null,
      lastSyncedAt: o.lastSyncedAt ? o.lastSyncedAt.toISOString() : null,
      pickupPincode: o.pickupPincode,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/shiprocket/connection", requireAdmin, async (req, res, next) => {
  try {
    const t = req.tenant!;
    const b = req.body ?? {};
    const email =
      typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
    const password = typeof b.password === "string" ? b.password : "";
    const pickupPincode =
      typeof b.pickupPincode === "string" ? b.pickupPincode.trim() : "";
    if (!email || !password) {
      res.status(400).json({ error: "email and password are required" });
      return;
    }
    if (pickupPincode && !/^[0-9]{6}$/u.test(pickupPincode)) {
      res
        .status(400)
        .json({ error: "pickupPincode must be a 6-digit number" });
      return;
    }
    let minted: { token: string; expiresAt: Date };
    try {
      minted = await shiprocketLogin(email, password);
    } catch (err) {
      if (err instanceof ShiprocketAuthError) {
        res.status(401).json({ error: err.message });
        return;
      }
      throw err;
    }
    // Persist ONLY the encrypted token + email + (optional) pickup
    // pincode. The raw password is used exactly once, here, to mint
    // the initial token and is then dropped — it never touches the
    // database. Token TTL is ~10 days; once it expires the admin
    // reconnects through the UI to mint a fresh one.
    const tokenEncrypted = encryptString(minted.token);
    // Always overwrite shiprocketPickupPincode (use null when blank)
    // so that reconnecting with an empty value clears any stale
    // pincode left over from a previous connection.
    await db
      .update(organizationsTable)
      .set({
        shiprocketEmail: email,
        shiprocketTokenEncrypted: tokenEncrypted,
        shiprocketTokenExpiresAt: minted.expiresAt,
        shiprocketPickupPincode: pickupPincode || null,
      })
      .where(eq(organizationsTable.id, t.organizationId));
    res.json({
      connected: true,
      email,
      tokenExpiresAt: minted.expiresAt.toISOString(),
      lastSyncedAt: null,
      pickupPincode: pickupPincode || null,
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/shiprocket/connection", requireAdmin, async (req, res, next) => {
  try {
    const t = req.tenant!;
    // Full integration reset: drop the email, cached token, sync
    // metadata and the saved pickup pincode. The next reconnect
    // re-sets all of these.
    await db
      .update(organizationsTable)
      .set({
        shiprocketEmail: null,
        shiprocketTokenEncrypted: null,
        shiprocketTokenExpiresAt: null,
        shiprocketLastSyncedAt: null,
        shiprocketPickupPincode: null,
      })
      .where(eq(organizationsTable.id, t.organizationId));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────
// Courier serviceability — list options + rates for a route, so the
// user can pick a courier before booking
// ──────────────────────────────────────────────────────────────────────

router.post(
  "/shipments/:id/shiprocket/couriers",
  async (req, res, next) => {
    try {
      const t = req.tenant!;
      const shipmentId = Number(req.params.id);
      if (!Number.isFinite(shipmentId) || shipmentId <= 0) {
        res.status(400).json({ error: "Invalid shipment id" });
        return;
      }
      // Confirm the shipment belongs to this tenant.
      const owns = await db
        .select({ id: shipmentsTable.id })
        .from(shipmentsTable)
        .where(
          and(
            eq(shipmentsTable.id, shipmentId),
            eq(shipmentsTable.organizationId, t.organizationId),
          ),
        )
        .limit(1);
      if (owns.length === 0) {
        res.status(404).json({ error: "Shipment not found" });
        return;
      }

      const b = (req.body ?? {}) as {
        deliveryPincode?: string;
        weightKg?: number;
        cod?: boolean;
        pickupPincode?: string;
      };
      const deliveryPincode =
        typeof b.deliveryPincode === "string" ? b.deliveryPincode.trim() : "";
      const weightKg = Number(b.weightKg);
      if (!deliveryPincode || !(weightKg > 0)) {
        res
          .status(400)
          .json({ error: "deliveryPincode and weightKg (>0) are required" });
        return;
      }

      // Pickup pincode resolution: explicit body field, then the org's
      // saved Shiprocket pickup pincode, then the org address pincode.
      let pickupPincode =
        typeof b.pickupPincode === "string" ? b.pickupPincode.trim() : "";
      if (!pickupPincode) {
        const orgRows = await db
          .select({
            shiprocketPickupPincode: organizationsTable.shiprocketPickupPincode,
            postalCode: organizationsTable.postalCode,
          })
          .from(organizationsTable)
          .where(eq(organizationsTable.id, t.organizationId))
          .limit(1);
        pickupPincode =
          orgRows[0]?.shiprocketPickupPincode?.trim() ??
          orgRows[0]?.postalCode?.trim() ??
          "";
      }
      if (!pickupPincode) {
        res.status(400).json({
          error:
            "No pickup pincode is configured. Set one on the Shiprocket integration page or pass pickupPincode in the request.",
        });
        return;
      }

      try {
        const couriers = await listShiprocketCouriers(t.organizationId, {
          pickupPincode,
          deliveryPincode,
          weightKg,
          cod: !!b.cod,
        });
        res.json({ couriers, pickupPincode });
      } catch (err) {
        if (handleShiprocketError(err, res, {
          orgId: t.organizationId,
          shipmentId,
          op: "courier serviceability",
        })) return;
        throw err;
      }
    } catch (err) {
      next(err);
    }
  },
);

// ──────────────────────────────────────────────────────────────────────
// Book a shipment with Shiprocket — idempotent
// ──────────────────────────────────────────────────────────────────────

interface BookShipmentBody {
  pickupLocation?: string;
  paymentMethod?: "Prepaid" | "COD";
  weightKg?: number;
  lengthCm?: number;
  breadthCm?: number;
  heightCm?: number;
  customer?: {
    name?: string;
    email?: string | null;
    phone?: string;
    addressLine1?: string;
    addressLine2?: string | null;
    city?: string;
    state?: string;
    pincode?: string;
    country?: string;
  };
  courierId?: number;
}

router.post(
  "/shipments/:id/shiprocket/book",
  async (req, res, next) => {
    try {
      const t = req.tenant!;
      const shipmentId = Number(req.params.id);
      if (!Number.isFinite(shipmentId) || shipmentId <= 0) {
        res.status(400).json({ error: "Invalid shipment id" });
        return;
      }

      // Load shipment + sales order + customer
      const shipRows = await db
        .select({
          shipment: shipmentsTable,
          order: salesOrdersTable,
          customer: customersTable,
        })
        .from(shipmentsTable)
        .innerJoin(
          salesOrdersTable,
          eq(salesOrdersTable.id, shipmentsTable.salesOrderId),
        )
        .innerJoin(
          customersTable,
          eq(customersTable.id, salesOrdersTable.customerId),
        )
        .where(
          and(
            eq(shipmentsTable.id, shipmentId),
            eq(shipmentsTable.organizationId, t.organizationId),
          ),
        )
        .limit(1);
      const row = shipRows[0];
      if (!row) {
        res.status(404).json({ error: "Shipment not found" });
        return;
      }

      // Idempotency: if AWB is already assigned, return current state.
      if (row.shipment.awb) {
        const lines = await loadShipmentLines(t.organizationId, shipmentId);
        res.json({
          shipment: { ...serializeShipment(row.shipment), lines },
          alreadyBooked: true,
        });
        return;
      }

      const b = (req.body ?? {}) as BookShipmentBody;

      // Resume case: a previous attempt created the Shiprocket order/shipment
      // but failed before AWB assignment completed. Skip the create-order
      // step (Shiprocket would otherwise reject as duplicate) and resume
      // directly from AWB assignment using the stored shipment id.
      if (row.shipment.shiprocketShipmentId) {
        await resumeAwbAndLabel(
          t.organizationId,
          shipmentId,
          row.shipment.shiprocketOrderId,
          row.shipment.shiprocketShipmentId,
          b.courierId,
          res,
        );
        return;
      }
      const pickupLocation =
        typeof b.pickupLocation === "string" && b.pickupLocation.trim()
          ? b.pickupLocation.trim()
          : "Primary";
      const paymentMethod: "Prepaid" | "COD" =
        b.paymentMethod === "COD" ? "COD" : "Prepaid";
      const weightKg = Number(b.weightKg);
      const lengthCm = Number(b.lengthCm);
      const breadthCm = Number(b.breadthCm);
      const heightCm = Number(b.heightCm);
      if (
        !(weightKg > 0) ||
        !(lengthCm > 0) ||
        !(breadthCm > 0) ||
        !(heightCm > 0)
      ) {
        res
          .status(400)
          .json({ error: "weightKg, lengthCm, breadthCm and heightCm must all be > 0" });
        return;
      }

      const cust = b.customer ?? {};
      const customer = {
        name: (cust.name ?? row.customer.name ?? "").trim(),
        email: cust.email ?? row.customer.email ?? null,
        phone: (cust.phone ?? row.customer.phone ?? "").trim(),
        addressLine1: (
          cust.addressLine1 ??
          row.customer.shippingAddress ??
          row.customer.billingAddress ??
          ""
        ).trim(),
        addressLine2: cust.addressLine2 ?? null,
        city: (cust.city ?? "").trim(),
        state: (cust.state ?? row.customer.placeOfSupply ?? "").trim(),
        pincode: (cust.pincode ?? "").trim(),
        country: (cust.country ?? "India").trim(),
      };
      if (
        !customer.name ||
        !customer.phone ||
        !customer.addressLine1 ||
        !customer.city ||
        !customer.state ||
        !customer.pincode
      ) {
        res.status(400).json({
          error:
            "Customer name, phone, address, city, state and pincode are all required to book a shipment",
        });
        return;
      }

      // Pull line items for the shipment so Shiprocket gets accurate
      // unit + price info (it uses these for COD reconciliation).
      const itemRows = await db
        .select({
          quantity: shipmentLinesTable.quantity,
          unitPrice: salesOrderLinesTable.unitPrice,
          taxRate: salesOrderLinesTable.taxRate,
          itemName: itemsTable.name,
          itemSku: itemsTable.sku,
          hsnCode: itemsTable.hsnCode,
        })
        .from(shipmentLinesTable)
        .innerJoin(
          salesOrderLinesTable,
          eq(salesOrderLinesTable.id, shipmentLinesTable.salesOrderLineId),
        )
        .innerJoin(itemsTable, eq(itemsTable.id, salesOrderLinesTable.itemId))
        .where(
          and(
            eq(shipmentLinesTable.organizationId, t.organizationId),
            eq(shipmentLinesTable.shipmentId, shipmentId),
          ),
        );
      if (itemRows.length === 0) {
        res
          .status(400)
          .json({ error: "Shipment has no line items to book" });
        return;
      }
      const items = itemRows.map((r) => ({
        name: r.itemName,
        sku: r.itemSku,
        units: toNum(r.quantity),
        sellingPrice: toNum(r.unitPrice),
        hsn: r.hsnCode,
        taxPercent: toNum(r.taxRate),
      }));
      const subTotal = items.reduce(
        (s, it) => s + it.units * it.sellingPrice,
        0,
      );

      // Use shipment number as the Shiprocket order_id (must be unique
      // per Shiprocket account). Suffix with org id to avoid collisions
      // across tenants that share a Shiprocket account in dev/test.
      const externalOrderId = `${t.organizationId}-${row.shipment.shipmentNumber}`;

      let createResult;
      try {
        createResult = await createShiprocketOrder(t.organizationId, {
          orderId: externalOrderId,
          orderDate: row.shipment.shipDate,
          pickupLocation,
          customer,
          items,
          paymentMethod,
          subTotal,
          weightKg,
          lengthCm,
          breadthCm,
          heightCm,
        });
      } catch (err) {
        if (handleShiprocketError(err, res, {
          orgId: t.organizationId,
          shipmentId,
          op: "create-order",
        })) return;
        throw err;
      }

      const shiprocketOrderId = createResult.order_id
        ? String(createResult.order_id)
        : null;
      const shiprocketShipmentId = createResult.shipment_id
        ? String(createResult.shipment_id)
        : null;

      if (!shiprocketShipmentId) {
        // Persist what we got so the user can see Shiprocket's order id
        // even if AWB assignment failed.
        await db
          .update(shipmentsTable)
          .set({
            shiprocketOrderId,
            shiprocketShipmentId,
          })
          .where(
            and(
              eq(shipmentsTable.organizationId, t.organizationId),
              eq(shipmentsTable.id, shipmentId),
            ),
          );
        res.status(502).json({
          error:
            "Shiprocket created the order but did not return a shipment id. Please retry.",
        });
        return;
      }

      // Step 2: assign AWB
      let awbCode: string | null = createResult.awb_code ?? null;
      let courierName: string | null = createResult.courier_name ?? null;
      if (!awbCode) {
        try {
          const awbRes = await assignShiprocketAwb(
            t.organizationId,
            shiprocketShipmentId,
            b.courierId,
          );
          awbCode = awbRes.response?.data?.awb_code ?? null;
          courierName = awbRes.response?.data?.courier_name ?? null;
        } catch (err) {
          // Persist what we have; user can retry once Shiprocket clears.
          await db
            .update(shipmentsTable)
            .set({
              shiprocketOrderId,
              shiprocketShipmentId,
            })
            .where(
              and(
                eq(shipmentsTable.organizationId, t.organizationId),
                eq(shipmentsTable.id, shipmentId),
              ),
            );
          if (handleShiprocketError(err, res, {
            orgId: t.organizationId,
            shipmentId,
            op: "assign-awb",
          })) return;
          throw err;
        }
      }

      // Step 3: generate label (best-effort — failure shouldn't undo
      // the AWB assignment).
      let labelUrl: string | null = null;
      if (awbCode) {
        try {
          const labelRes = await generateShiprocketLabel(
            t.organizationId,
            shiprocketShipmentId,
          );
          labelUrl = labelRes.label_url ?? labelRes.response?.label_url ?? null;
        } catch (err) {
          logger.warn(
            { orgId: t.organizationId, shipmentId, err },
            "shiprocket: label generation failed (non-fatal)",
          );
        }
      }

      const trackingUrl = awbCode ? buildShiprocketTrackingUrl(awbCode) : null;

      await db
        .update(shipmentsTable)
        .set({
          shiprocketOrderId,
          shiprocketShipmentId,
          awb: awbCode,
          courierName,
          labelUrl,
          trackingUrl,
          trackingStatus: awbCode ? "pickup_scheduled" : null,
        })
        .where(
          and(
            eq(shipmentsTable.id, shipmentId),
            eq(shipmentsTable.organizationId, t.organizationId),
          ),
        );

      const updatedRows = await db
        .select()
        .from(shipmentsTable)
        .where(
          and(
            eq(shipmentsTable.id, shipmentId),
            eq(shipmentsTable.organizationId, t.organizationId),
          ),
        )
        .limit(1);
      const lines = await loadShipmentLines(t.organizationId, shipmentId);
      res.json({
        shipment: { ...serializeShipment(updatedRows[0]!), lines },
        alreadyBooked: false,
      });
    } catch (err) {
      next(err);
    }
  },
);

// Shared continuation: assign AWB (if missing) and best-effort label
// generation, persist the result and respond. Used both by the resume
// branch (when create-order succeeded on a prior attempt) and is the
// pattern the main book flow follows post-create-order.
async function resumeAwbAndLabel(
  organizationId: number,
  shipmentId: number,
  shiprocketOrderId: string | null,
  shiprocketShipmentId: string,
  courierId: number | undefined,
  res: Response,
): Promise<void> {
  let awbCode: string | null = null;
  let courierName: string | null = null;
  try {
    const awbRes = await assignShiprocketAwb(
      organizationId,
      shiprocketShipmentId,
      courierId,
    );
    awbCode = awbRes.response?.data?.awb_code ?? null;
    courierName = awbRes.response?.data?.courier_name ?? null;
  } catch (err) {
    if (handleShiprocketError(err, res, {
      orgId: organizationId,
      shipmentId,
      op: "assign-awb (resume)",
    })) return;
    throw err;
  }

  let labelUrl: string | null = null;
  if (awbCode) {
    try {
      const labelRes = await generateShiprocketLabel(
        organizationId,
        shiprocketShipmentId,
      );
      labelUrl = labelRes.label_url ?? labelRes.response?.label_url ?? null;
    } catch (err) {
      logger.warn(
        { orgId: organizationId, shipmentId, err },
        "shiprocket: label generation failed during resume (non-fatal)",
      );
    }
  }

  const trackingUrl = awbCode ? buildShiprocketTrackingUrl(awbCode) : null;
  await db
    .update(shipmentsTable)
    .set({
      shiprocketOrderId,
      shiprocketShipmentId,
      awb: awbCode,
      courierName,
      labelUrl,
      trackingUrl,
      trackingStatus: awbCode ? "pickup_scheduled" : null,
    })
    .where(
      and(
        eq(shipmentsTable.id, shipmentId),
        eq(shipmentsTable.organizationId, organizationId),
      ),
    );

  const updatedRows = await db
    .select()
    .from(shipmentsTable)
    .where(
      and(
        eq(shipmentsTable.id, shipmentId),
        eq(shipmentsTable.organizationId, organizationId),
      ),
    )
    .limit(1);
  const lines = await loadShipmentLines(organizationId, shipmentId);
  res.json({
    shipment: { ...serializeShipment(updatedRows[0]!), lines },
    alreadyBooked: false,
  });
}

async function loadShipmentLines(orgId: number, shipmentId: number) {
  const rows = await db
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
        eq(shipmentLinesTable.shipmentId, shipmentId),
      ),
    );
  return rows.map((r) =>
    serializeShipmentLine(r.line, r.itemName, r.sku, r.salesOrderLineId),
  );
}

// ──────────────────────────────────────────────────────────────────────
// Tracking sync (manual cron-trigger)
// ──────────────────────────────────────────────────────────────────────

router.post("/shiprocket/sync-tracking", requireAdmin, async (req, res, next) => {
  try {
    const t = req.tenant!;
    // Delegate to the shared sync helper so that this manual,
    // admin-triggered route and the unattended daily scheduler both
    // run the exact same logic.
    const result = await syncShiprocketTrackingForOrg(t.organizationId);
    if (result.authError === "token_expired") {
      res.status(401).json({
        error:
          "Shiprocket session has expired. An admin needs to reconnect the integration.",
        code: "shiprocket_token_expired",
      });
      return;
    }
    if (result.authError === "not_connected") {
      res.status(400).json({ error: "Shiprocket is not connected" });
      return;
    }
    res.json({
      updated: result.updated,
      skipped: result.skipped,
      failed: result.failed,
      syncedAt: result.syncedAt.toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
