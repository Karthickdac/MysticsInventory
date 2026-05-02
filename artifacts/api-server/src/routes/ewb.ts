import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  organizationsTable,
  organizationMembersTable,
  salesOrdersTable,
  salesOrderLinesTable,
  customersTable,
  warehousesTable,
  itemsTable,
} from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import { encryptString } from "../lib/encryption";
import { logger } from "../lib/logger";
import { toNum } from "../lib/numeric";
import {
  ewbAuthLogin,
  generateEwb,
  generateEwbByIrn,
  updateVehicleEwb,
  cancelEwb,
  parseNicDateTime,
  buildEwbQrPayload,
  EwbApiError,
  EwbAuthError,
  EwbNotConnectedError,
  type EwbAddress,
  type EwbItem,
  type EwbCancelReason,
  type EwbTransportMode,
  type EwbVehicleType,
  type EwbVehicleUpdateReason,
} from "../lib/ewb";
import QRCode from "qrcode";
import { renderEwbPdf } from "../lib/ewbPdf";
import {
  GST_STATES,
  gstStateCodeFromGstin,
  gstStateCodeFromName,
} from "../lib/gstStates";

const router: IRouter = Router();
router.use(tenantMiddleware);

// ──────────────────────────────────────────────────────────────────────
// Validation schemas (zod)
// ──────────────────────────────────────────────────────────────────────

const idParamSchema = z.object({
  id: z
    .string()
    .regex(/^\d+$/u, "Invalid sales order id")
    .transform((s) => Number(s)),
});

const connectEwbSchema = z.object({
  gstin: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .refine((g) => /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9][A-Z][0-9A-Z]$/u.test(g), {
      message: "GSTIN format is invalid",
    }),
  username: z.string().trim().min(1, "username is required"),
  password: z.string().min(1, "password is required"),
});

const ewbAddressInputSchema = z
  .object({
    legalName: z.string().trim().min(1).optional(),
    gstin: z.string().trim().nullable().optional(),
    addressLine1: z.string().trim().min(1).optional(),
    addressLine2: z.string().nullable().optional(),
    city: z.string().trim().min(1).optional(),
    pincode: z.string().regex(/^[0-9]{6}$/u).optional(),
    stateCode: z.number().int().min(1).max(37).optional(),
    stateName: z.string().nullable().optional(),
  })
  .partial()
  .nullable()
  .optional()
  .transform((v) => v ?? undefined);

const transportModeSchema = z.enum(["1", "2", "3", "4"]);
const vehicleTypeSchema = z.enum(["R", "O"]);
const vehicleUpdateReasonSchema = z.enum(["1", "2", "3", "4"]);
const cancelReasonSchema = z.enum(["1", "2", "3", "4"]);

const generateEwbSchema = z.object({
  transportMode: transportModeSchema.default("1"),
  distanceKm: z
    .number()
    .finite()
    .gt(0, "distanceKm must be > 0")
    .max(4000, "distanceKm must be <= 4000"),
  vehicleNumber: z.string().trim().optional().nullable(),
  vehicleType: vehicleTypeSchema.default("R"),
  transporterId: z.string().trim().optional().nullable(),
  transporterName: z.string().trim().optional().nullable(),
  transDocNo: z.string().trim().optional().nullable(),
  transDocDate: z.string().trim().optional().nullable(),
  irn: z
    .string()
    .trim()
    .regex(
      /^[A-Fa-f0-9]{64}$/u,
      "IRN must be a 64-character hexadecimal string",
    )
    .optional()
    .nullable(),
  fromAddress: ewbAddressInputSchema,
  toAddress: ewbAddressInputSchema,
});

const updateVehicleSchema = z.object({
  vehicleNumber: z
    .string()
    .trim()
    .min(1, "vehicleNumber is required")
    .transform((s) => s.toUpperCase()),
  fromPlace: z.string().trim().min(1, "fromPlace is required"),
  fromState: z.number().int().min(1).max(37, "fromState must be a GST state code (1-37)"),
  reasonCode: vehicleUpdateReasonSchema.default("3"),
  reasonRem: z.string().trim().max(250).optional(),
  transportMode: transportModeSchema.optional(),
  vehicleType: vehicleTypeSchema.default("R"),
  transDocNo: z.string().trim().optional().nullable(),
  transDocDate: z.string().trim().optional().nullable(),
});

const cancelEwbSchema = z.object({
  reasonCode: cancelReasonSchema.default("4"),
  reasonRem: z.string().trim().max(250).optional(),
});

function sendZodError(res: Response, err: z.ZodError): void {
  const first = err.issues[0];
  const path = first?.path.join(".") || "body";
  res.status(400).json({
    error: `${path}: ${first?.message ?? "invalid input"}`,
    issues: err.issues,
  });
}

function emptyConnectionResponse() {
  return {
    connected: false,
    gstin: null,
    username: null,
    tokenExpiresAt: null,
    connectedAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
  } as const;
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function handleEwbError(
  err: unknown,
  res: Response,
  ctx: { orgId: number; op: string; orderId?: number },
): boolean {
  if (err instanceof EwbNotConnectedError) {
    res.status(400).json({
      error: "E-way bill is not configured for this organization",
      code: "ewb_not_connected",
    });
    return true;
  }
  if (err instanceof EwbAuthError) {
    logger.warn(
      { ...ctx, err: err.message },
      `ewb: ${ctx.op} failed at auth — admin must reconnect`,
    );
    res.status(401).json({
      error: err.message,
      code: "ewb_auth_failed",
    });
    return true;
  }
  if (err instanceof EwbApiError) {
    logger.warn(
      { ...ctx, status: err.status, body: err.body, msg: err.message },
      `ewb: ${ctx.op} failed`,
    );
    res.status(502).json({ error: err.message, code: "ewb_upstream_failed" });
    return true;
  }
  return false;
}

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

router.get("/ewb/connection", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const rows = await db
      .select({
        gstin: organizationsTable.ewbGstin,
        username: organizationsTable.ewbApiUsername,
        passwordEncrypted: organizationsTable.ewbApiPasswordEncrypted,
        tokenExpiresAt: organizationsTable.ewbTokenExpiresAt,
        connectedAt: organizationsTable.ewbConnectedAt,
        lastErrorAt: organizationsTable.ewbLastErrorAt,
        lastErrorMessage: organizationsTable.ewbLastErrorMessage,
      })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, t.organizationId))
      .limit(1);
    const o = rows[0]!;
    const connected = !!(
      o.gstin &&
      o.username &&
      o.passwordEncrypted
    );
    res.json({
      connected,
      gstin: o.gstin,
      username: o.username,
      tokenExpiresAt: o.tokenExpiresAt
        ? o.tokenExpiresAt.toISOString()
        : null,
      connectedAt: o.connectedAt ? o.connectedAt.toISOString() : null,
      lastErrorAt: o.lastErrorAt ? o.lastErrorAt.toISOString() : null,
      lastErrorMessage: o.lastErrorMessage,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/ewb/connection", requireAdmin, async (req, res, next) => {
  try {
    const t = req.tenant!;
    const parsed = connectEwbSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodError(res, parsed.error);
      return;
    }
    const { gstin, username, password } = parsed.data;
    // Verify the credentials by minting a token before persisting
    // anything. This prevents storing credentials that the upstream
    // already rejects.
    let minted: { token: string; expiresAt: Date };
    try {
      minted = await ewbAuthLogin(gstin, username, password);
    } catch (err) {
      if (err instanceof EwbAuthError) {
        res.status(401).json({ error: err.message });
        return;
      }
      throw err;
    }
    await db
      .update(organizationsTable)
      .set({
        ewbGstin: gstin,
        ewbApiUsername: username,
        ewbApiPasswordEncrypted: encryptString(password),
        ewbTokenEncrypted: encryptString(minted.token),
        ewbTokenExpiresAt: minted.expiresAt,
        ewbConnectedAt: new Date(),
        ewbLastErrorAt: null,
        ewbLastErrorMessage: null,
      })
      .where(eq(organizationsTable.id, t.organizationId));
    res.json({
      connected: true,
      gstin,
      username,
      tokenExpiresAt: minted.expiresAt.toISOString(),
      connectedAt: new Date().toISOString(),
      lastErrorAt: null,
      lastErrorMessage: null,
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/ewb/connection", requireAdmin, async (req, res, next) => {
  try {
    const t = req.tenant!;
    await db
      .update(organizationsTable)
      .set({
        ewbGstin: null,
        ewbApiUsername: null,
        ewbApiPasswordEncrypted: null,
        ewbTokenEncrypted: null,
        ewbTokenExpiresAt: null,
        ewbConnectedAt: null,
        ewbLastErrorAt: null,
        ewbLastErrorMessage: null,
      })
      .where(eq(organizationsTable.id, t.organizationId));
    res.json(emptyConnectionResponse());
  } catch (err) {
    next(err);
  }
});

// Surface the GST state list + transport mode codes so the UI
// doesn't have to hard-code them.
router.get("/ewb/reference-data", (_req, res) => {
  res.json({
    states: GST_STATES,
    transportModes: [
      { code: "1", label: "Road" },
      { code: "2", label: "Rail" },
      { code: "3", label: "Air" },
      { code: "4", label: "Ship" },
    ],
    cancelReasons: [
      { code: "1", label: "Duplicate" },
      { code: "2", label: "Order Cancelled" },
      { code: "3", label: "Data Entry Mistake" },
      { code: "4", label: "Others" },
    ],
    vehicleUpdateReasons: [
      { code: "1", label: "Due to break-down" },
      { code: "2", label: "Due to transhipment" },
      { code: "3", label: "Others" },
      { code: "4", label: "First Time" },
    ],
  });
});

// ──────────────────────────────────────────────────────────────────────
// Per-order EWB actions
// ──────────────────────────────────────────────────────────────────────

interface OrderForEwb {
  id: number;
  organizationId: number;
  orderNumber: string;
  orderDate: string;
  status: string;
  ewbNumber: string | null;
  ewbStatus: string | null;
  customer: {
    id: number;
    name: string;
    company: string | null;
    gstNumber: string | null;
    billingAddress: string | null;
    shippingAddress: string | null;
    placeOfSupply: string | null;
  };
  warehouse: {
    id: number;
    name: string;
    addressLine1: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
  };
  totals: { total: number; tax: number; subtotal: number };
  lines: Array<{
    name: string;
    sku: string;
    description: string | null;
    hsnCode: string | null;
    quantity: number;
    unit: string;
    taxRate: number;
    lineSubtotal: number;
    lineTotal: number;
  }>;
}

async function loadOrderForEwb(
  orgId: number,
  orderId: number,
): Promise<OrderForEwb | null> {
  const orderRows = await db
    .select({
      order: salesOrdersTable,
      customer: customersTable,
      warehouse: warehousesTable,
    })
    .from(salesOrdersTable)
    .innerJoin(customersTable, eq(customersTable.id, salesOrdersTable.customerId))
    .innerJoin(warehousesTable, eq(warehousesTable.id, salesOrdersTable.warehouseId))
    .where(
      and(
        eq(salesOrdersTable.id, orderId),
        eq(salesOrdersTable.organizationId, orgId),
      ),
    )
    .limit(1);
  const row = orderRows[0];
  if (!row) return null;
  const lineRows = await db
    .select({
      line: salesOrderLinesTable,
      itemName: itemsTable.name,
      sku: itemsTable.sku,
      hsnCode: itemsTable.hsnCode,
      unit: itemsTable.unit,
    })
    .from(salesOrderLinesTable)
    .innerJoin(itemsTable, eq(itemsTable.id, salesOrderLinesTable.itemId))
    .where(eq(salesOrderLinesTable.salesOrderId, orderId));
  return {
    id: row.order.id,
    organizationId: row.order.organizationId,
    orderNumber: row.order.orderNumber,
    orderDate: row.order.orderDate,
    status: row.order.status,
    ewbNumber: row.order.ewbNumber,
    ewbStatus: row.order.ewbStatus,
    customer: {
      id: row.customer.id,
      name: row.customer.name,
      company: row.customer.company,
      gstNumber: row.customer.gstNumber,
      billingAddress: row.customer.billingAddress,
      shippingAddress: row.customer.shippingAddress,
      placeOfSupply: row.customer.placeOfSupply,
    },
    warehouse: {
      id: row.warehouse.id,
      name: row.warehouse.name,
      addressLine1: row.warehouse.addressLine1,
      city: row.warehouse.city,
      state: row.warehouse.state,
      country: row.warehouse.country,
    },
    totals: {
      subtotal: toNum(row.order.subtotal),
      tax: toNum(row.order.taxTotal),
      total: toNum(row.order.total),
    },
    lines: lineRows.map((r) => ({
      name: r.itemName,
      sku: r.sku,
      description: r.line.description,
      hsnCode: r.hsnCode,
      quantity: toNum(r.line.quantity),
      unit: r.unit ?? "NOS",
      taxRate: toNum(r.line.taxRate),
      lineSubtotal: toNum(r.line.lineSubtotal),
      lineTotal: toNum(r.line.lineTotal),
    })),
  };
}

interface AddressInput {
  legalName?: string;
  gstin?: string | null;
  addressLine1?: string;
  addressLine2?: string | null;
  city?: string;
  pincode?: string;
  stateCode?: number;
  stateName?: string | null;
}

// Best-effort parser for the single-line addresses we store in
// customers.shipping_address. Pulls a 6-digit pincode out of any
// position and treats the comma-separated token immediately before it
// as the city. Used only as a fallback when structured fields aren't
// passed in the request.
function parseSingleLineAddress(text: string | null | undefined): {
  city: string | null;
  pincode: string | null;
} {
  const s = (text ?? "").trim();
  if (!s) return { city: null, pincode: null };
  const pinMatch = s.match(/(?<![0-9])([0-9]{6})(?![0-9])/u);
  const pincode = pinMatch ? pinMatch[1]! : null;
  const before = pinMatch ? s.slice(0, pinMatch.index!) : s;
  const tokens = before
    .split(/[,\n]/u)
    .map((t) => t.replace(/[\s\-–—]+$/u, "").trim())
    .filter(Boolean);
  // Walk from right to left and pick the first token that looks like
  // a place name AND is not a known Indian state. This handles both
  // "Street, City - 110001" and "Street, City, State - 110001" while
  // still rejecting numeric or empty tokens.
  let city: string | null = null;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (!/^[A-Za-z][A-Za-z .'-]+$/u.test(t)) continue;
    if (gstStateCodeFromName(t) != null) continue;
    city = t;
    break;
  }
  return { city, pincode };
}

function resolveAddress(
  input: AddressInput | undefined,
  fallback: {
    legalName: string;
    gstin?: string | null;
    addressLine1?: string | null;
    city?: string | null;
    state?: string | null;
    pincode?: string | null;
  },
): EwbAddress | { error: string } {
  const parsed = parseSingleLineAddress(fallback.addressLine1);
  const merged = {
    legalName: (input?.legalName ?? fallback.legalName ?? "").trim(),
    gstin: input?.gstin ?? fallback.gstin ?? null,
    addressLine1: (input?.addressLine1 ?? fallback.addressLine1 ?? "").trim(),
    addressLine2: input?.addressLine2 ?? null,
    city: (input?.city ?? fallback.city ?? parsed.city ?? "").trim(),
    pincode: (input?.pincode ?? fallback.pincode ?? parsed.pincode ?? "").trim(),
    stateCode:
      input?.stateCode ??
      gstStateCodeFromName(input?.stateName ?? fallback.state ?? null) ??
      gstStateCodeFromGstin(input?.gstin ?? fallback.gstin ?? null) ??
      null,
  };
  if (!merged.legalName) return { error: "legal name is required" };
  if (!merged.addressLine1) return { error: "address line 1 is required" };
  if (!merged.city) return { error: "city is required" };
  if (!/^[0-9]{6}$/u.test(merged.pincode)) {
    return { error: "pincode must be a 6-digit number" };
  }
  if (!merged.stateCode) {
    return {
      error:
        "state code could not be resolved — please pick a state from the list",
    };
  }
  return {
    legalName: merged.legalName,
    gstin: merged.gstin,
    addressLine1: merged.addressLine1,
    addressLine2: merged.addressLine2,
    city: merged.city,
    pincode: merged.pincode,
    stateCode: merged.stateCode,
  };
}

function buildEwbItems(order: OrderForEwb, sameState: boolean): EwbItem[] {
  // For the NIC EWB API, IGST and CGST/SGST are mutually exclusive per
  // line: intra-state shipments use CGST + SGST split, inter-state
  // shipments use IGST only. Setting all three triggers tax-mismatch
  // validation errors at the portal.
  return order.lines.map((l) => {
    const taxRate = l.taxRate;
    return {
      productName: l.name.slice(0, 100),
      productDesc: (l.description ?? l.name).slice(0, 100),
      hsnCode: l.hsnCode ?? "0",
      quantity: l.quantity,
      qtyUnit: (l.unit || "NOS").toUpperCase().slice(0, 3),
      cgstRate: sameState ? taxRate / 2 : 0,
      sgstRate: sameState ? taxRate / 2 : 0,
      igstRate: sameState ? 0 : taxRate,
      cessRate: 0,
      taxableAmount: l.lineSubtotal,
    };
  });
}

router.post(
  "/sales-orders/:id/ewb/generate",
  async (req, res, next) => {
    try {
      const t = req.tenant!;
      const paramParse = idParamSchema.safeParse(req.params);
      if (!paramParse.success) {
        sendZodError(res, paramParse.error);
        return;
      }
      const { id } = paramParse.data;
      const bodyParse = generateEwbSchema.safeParse(req.body ?? {});
      if (!bodyParse.success) {
        sendZodError(res, bodyParse.error);
        return;
      }
      const b = bodyParse.data;
      const order = await loadOrderForEwb(t.organizationId, id);
      if (!order) {
        res.status(404).json({ error: "Sales order not found" });
        return;
      }
      if (order.ewbStatus === "active") {
        res.status(400).json({
          error:
            "An active e-way bill already exists for this order. Cancel it before generating a new one.",
        });
        return;
      }
      if (
        ![
          "confirmed",
          "shipped",
          "partially_shipped",
          "delivered",
          "invoiced",
          "paid",
        ].includes(order.status)
      ) {
        res.status(400).json({
          error: `E-way bill can only be generated after the order is confirmed. Current status: ${order.status}.`,
        });
        return;
      }
      const transportMode: EwbTransportMode = b.transportMode;
      const distanceKm = b.distanceKm;
      const vehicleNumber = (b.vehicleNumber ?? "").toUpperCase();
      const vehicleType: EwbVehicleType = b.vehicleType;
      const transporterId = b.transporterId
        ? b.transporterId.toUpperCase()
        : null;
      const transporterName = b.transporterName ?? null;
      const transDocNo = b.transDocNo ?? null;
      const transDocDate = b.transDocDate ?? null;
      // For road transport with no transporter, vehicle number is
      // required upfront. For other modes a transporter id is
      // expected and vehicle number can be filled in later via
      // update-vehicle.
      if (transportMode === "1" && !vehicleNumber && !transporterId) {
        res.status(400).json({
          error:
            "Provide either a vehicle number or a transporter ID for road transport",
        });
        return;
      }
      // IRN fast-path: NIC re-uses the invoice (and its addresses) that
      // was previously registered with the IRP, so we deliberately skip
      // the address-resolution and item-building steps below.
      let fromAddr: EwbAddress | null = null;
      let toAddr: EwbAddress | null = null;
      let items: EwbItem[] = [];
      let cgstValue = 0;
      let sgstValue = 0;
      let igstValue = 0;
      if (!b.irn) {
        const orgRows = await db
          .select()
          .from(organizationsTable)
          .where(eq(organizationsTable.id, t.organizationId))
          .limit(1);
        const org = orgRows[0]!;
        const fromAddrRes = resolveAddress(b.fromAddress, {
          legalName: org.name,
          gstin: org.ewbGstin ?? org.gstNumber ?? null,
          addressLine1: org.addressLine1 ?? null,
          city: order.warehouse.city ?? org.city ?? null,
          state: order.warehouse.state ?? org.state ?? null,
          pincode: org.postalCode ?? null,
        });
        if ("error" in fromAddrRes) {
          res
            .status(400)
            .json({ error: `From address: ${fromAddrRes.error}` });
          return;
        }
        const customerStatePart = (() => {
          const ship = order.customer.shippingAddress ?? "";
          const m = ship.match(
            /,\s*([A-Za-z][A-Za-z\s]+?)\s*[-,]?\s*\d{6}\s*(?:,|$)/u,
          );
          return m?.[1] ?? null;
        })();
        const toAddrRes = resolveAddress(b.toAddress, {
          legalName: order.customer.company ?? order.customer.name,
          gstin: order.customer.gstNumber,
          addressLine1: order.customer.shippingAddress ?? "",
          city: undefined,
          state:
            order.customer.placeOfSupply ?? customerStatePart ?? undefined,
          pincode: undefined,
        });
        if ("error" in toAddrRes) {
          res.status(400).json({
            error: `Ship-to address: ${toAddrRes.error}. Please provide it explicitly in the request.`,
          });
          return;
        }
        fromAddr = fromAddrRes;
        toAddr = toAddrRes;
        const sameState = fromAddr.stateCode === toAddr.stateCode;
        cgstValue = sameState ? round2(order.totals.tax / 2) : 0;
        sgstValue = sameState ? round2(order.totals.tax / 2) : 0;
        igstValue = sameState ? 0 : round2(order.totals.tax);
        items = buildEwbItems(order, sameState);
      }
      try {
        const generated = b.irn
          ? await generateEwbByIrn(t.organizationId, {
              irn: b.irn,
              transactionType: 1,
              transportMode,
              distanceKm,
              vehicleNumber: vehicleNumber || null,
              vehicleType,
              transporterId,
              transporterName,
              transDocNo,
              transDocDate,
            })
          : await generateEwb(t.organizationId, {
              supplyType: "O",
              subSupplyType: "1",
              docType: "INV",
              docNo: order.orderNumber,
              docDate: nicDate(order.orderDate),
              fromAddress: fromAddr!,
              toAddress: toAddr!,
              items,
              totalValue: order.totals.subtotal,
              cgstValue,
              sgstValue,
              igstValue,
              totalInvValue: order.totals.total,
              transactionType: 1,
              transportMode,
              distanceKm,
              vehicleNumber: vehicleNumber || null,
              vehicleType,
              transporterId,
              transporterName,
              transDocNo,
              transDocDate,
            });

        const ewbDate =
          parseNicDateTime(generated.ewayBillDate) ?? new Date();
        const validUpto = parseNicDateTime(generated.validUpto);
        const qrPayload = buildEwbQrPayload(generated.ewayBillNo);

        await db
          // org-scope-allow: order was loaded org-scoped above; this update
          // targets that same row by id within the same handler.
          .update(salesOrdersTable)
          .set({
            ewbNumber: generated.ewayBillNo,
            ewbDate,
            ewbValidUntil: validUpto,
            ewbStatus: "active",
            ewbQrPayload: qrPayload,
            ewbVehicleNumber: vehicleNumber || null,
            ewbTransportMode: transportMode,
            ewbTransporterName: transporterName || null,
            ewbTransporterId: transporterId || null,
            ewbDistanceKm: Math.round(distanceKm),
            ewbDispatchAddress: fromAddr,
            ewbShipToAddress: toAddr,
            ewbCancelledAt: null,
            ewbCancelReason: null,
          })
          .where(eq(salesOrdersTable.id, order.id));

        res.status(201).json({
          ewbNumber: generated.ewayBillNo,
          ewbDate: ewbDate.toISOString(),
          ewbValidUntil: validUpto ? validUpto.toISOString() : null,
          ewbStatus: "active",
          ewbQrPayload: qrPayload,
          ewbVehicleNumber: vehicleNumber || null,
        });
      } catch (err) {
        if (handleEwbError(err, res, { orgId: t.organizationId, op: "generate", orderId: id })) {
          return;
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/sales-orders/:id/ewb/update-vehicle",
  async (req, res, next) => {
    try {
      const t = req.tenant!;
      const paramParse = idParamSchema.safeParse(req.params);
      if (!paramParse.success) {
        sendZodError(res, paramParse.error);
        return;
      }
      const { id } = paramParse.data;
      const bodyParse = updateVehicleSchema.safeParse(req.body ?? {});
      if (!bodyParse.success) {
        sendZodError(res, bodyParse.error);
        return;
      }
      const b = bodyParse.data;
      const orderRows = await db
        .select()
        .from(salesOrdersTable)
        .where(
          and(
            eq(salesOrdersTable.id, id),
            eq(salesOrdersTable.organizationId, t.organizationId),
          ),
        )
        .limit(1);
      const order = orderRows[0];
      if (!order) {
        res.status(404).json({ error: "Sales order not found" });
        return;
      }
      if (!order.ewbNumber || order.ewbStatus !== "active") {
        res.status(400).json({
          error: "No active e-way bill on this order to update",
        });
        return;
      }
      const vehicleNumber = b.vehicleNumber;
      const fromPlace = b.fromPlace;
      const fromState = b.fromState;
      const reasonCode: EwbVehicleUpdateReason = b.reasonCode;
      const reasonRem = b.reasonRem ?? "Vehicle updated";
      const transportMode: EwbTransportMode =
        b.transportMode ?? ((order.ewbTransportMode as EwbTransportMode | null) ?? "1");
      try {
        const updated = await updateVehicleEwb(t.organizationId, {
          ewbNo: order.ewbNumber,
          vehicleNumber,
          fromPlace,
          fromState,
          reasonCode,
          reasonRem,
          transDocNo: b.transDocNo ?? null,
          transDocDate: b.transDocDate ?? null,
          transportMode,
          vehicleType: b.vehicleType,
        });
        const validUpto = parseNicDateTime(updated.validUpto);
        await db
          .update(salesOrdersTable)
          .set({
            ewbVehicleNumber: vehicleNumber,
            ewbTransportMode: transportMode,
            ewbValidUntil: validUpto ?? order.ewbValidUntil,
          })
          .where(
            and(
              eq(salesOrdersTable.organizationId, t.organizationId),
              eq(salesOrdersTable.id, order.id),
            ),
          );
        res.json({
          ewbNumber: order.ewbNumber,
          ewbVehicleNumber: vehicleNumber,
          ewbValidUntil: validUpto ? validUpto.toISOString() : null,
        });
      } catch (err) {
        if (handleEwbError(err, res, { orgId: t.organizationId, op: "update-vehicle", orderId: id })) {
          return;
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/sales-orders/:id/ewb/cancel",
  async (req, res, next) => {
    try {
      const t = req.tenant!;
      const paramParse = idParamSchema.safeParse(req.params);
      if (!paramParse.success) {
        sendZodError(res, paramParse.error);
        return;
      }
      const { id } = paramParse.data;
      const bodyParse = cancelEwbSchema.safeParse(req.body ?? {});
      if (!bodyParse.success) {
        sendZodError(res, bodyParse.error);
        return;
      }
      const b = bodyParse.data;
      const orderRows = await db
        .select()
        .from(salesOrdersTable)
        .where(
          and(
            eq(salesOrdersTable.id, id),
            eq(salesOrdersTable.organizationId, t.organizationId),
          ),
        )
        .limit(1);
      const order = orderRows[0];
      if (!order) {
        res.status(404).json({ error: "Sales order not found" });
        return;
      }
      if (!order.ewbNumber || order.ewbStatus !== "active") {
        res.status(400).json({
          error: "No active e-way bill on this order to cancel",
        });
        return;
      }
      // EWBs may only be cancelled within 24 hours of generation.
      // Surface this rule client-side rather than failing at NIC.
      if (order.ewbDate) {
        const ageMs = Date.now() - order.ewbDate.getTime();
        if (ageMs > 24 * 60 * 60 * 1000) {
          res.status(400).json({
            error:
              "E-way bills can only be cancelled within 24 hours of generation",
          });
          return;
        }
      }
      const reasonCode: EwbCancelReason = b.reasonCode;
      const reasonRem = b.reasonRem ?? "Cancelled by user";
      try {
        const cancelled = await cancelEwb(t.organizationId, {
          ewbNo: order.ewbNumber,
          reasonCode,
          reasonRem,
        });
        const cancelledAt =
          parseNicDateTime(cancelled.cancelledAt) ?? new Date();
        await db
          .update(salesOrdersTable)
          .set({
            ewbStatus: "cancelled",
            ewbCancelledAt: cancelledAt,
            ewbCancelReason: reasonRem,
          })
          .where(
            and(
              eq(salesOrdersTable.organizationId, t.organizationId),
              eq(salesOrdersTable.id, order.id),
            ),
          );
        res.json({
          ewbNumber: order.ewbNumber,
          ewbStatus: "cancelled",
          ewbCancelledAt: cancelledAt.toISOString(),
        });
      } catch (err) {
        if (handleEwbError(err, res, { orgId: t.organizationId, op: "cancel", orderId: id })) {
          return;
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  },
);

router.get("/sales-orders/:id/ewb/qr.png", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid sales order id" });
      return;
    }
    const rows = await db
      .select({
        ewbQrPayload: salesOrdersTable.ewbQrPayload,
        ewbNumber: salesOrdersTable.ewbNumber,
      })
      .from(salesOrdersTable)
      .where(
        and(
          eq(salesOrdersTable.id, id),
          eq(salesOrdersTable.organizationId, t.organizationId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row || !row.ewbNumber) {
      res.status(404).json({ error: "No e-way bill on this order" });
      return;
    }
    const payload = row.ewbQrPayload || row.ewbNumber;
    const png = await QRCode.toBuffer(payload, {
      type: "png",
      errorCorrectionLevel: "M",
      margin: 1,
      width: 256,
    });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.end(png);
  } catch (err) {
    next(err);
  }
});

router.get("/sales-orders/:id/ewb.pdf", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid sales order id" });
      return;
    }
    const orderRows = await db
      .select({
        order: salesOrdersTable,
        customer: customersTable,
        warehouse: warehousesTable,
        org: organizationsTable,
      })
      .from(salesOrdersTable)
      .innerJoin(customersTable, eq(customersTable.id, salesOrdersTable.customerId))
      .innerJoin(warehousesTable, eq(warehousesTable.id, salesOrdersTable.warehouseId))
      .innerJoin(organizationsTable, eq(organizationsTable.id, salesOrdersTable.organizationId))
      .where(
        and(
          eq(salesOrdersTable.id, id),
          eq(salesOrdersTable.organizationId, t.organizationId),
        ),
      )
      .limit(1);
    const row = orderRows[0];
    if (!row) {
      res.status(404).json({ error: "Sales order not found" });
      return;
    }
    if (!row.order.ewbNumber) {
      res.status(404).json({
        error: "No e-way bill has been generated for this order",
      });
      return;
    }
    const lineRows = await db
      .select({
        line: salesOrderLinesTable,
        itemName: itemsTable.name,
        sku: itemsTable.sku,
        hsnCode: itemsTable.hsnCode,
        unit: itemsTable.unit,
      })
      .from(salesOrderLinesTable)
      .innerJoin(itemsTable, eq(itemsTable.id, salesOrderLinesTable.itemId))
      .where(eq(salesOrderLinesTable.salesOrderId, id));
    const pdf = await renderEwbPdf({
      org: {
        name: row.org.name,
        gstNumber: row.org.ewbGstin ?? row.org.gstNumber,
        addressLine1: row.org.addressLine1,
        city: row.org.city,
        state: row.org.state,
        postalCode: row.org.postalCode,
      },
      order: {
        orderNumber: row.order.orderNumber,
        orderDate: row.order.orderDate,
        total: toNum(row.order.total),
        subtotal: toNum(row.order.subtotal),
        taxTotal: toNum(row.order.taxTotal),
      },
      ewb: {
        number: row.order.ewbNumber,
        date: row.order.ewbDate,
        validUntil: row.order.ewbValidUntil,
        status: row.order.ewbStatus,
        qrPayload: row.order.ewbQrPayload,
        vehicleNumber: row.order.ewbVehicleNumber,
        transportMode: row.order.ewbTransportMode,
        transporterName: row.order.ewbTransporterName,
        transporterId: row.order.ewbTransporterId,
        distanceKm: row.order.ewbDistanceKm,
        cancelledAt: row.order.ewbCancelledAt,
        cancelReason: row.order.ewbCancelReason,
      },
      dispatchAddress: row.order.ewbDispatchAddress as Record<
        string,
        unknown
      > | null,
      shipToAddress: row.order.ewbShipToAddress as Record<
        string,
        unknown
      > | null,
      customer: {
        name: row.customer.name,
        company: row.customer.company,
        gstNumber: row.customer.gstNumber,
      },
      lines: lineRows.map((l) => ({
        name: l.itemName,
        sku: l.sku,
        hsn: l.hsnCode,
        unit: l.unit ?? "NOS",
        qty: toNum(l.line.quantity),
        rate: toNum(l.line.unitPrice),
        taxableAmount: toNum(l.line.lineSubtotal),
        total: toNum(l.line.lineTotal),
      })),
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="ewb-${row.order.ewbNumber}.pdf"`,
    );
    res.setHeader("Cache-Control", "private, max-age=0, no-store");
    res.setHeader("Content-Length", String(pdf.length));
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function nicDate(iso: string): string {
  // Convert YYYY-MM-DD → DD/MM/YYYY required by NIC.
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/u);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export default router;
