import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  organizationsTable,
  organizationMembersTable,
  salesOrdersTable,
  salesOrderLinesTable,
  customersTable,
  itemsTable,
} from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import { encryptString } from "../lib/encryption";
import { logger } from "../lib/logger";
import { toNum } from "../lib/numeric";
import {
  einvoiceAuthLogin,
  generateIrn,
  cancelIrn,
  parseIrpAckDate,
  isIrpCancellable,
  EinvoiceApiError,
  EinvoiceAuthError,
  EinvoiceNotConnectedError,
  type IrpAddress,
  type IrpItem,
  type IrpCancelReason,
  type GenerateIrnInput,
} from "../lib/einvoice";
import QRCode from "qrcode";
import {
  gstStateCodeFromGstin,
  gstStateCodeFromName,
} from "../lib/gstStates";

const router: IRouter = Router();
router.use(tenantMiddleware);

// ──────────────────────────────────────────────────────────────────────
// Validation schemas
// ──────────────────────────────────────────────────────────────────────

const idParamSchema = z.object({
  id: z
    .string()
    .regex(/^\d+$/u, "Invalid sales order id")
    .transform((s) => Number(s)),
});

const gstinSchema = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .refine((g) => /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9][A-Z][0-9A-Z]$/u.test(g), {
    message: "GSTIN format is invalid",
  });

const connectEinvoiceSchema = z.object({
  gstin: gstinSchema,
  username: z.string().trim().min(1, "username is required"),
  password: z.string().min(1, "password is required"),
  clientId: z.string().trim().optional().nullable(),
  clientSecret: z.string().optional().nullable(),
  enabled: z.boolean().optional(),
});

const cancelIrnSchema = z.object({
  reasonCode: z.enum(["1", "2", "3", "4"]).default("4"),
  reasonRemark: z.string().trim().min(1, "Reason is required").max(100),
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
    enabled: false,
    gstin: null,
    username: null,
    hasClientCredentials: false,
    tokenExpiresAt: null,
    connectedAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
  } as const;
}

// ──────────────────────────────────────────────────────────────────────
// Error handler shared with the auto-hook
// ──────────────────────────────────────────────────────────────────────

// Sanitised, user-safe message for upstream IRP failures. Detailed
// upstream payloads stay in server logs only; we never let raw IRP
// ErrorDetails text reach the operator's UI because the wording is
// often confusing and occasionally exposes internal IDs.
const GENERIC_UPSTREAM_MESSAGE =
  "The e-invoice (IRP) service rejected this request. Please retry shortly; if the problem persists, check your invoice details and IRP credentials.";

function handleEinvoiceError(
  err: unknown,
  res: Response,
  ctx: { orgId: number; op: string; orderId?: number },
): boolean {
  if (err instanceof EinvoiceNotConnectedError) {
    res.status(400).json({
      error: "E-invoice is not configured for this organization",
      code: "einvoice_not_connected",
    });
    return true;
  }
  if (err instanceof EinvoiceAuthError) {
    logger.warn(
      { ...ctx, err: err.message },
      `einvoice: ${ctx.op} failed at auth — admin must reconnect`,
    );
    res.status(401).json({
      error:
        "IRP rejected the saved credentials. An admin must reconnect the integration.",
      code: "einvoice_auth_failed",
    });
    return true;
  }
  if (err instanceof EinvoiceApiError) {
    logger.warn(
      { ...ctx, status: err.status, body: err.body, msg: err.message },
      `einvoice: ${ctx.op} failed`,
    );
    // 4xx from the IRP — or our own local validation errors thrown
    // as EinvoiceApiError(400, ...) — are caller mistakes; surface
    // the human-readable message as a 400 so the client can show it
    // in the form. 5xx (and status === 0 for network failures) are
    // upstream outages — return a sanitised 502.
    if (err.status >= 400 && err.status < 500) {
      res.status(400).json({
        error: err.message,
        code: err.code ?? "einvoice_invalid_request",
      });
    } else {
      res.status(502).json({
        error: GENERIC_UPSTREAM_MESSAGE,
        code: err.code ?? "einvoice_upstream_failed",
      });
    }
    return true;
  }
  return false;
}

/**
 * Map an unknown error to the message we persist in
 * `sales_orders.irpError`. Local validation errors keep their
 * specific text (so admins can fix the underlying data); raw
 * upstream errors are reduced to a generic operator-friendly
 * message — the gory details live in the server logs.
 */
function persistedErrorMessage(err: unknown): string {
  if (err instanceof EinvoiceNotConnectedError) {
    return "E-invoice is not configured for this organization.";
  }
  if (err instanceof EinvoiceAuthError) {
    return "IRP rejected the saved credentials. Reconnect the integration.";
  }
  if (err instanceof EinvoiceApiError) {
    if (err.status >= 400 && err.status < 500) {
      return err.message.slice(0, 500);
    }
    return GENERIC_UPSTREAM_MESSAGE;
  }
  return "Unknown IRP error";
}

/**
 * Extract the persisted error fields (message + code + context) for
 * an IRP failure. The code/context drive the structured "What to
 * fix" panel on the SalesOrderDetail page; the message is the
 * fallback humans read.
 */
function persistedErrorFields(err: unknown): {
  irpError: string;
  irpErrorCode: string | null;
  irpErrorContext: Record<string, unknown> | null;
} {
  const irpError = persistedErrorMessage(err);
  if (err instanceof EinvoiceNotConnectedError) {
    return {
      irpError,
      irpErrorCode: "einvoice_not_connected",
      irpErrorContext: null,
    };
  }
  if (err instanceof EinvoiceAuthError) {
    return {
      irpError,
      irpErrorCode: "einvoice_auth_failed",
      irpErrorContext: null,
    };
  }
  if (err instanceof EinvoiceApiError) {
    return {
      irpError,
      irpErrorCode: err.code,
      irpErrorContext: err.context,
    };
  }
  return { irpError, irpErrorCode: null, irpErrorContext: null };
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

router.get("/einvoice/connection", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const rows = await db
      .select({
        enabled: organizationsTable.eInvoiceEnabled,
        gstin: organizationsTable.eInvoiceGstin,
        username: organizationsTable.eInvoiceApiUsername,
        passwordEncrypted: organizationsTable.eInvoiceApiPasswordEncrypted,
        clientIdEncrypted: organizationsTable.eInvoiceClientIdEncrypted,
        tokenExpiresAt: organizationsTable.eInvoiceTokenExpiresAt,
        connectedAt: organizationsTable.eInvoiceConnectedAt,
        lastErrorAt: organizationsTable.eInvoiceLastErrorAt,
        lastErrorMessage: organizationsTable.eInvoiceLastErrorMessage,
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
      enabled: o.enabled,
      gstin: o.gstin,
      username: o.username,
      hasClientCredentials: !!o.clientIdEncrypted,
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

router.post("/einvoice/connection", requireAdmin, async (req, res, next) => {
  try {
    const t = req.tenant!;
    const parsed = connectEinvoiceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodError(res, parsed.error);
      return;
    }
    const { gstin, username, password, clientId, clientSecret, enabled } =
      parsed.data;
    // Verify the credentials by minting a token before persisting
    // anything. This prevents storing credentials that the IRP
    // already rejects.
    let minted: { token: string; expiresAt: Date };
    try {
      minted = await einvoiceAuthLogin(
        gstin,
        username,
        password,
        clientId ?? null,
        clientSecret ?? null,
      );
    } catch (err) {
      if (err instanceof EinvoiceAuthError) {
        res.status(401).json({ error: err.message });
        return;
      }
      throw err;
    }
    await db
      .update(organizationsTable)
      .set({
        eInvoiceEnabled: enabled ?? true,
        eInvoiceGstin: gstin,
        eInvoiceApiUsername: username,
        eInvoiceApiPasswordEncrypted: encryptString(password),
        eInvoiceClientIdEncrypted: clientId
          ? encryptString(clientId)
          : null,
        eInvoiceClientSecretEncrypted: clientSecret
          ? encryptString(clientSecret)
          : null,
        eInvoiceTokenEncrypted: encryptString(minted.token),
        eInvoiceTokenExpiresAt: minted.expiresAt,
        eInvoiceConnectedAt: new Date(),
        eInvoiceLastErrorAt: null,
        eInvoiceLastErrorMessage: null,
      })
      .where(eq(organizationsTable.id, t.organizationId));
    res.json({
      connected: true,
      enabled: enabled ?? true,
      gstin,
      username,
      hasClientCredentials: !!clientId,
      tokenExpiresAt: minted.expiresAt.toISOString(),
      connectedAt: new Date().toISOString(),
      lastErrorAt: null,
      lastErrorMessage: null,
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/einvoice/connection", requireAdmin, async (req, res, next) => {
  try {
    const t = req.tenant!;
    const body = req.body ?? {};
    const enabled = typeof body.enabled === "boolean" ? body.enabled : null;
    if (enabled === null) {
      res.status(400).json({ error: "enabled (boolean) is required" });
      return;
    }
    if (enabled) {
      // Don't let an admin re-enable e-invoicing if the connection
      // was wiped — that would silently mark every new invoice as
      // failed, which is worse than the off state.
      const rows = await db
        .select({
          gstin: organizationsTable.eInvoiceGstin,
          passwordEncrypted: organizationsTable.eInvoiceApiPasswordEncrypted,
        })
        .from(organizationsTable)
        .where(eq(organizationsTable.id, t.organizationId))
        .limit(1);
      if (!rows[0]?.gstin || !rows[0]?.passwordEncrypted) {
        res.status(400).json({
          error: "Connect IRP credentials before enabling e-invoicing.",
        });
        return;
      }
    }
    await db
      .update(organizationsTable)
      .set({ eInvoiceEnabled: enabled })
      .where(eq(organizationsTable.id, t.organizationId));
    res.json({ ok: true, enabled });
  } catch (err) {
    next(err);
  }
});

router.delete("/einvoice/connection", requireAdmin, async (req, res, next) => {
  try {
    const t = req.tenant!;
    await db
      .update(organizationsTable)
      .set({
        eInvoiceEnabled: false,
        eInvoiceGstin: null,
        eInvoiceApiUsername: null,
        eInvoiceApiPasswordEncrypted: null,
        eInvoiceClientIdEncrypted: null,
        eInvoiceClientSecretEncrypted: null,
        eInvoiceTokenEncrypted: null,
        eInvoiceTokenExpiresAt: null,
        eInvoiceConnectedAt: null,
        eInvoiceLastErrorAt: null,
        eInvoiceLastErrorMessage: null,
      })
      .where(eq(organizationsTable.id, t.organizationId));
    res.json(emptyConnectionResponse());
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────
// Per-order IRN actions
// ──────────────────────────────────────────────────────────────────────

interface OrderForIrn {
  id: number;
  organizationId: number;
  orderNumber: string;
  orderDate: string;
  status: string;
  irn: string | null;
  irpStatus: string | null;
  irpAckDate: Date | null;
  customer: {
    id: number;
    name: string;
    company: string | null;
    gstNumber: string | null;
    billingAddress: string | null;
    shippingAddress: string | null;
    placeOfSupply: string | null;
    email: string | null;
    phone: string | null;
  };
  org: {
    name: string;
    gstNumber: string | null;
    addressLine1: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    eInvoiceGstin: string | null;
  };
  totals: { subtotal: number; tax: number; total: number };
  lines: Array<{
    itemId: number;
    name: string;
    sku: string;
    description: string | null;
    hsnCode: string | null;
    unit: string;
    quantity: number;
    unitPrice: number;
    taxRate: number;
    lineSubtotal: number;
    lineTax: number;
    lineTotal: number;
  }>;
}

async function loadOrderForIrn(
  orgId: number,
  orderId: number,
): Promise<OrderForIrn | null> {
  const rows = await db
    .select({
      order: salesOrdersTable,
      customer: customersTable,
      org: organizationsTable,
    })
    .from(salesOrdersTable)
    .innerJoin(customersTable, eq(customersTable.id, salesOrdersTable.customerId))
    .innerJoin(organizationsTable, eq(organizationsTable.id, salesOrdersTable.organizationId))
    .where(
      and(
        eq(salesOrdersTable.id, orderId),
        eq(salesOrdersTable.organizationId, orgId),
      ),
    )
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const lineRows = await db
    .select({
      line: salesOrderLinesTable,
      itemId: itemsTable.id,
      itemName: itemsTable.name,
      sku: itemsTable.sku,
      hsnCode: itemsTable.hsnCode,
      unit: itemsTable.unit,
    })
    .from(salesOrderLinesTable)
    .innerJoin(itemsTable, eq(itemsTable.id, salesOrderLinesTable.itemId))
    .where(eq(salesOrderLinesTable.salesOrderId, orderId));
  return {
    id: r.order.id,
    organizationId: r.order.organizationId,
    orderNumber: r.order.orderNumber,
    orderDate: r.order.orderDate,
    status: r.order.status,
    irn: r.order.irn,
    irpStatus: r.order.irpStatus,
    irpAckDate: r.order.irpAckDate,
    customer: {
      id: r.customer.id,
      name: r.customer.name,
      company: r.customer.company,
      gstNumber: r.customer.gstNumber,
      billingAddress: r.customer.billingAddress,
      shippingAddress: r.customer.shippingAddress,
      placeOfSupply: r.customer.placeOfSupply,
      email: r.customer.email,
      phone: r.customer.phone,
    },
    org: {
      name: r.org.name,
      gstNumber: r.org.gstNumber,
      addressLine1: r.org.addressLine1,
      city: r.org.city,
      state: r.org.state,
      postalCode: r.org.postalCode,
      eInvoiceGstin: r.org.eInvoiceGstin,
    },
    totals: {
      subtotal: toNum(r.order.subtotal),
      tax: toNum(r.order.taxTotal),
      total: toNum(r.order.total),
    },
    lines: lineRows.map((l) => ({
      itemId: l.itemId,
      name: l.itemName,
      sku: l.sku,
      description: l.line.description,
      hsnCode: l.hsnCode,
      unit: l.unit ?? "NOS",
      quantity: toNum(l.line.quantity),
      unitPrice: toNum(l.line.unitPrice),
      taxRate: toNum(l.line.taxRate),
      lineSubtotal: toNum(l.line.lineSubtotal),
      lineTax: toNum(l.line.lineTax),
      lineTotal: toNum(l.line.lineTotal),
    })),
  };
}

function parsePincode(text: string | null | undefined): string | null {
  const m = (text ?? "").match(/(?<![0-9])([0-9]{6})(?![0-9])/u);
  return m ? m[1]! : null;
}

function parseCity(text: string | null | undefined): string | null {
  const s = (text ?? "").trim();
  if (!s) return null;
  // Strip pincode then take last alpha token that isn't a known state.
  const sansPin = s.replace(/(?<![0-9])([0-9]{6})(?![0-9])/u, "");
  const tokens = sansPin
    .split(/[,\n]/u)
    .map((t) => t.replace(/[\s\-–—]+$/u, "").trim())
    .filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (!/^[A-Za-z][A-Za-z .'-]+$/u.test(t)) continue;
    if (gstStateCodeFromName(t) != null) continue;
    return t;
  }
  return null;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

interface BuildPayloadResult {
  payload: GenerateIrnInput;
  warnings: string[];
}

/**
 * Translate an order into the IRP `Generate IRN` payload. Throws if
 * the order is missing data the IRP requires (party GSTIN, addresses
 * with PIN, valid HSN codes, etc.). The IRP enforces a tight schema
 * and returns ErrorDetails arrays on validation failure that we
 * surface verbatim to admins, so we err on the side of catching
 * problems locally first.
 */
function buildIrnPayloadFromOrder(order: OrderForIrn): BuildPayloadResult {
  if (!order.customer.gstNumber) {
    throw new EinvoiceApiError(
      400,
      "Customer must have a GSTIN to register a B2B e-invoice.",
      null,
      "missing_buyer_gstin",
    );
  }
  const sellerGstin = order.org.eInvoiceGstin ?? order.org.gstNumber;
  if (!sellerGstin) {
    throw new EinvoiceApiError(
      400,
      "Set your organization GSTIN before generating e-invoices.",
      null,
      "missing_seller_gstin",
    );
  }
  const sellerStateCode = gstStateCodeFromGstin(sellerGstin);
  const buyerStateCode =
    gstStateCodeFromName(order.customer.placeOfSupply) ??
    gstStateCodeFromGstin(order.customer.gstNumber);
  if (!sellerStateCode) {
    throw new EinvoiceApiError(
      400,
      "Could not derive your state code from the GSTIN.",
      null,
      "invalid_seller_gstin",
    );
  }
  if (!buyerStateCode) {
    throw new EinvoiceApiError(
      400,
      "Could not derive the buyer's state code. Set the customer's place of supply.",
      null,
      "invalid_buyer_state",
    );
  }
  const sellerPincode = parsePincode(order.org.postalCode) ??
    parsePincode(order.org.addressLine1);
  const buyerPincode =
    parsePincode(order.customer.billingAddress) ??
    parsePincode(order.customer.shippingAddress);
  if (!sellerPincode) {
    throw new EinvoiceApiError(
      400,
      "Set a valid 6-digit PIN code on your organization address.",
      null,
      "missing_seller_pincode",
    );
  }
  if (!buyerPincode) {
    throw new EinvoiceApiError(
      400,
      "The customer's address must include a 6-digit PIN code.",
      null,
      "missing_buyer_pincode",
    );
  }
  const warnings: string[] = [];
  for (const line of order.lines) {
    if (!line.hsnCode || !/^[0-9]{4,8}$/u.test(line.hsnCode)) {
      throw new EinvoiceApiError(
        400,
        `Item "${line.name}" needs a valid 4-8 digit HSN code before it can be reported on an e-invoice.`,
        null,
        "invalid_hsn",
        { itemId: line.itemId, itemName: line.name },
      );
    }
  }

  const sameState = sellerStateCode === buyerStateCode;

  const items: IrpItem[] = order.lines.map((l, idx) => {
    const taxRate = l.taxRate;
    const cgst = sameState ? round2(l.lineTax / 2) : 0;
    const sgst = sameState ? l.lineTax - cgst : 0; // make halves sum exactly
    const igst = sameState ? 0 : round2(l.lineTax);
    return {
      serialNumber: String(idx + 1),
      productName: l.name.slice(0, 100),
      productDesc: (l.description ?? l.name).slice(0, 300),
      hsnCode: l.hsnCode!,
      quantity: l.quantity,
      unit: (l.unit || "NOS").toUpperCase().slice(0, 8),
      unitPrice: l.unitPrice,
      taxableValue: l.lineSubtotal,
      gstRate: taxRate,
      cgstAmount: cgst,
      sgstAmount: sgst,
      igstAmount: igst,
      cessAmount: 0,
      totalItemValue: l.lineTotal,
    };
  });

  const cgstTotal = items.reduce((s, i) => s + i.cgstAmount, 0);
  const sgstTotal = items.reduce((s, i) => s + i.sgstAmount, 0);
  const igstTotal = items.reduce((s, i) => s + i.igstAmount, 0);

  const dt = new Date(order.orderDate + "T00:00:00Z");
  const docDate = `${pad2(dt.getUTCDate())}/${pad2(
    dt.getUTCMonth() + 1,
  )}/${dt.getUTCFullYear()}`;

  const seller: IrpAddress = {
    legalName: order.org.name,
    gstin: sellerGstin,
    addressLine1: (order.org.addressLine1 ?? "").slice(0, 100) || order.org.name,
    location: parseCity(order.org.addressLine1) ?? order.org.city ?? "",
    pincode: sellerPincode,
    stateCode: pad2(sellerStateCode),
  };
  const buyer: IrpAddress = {
    legalName: order.customer.company ?? order.customer.name,
    gstin: order.customer.gstNumber,
    addressLine1: (
      order.customer.billingAddress ??
      order.customer.shippingAddress ??
      order.customer.name
    ).slice(0, 100),
    location:
      parseCity(order.customer.billingAddress) ??
      parseCity(order.customer.shippingAddress) ??
      order.customer.placeOfSupply ??
      "",
    pincode: buyerPincode,
    stateCode: pad2(buyerStateCode),
    email: order.customer.email,
    phone: order.customer.phone,
  };

  if (!seller.location) {
    throw new EinvoiceApiError(
      400,
      "Could not derive your city from the organization address.",
      null,
      "missing_seller_city",
    );
  }
  if (!buyer.location) {
    throw new EinvoiceApiError(
      400,
      "Could not derive the customer's city. Add it to the billing address.",
      null,
      "missing_buyer_city",
    );
  }

  return {
    payload: {
      docType: "INV",
      docNumber: order.orderNumber,
      docDate,
      supplyType: "B2B",
      seller,
      buyer,
      items,
      totals: {
        assessableValue: round2(order.totals.subtotal),
        cgstValue: round2(cgstTotal),
        sgstValue: round2(sgstTotal),
        igstValue: round2(igstTotal),
        cessValue: 0,
        totalInvoiceValue: round2(order.totals.total),
      },
    },
    warnings,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ──────────────────────────────────────────────────────────────────────
// Auto-generate hook (called from the sales-order status route)
// ──────────────────────────────────────────────────────────────────────

/**
 * Best-effort attempt to register an IRN for an order that has just
 * transitioned to `invoiced`. We attempt synchronously (so a fast
 * IRP response can be reflected in the immediate detail payload),
 * but the whole call is wrapped in a bounded total-time budget and
 * a small retry policy: failures are persisted as `irpStatus =
 * "failed"` and the underlying status transition is never blocked
 * or rolled back.
 */

// Hard ceiling on the total time the auto-hook is allowed to spend
// inside the status-transition request. Picked so that even a
// retried, slow IRP response stays well within the user's
// patience window for "I clicked Mark as invoiced".
const AUTO_GENERATE_TOTAL_BUDGET_MS = 12_000;
const AUTO_GENERATE_MAX_ATTEMPTS = 2;
const AUTO_GENERATE_RETRY_BACKOFF_MS = 500;

export async function tryAutoGenerateIrn(
  orgId: number,
  orderId: number,
): Promise<void> {
  const deadline = Date.now() + AUTO_GENERATE_TOTAL_BUDGET_MS;
  try {
    await Promise.race([
      runAutoGenerate(orgId, orderId, deadline),
      new Promise<void>((resolve) =>
        setTimeout(resolve, AUTO_GENERATE_TOTAL_BUDGET_MS),
      ).then(async () => {
        // Budget exhausted before any attempt resolved. Mark the
        // order so the UI shows a Retry — the in-flight promise
        // will continue in the background and may yet succeed,
        // but we will not wait for it.
        await db
          .update(salesOrdersTable)
          .set({
            irpStatus: "failed",
            irpError:
              "IRP did not respond within the allotted time. Press Retry to try again.",
            irpErrorCode: "einvoice_upstream_failed",
            irpErrorContext: null,
          })
          .where(
            and(
              eq(salesOrdersTable.id, orderId),
              eq(salesOrdersTable.organizationId, orgId),
              eq(salesOrdersTable.irpStatus, "pending"),
            ),
          );
        logger.warn(
          { orgId, orderId, budgetMs: AUTO_GENERATE_TOTAL_BUDGET_MS },
          "einvoice: auto-generate exceeded time budget",
        );
      }),
    ]);
  } catch (err) {
    logger.error(
      { orgId, orderId, err },
      "einvoice: auto-generate hook crashed (non-fatal)",
    );
  }
}

async function runAutoGenerate(
  orgId: number,
  orderId: number,
  deadline: number,
): Promise<void> {
  const orgRows = await db
    .select({
      enabled: organizationsTable.eInvoiceEnabled,
      gstin: organizationsTable.eInvoiceGstin,
      passwordEncrypted: organizationsTable.eInvoiceApiPasswordEncrypted,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId))
    .limit(1);
  const org = orgRows[0];
  if (!org?.enabled || !org.gstin || !org.passwordEncrypted) {
    return; // not configured / disabled — silently skip
  }
  const order = await loadOrderForIrn(orgId, orderId);
  if (!order) return;
  if (!order.customer.gstNumber) return; // B2C — feature is opt-out for B2C
  if (order.irn && order.irpStatus === "active") return; // already issued
  // Mark the order as pending so the UI reflects the in-flight
  // attempt (and concurrent generate calls see the claim).
  await db
    .update(salesOrdersTable)
    .set({
      irpStatus: "pending",
      irpError: null,
      irpErrorCode: null,
      irpErrorContext: null,
    })
    .where(eq(salesOrdersTable.id, orderId));
  await persistIrnAttempt(orgId, orderId, order, deadline);
}

/**
 * Decide whether an error from the IRP is worth retrying. Local
 * validation failures (4xx EinvoiceApiError) and authentication
 * problems will fail the same way every time — only network
 * timeouts, 5xx, and unknown errors get a second attempt.
 */
function isRetryableEinvoiceError(err: unknown): boolean {
  if (err instanceof EinvoiceNotConnectedError) return false;
  if (err instanceof EinvoiceAuthError) return false;
  if (err instanceof EinvoiceApiError) {
    return err.status >= 500 || err.status === 0;
  }
  // Network failures, AbortError from the timeout signal, etc.
  return true;
}

async function persistIrnAttempt(
  orgId: number,
  orderId: number,
  order: OrderForIrn,
  deadline: number,
): Promise<void> {
  let payload: GenerateIrnInput;
  try {
    payload = buildIrnPayloadFromOrder(order).payload;
  } catch (err) {
    if (err instanceof EinvoiceApiError) {
      await db
        .update(salesOrdersTable)
        .set({ irpStatus: "failed", ...persistedErrorFields(err) })
        .where(eq(salesOrdersTable.id, orderId));
      return;
    }
    throw err;
  }

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= AUTO_GENERATE_MAX_ATTEMPTS; attempt++) {
    if (Date.now() >= deadline) break;
    try {
      const result = await generateIrn(orgId, payload);
      await db
        .update(salesOrdersTable)
        .set({
          irn: result.irn,
          irpAckNumber: result.ackNumber,
          irpAckDate: parseIrpAckDate(result.ackDate) ?? new Date(),
          irpQrPayload: result.signedQrCode,
          irpStatus: "active",
          irpError: null,
          irpErrorCode: null,
          irpErrorContext: null,
          irpCancelledAt: null,
          irpCancelReason: null,
        })
        .where(eq(salesOrdersTable.id, orderId));
      return;
    } catch (err) {
      lastErr = err;
      if (
        attempt < AUTO_GENERATE_MAX_ATTEMPTS &&
        isRetryableEinvoiceError(err) &&
        Date.now() + AUTO_GENERATE_RETRY_BACKOFF_MS < deadline
      ) {
        logger.info(
          { orgId, orderId, attempt, err: err instanceof Error ? err.message : String(err) },
          "einvoice: auto-generate transient failure — retrying",
        );
        await new Promise((r) => setTimeout(r, AUTO_GENERATE_RETRY_BACKOFF_MS));
        continue;
      }
      break;
    }
  }
  await db
    .update(salesOrdersTable)
    .set({ irpStatus: "failed", ...persistedErrorFields(lastErr) })
    .where(eq(salesOrdersTable.id, orderId));
  logger.warn(
    {
      orgId,
      orderId,
      err: lastErr instanceof Error ? lastErr.message : String(lastErr),
    },
    "einvoice: auto-generate failed after retries — order flagged irpStatus=failed",
  );
}

// ──────────────────────────────────────────────────────────────────────
// Per-order routes
// ──────────────────────────────────────────────────────────────────────

router.post("/sales-orders/:id/einvoice/generate", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const paramParse = idParamSchema.safeParse(req.params);
    if (!paramParse.success) {
      sendZodError(res, paramParse.error);
      return;
    }
    const { id } = paramParse.data;

    // Idempotent claim: atomically transition irpStatus from
    // {null, failed} → "pending". If two requests race to register
    // the same invoice, only one will hold the claim and proceed to
    // hit the IRP — the other gets a 409 immediately. We also
    // reject the claim outright if the order isn't in an
    // IRN-eligible status, so we don't waste an IRP round-trip.
    const claim = await db
      .update(salesOrdersTable)
      .set({
        irpStatus: "pending",
        irpError: null,
        irpErrorCode: null,
        irpErrorContext: null,
      })
      .where(
        and(
          eq(salesOrdersTable.id, id),
          eq(salesOrdersTable.organizationId, t.organizationId),
          inArray(salesOrdersTable.status, [
            "shipped",
            "delivered",
            "invoiced",
            "paid",
          ]),
          // Eligible starting states: never attempted (null), the
          // last attempt failed and the operator is retrying, or
          // the previous IRN was cancelled at the IRP and the
          // local IRN fields have been cleared so we can register
          // a fresh one.
          or(
            isNull(salesOrdersTable.irpStatus),
            eq(salesOrdersTable.irpStatus, "failed"),
            eq(salesOrdersTable.irpStatus, "cancelled"),
          ),
        ),
      )
      .returning({ id: salesOrdersTable.id });
    if (claim.length === 0) {
      // Either the order doesn't exist for this tenant, isn't in an
      // eligible status, or already has an active/pending/cancelled
      // IRN. Tell the caller which (best-effort) by reading the
      // order back, but never start a second IRP submission.
      const order = await loadOrderForIrn(t.organizationId, id);
      if (!order) {
        res.status(404).json({ error: "Sales order not found" });
        return;
      }
      if (order.irn && order.irpStatus === "active") {
        res.status(409).json({
          error:
            "An active IRN already exists for this order. Cancel it (within 24h) before re-registering.",
          code: "irn_already_issued",
        });
        return;
      }
      if (order.irpStatus === "pending") {
        res.status(409).json({
          error: "An IRN registration is already in flight for this order.",
          code: "irn_in_flight",
        });
        return;
      }
      if (order.irpStatus === "cancelled") {
        res.status(400).json({
          error:
            "This invoice was already cancelled at the IRP. Issue a credit note instead.",
          code: "irn_cancelled",
        });
        return;
      }
      res.status(400).json({
        error: `E-invoice can only be registered after the order has shipped. Current status: ${order.status}.`,
        code: "ineligible_status",
      });
      return;
    }

    // Claim held — load the order details and proceed.
    const order = await loadOrderForIrn(t.organizationId, id);
    if (!order) {
      // Race: order was deleted between claim and load.
      res.status(404).json({ error: "Sales order not found" });
      return;
    }

    let payload: GenerateIrnInput;
    try {
      payload = buildIrnPayloadFromOrder(order).payload;
    } catch (err) {
      // Local validation failure — surface it but also flag the
      // order so the UI shows the same message even after a refresh.
      await db
        .update(salesOrdersTable)
        .set({ irpStatus: "failed", ...persistedErrorFields(err) })
        .where(eq(salesOrdersTable.id, id));
      if (
        handleEinvoiceError(err, res, {
          orgId: t.organizationId,
          op: "generate",
          orderId: id,
        })
      ) {
        return;
      }
      throw err;
    }
    try {
      const result = await generateIrn(t.organizationId, payload);
      await db
        .update(salesOrdersTable)
        .set({
          irn: result.irn,
          irpAckNumber: result.ackNumber,
          irpAckDate: parseIrpAckDate(result.ackDate) ?? new Date(),
          irpQrPayload: result.signedQrCode,
          irpStatus: "active",
          irpError: null,
          irpErrorCode: null,
          irpErrorContext: null,
          irpCancelledAt: null,
          irpCancelReason: null,
        })
        .where(eq(salesOrdersTable.id, id));
      res.json({
        ok: true,
        irn: result.irn,
        ackNumber: result.ackNumber,
        ackDate: result.ackDate,
      });
    } catch (err) {
      await db
        .update(salesOrdersTable)
        .set({ irpStatus: "failed", ...persistedErrorFields(err) })
        .where(eq(salesOrdersTable.id, id));
      if (
        handleEinvoiceError(err, res, {
          orgId: t.organizationId,
          op: "generate",
          orderId: id,
        })
      ) {
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.post("/sales-orders/:id/einvoice/cancel", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const paramParse = idParamSchema.safeParse(req.params);
    if (!paramParse.success) {
      sendZodError(res, paramParse.error);
      return;
    }
    const bodyParse = cancelIrnSchema.safeParse(req.body ?? {});
    if (!bodyParse.success) {
      sendZodError(res, bodyParse.error);
      return;
    }
    const { id } = paramParse.data;
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
    if (!order.irn || order.irpStatus !== "active") {
      res.status(400).json({
        error: "There is no active IRN to cancel for this order.",
        code: "no_active_irn",
      });
      return;
    }
    if (!isIrpCancellable(order.irpAckDate)) {
      res.status(400).json({
        error:
          "IRN cancellation is only allowed within 24 hours of acknowledgement. Issue a credit note instead.",
        code: "cancel_window_expired",
      });
      return;
    }
    const reasonCode = bodyParse.data.reasonCode as IrpCancelReason;
    const reasonRemark = bodyParse.data.reasonRemark;
    try {
      const result = await cancelIrn(t.organizationId, {
        irn: order.irn,
        reasonCode,
        reasonRemark,
      });
      const cancelledAt = parseIrpAckDate(result.cancelledAt) ?? new Date();
      // Successful cancellation reverses the local IRN state so the
      // order is no longer treated as e-invoiced: the IRN, ack
      // metadata, and signed QR are cleared (the printed PDF and
      // serialized payload should not present a cancelled invoice
      // as legally valid). The cancellation audit fields
      // (irpCancelledAt, irpCancelReason, irpStatus="cancelled")
      // are kept so the operator can see what happened, and the
      // order becomes eligible to register a fresh IRN.
      await db
        .update(salesOrdersTable)
        .set({
          irn: null,
          irpAckNumber: null,
          irpAckDate: null,
          irpQrPayload: null,
          irpStatus: "cancelled",
          irpCancelledAt: cancelledAt,
          irpCancelReason: reasonRemark,
          irpError: null,
          irpErrorCode: null,
          irpErrorContext: null,
        })
        .where(eq(salesOrdersTable.id, id));
      res.json({ ok: true, cancelledAt: cancelledAt.toISOString() });
    } catch (err) {
      if (
        handleEinvoiceError(err, res, {
          orgId: t.organizationId,
          op: "cancel",
          orderId: id,
        })
      ) {
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.get("/sales-orders/:id/einvoice/qr.png", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const paramParse = idParamSchema.safeParse(req.params);
    if (!paramParse.success) {
      sendZodError(res, paramParse.error);
      return;
    }
    const { id } = paramParse.data;
    const rows = await db
      .select({
        qr: salesOrdersTable.irpQrPayload,
        status: salesOrdersTable.irpStatus,
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
    if (!row?.qr) {
      res.status(404).json({ error: "No IRN QR is available for this order." });
      return;
    }
    const png = await QRCode.toBuffer(row.qr, {
      type: "png",
      errorCorrectionLevel: "M",
      margin: 1,
      width: 320,
    });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(png);
  } catch (err) {
    next(err);
  }
});

export default router;
