import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
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
  type IrpCancelReason,
  type GenerateIrnInput,
} from "../lib/einvoice";
import {
  buildIrnPayloadFromOrder,
  type OrderForIrn,
} from "../lib/einvoicePayload";
import QRCode from "qrcode";

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
  // Atomic compare-and-claim: only proceed if no one else (a manual
  // /einvoice/generate call or a parallel status transition) is
  // already mid-flight. The same eligibility filter as the manual
  // route — and crucially excluding `cancelled`, since the IRP
  // will not let us re-register the same invoice number after
  // cancellation. If the claim returns 0 rows, another path holds
  // the lifecycle and we silently bow out.
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
        eq(salesOrdersTable.id, orderId),
        eq(salesOrdersTable.organizationId, orgId),
        or(
          isNull(salesOrdersTable.irpStatus),
          eq(salesOrdersTable.irpStatus, "failed"),
        ),
      ),
    )
    .returning({ id: salesOrdersTable.id });
  if (claim.length === 0) return;
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
          // Eligible starting states: never attempted (null) or the
          // last attempt failed and the operator is retrying. We do
          // NOT include `cancelled` — the IRP refuses to register a
          // second IRN against the same invoice number, so the only
          // legal way to reverse a cancelled invoice is a fresh
          // credit note.
          or(
            isNull(salesOrdersTable.irpStatus),
            eq(salesOrdersTable.irpStatus, "failed"),
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
      // are kept so the operator can see what happened. The IRP
      // refuses to register a second IRN against the same invoice
      // number, so re-registration is intentionally blocked at the
      // generate route — the legal remedy is to issue a credit
      // note against this order.
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

// ──────────────────────────────────────────────────────────────────────
// Bulk e-invoice registration
// ──────────────────────────────────────────────────────────────────────
//
// Operators often invoice a whole day's worth of B2B orders in one go.
// Doing it order-by-order requires N round-trips to the IRP and N
// clicks; the bulk endpoint accepts a list of sales-order IDs,
// classifies each up front (eligible / already-issued / ineligible /
// unknown), spawns a background job, and exposes a status endpoint
// the UI polls for live progress + per-order pass/fail rows.
//
// Per-order processing reuses the same primitives the single-order
// route uses (`buildIrnPayloadFromOrder`, `generateIrn`, the same
// idempotent CAS on `sales_orders.irpStatus`). That guarantees the
// bulk job can never race with the single-order route or the
// auto-hook: only one of them claims a given order at a time, and
// every other claimant sees the in-flight or final state.
//
// Idempotency: re-running the bulk job with the same orderIds skips
// orders whose `irpStatus` is already `"active"` (reported as
// `already_issued`), so retrying a partial-success batch only
// re-attempts the failures.
//
// State storage: an in-memory Map keyed by batch id. Each entry has
// a TTL — long enough for the operator to view the result page and
// retry once, short enough to avoid an unbounded leak in long-lived
// API processes. Batches are scoped per organization; cross-tenant
// reads return 404.

type BulkResultStatus =
  // Terminal: IRP accepted the invoice (or it was already active and
  // we deliberately skipped re-attempting).
  | "success"
  | "already_issued"
  // Terminal: the order can never be processed in this batch — wrong
  // status, missing GSTIN, or the org isn't connected.
  | "ineligible"
  // Terminal: a real failure to register at the IRP this attempt.
  | "failed"
  // Terminal: another in-flight attempt held the claim, or the order
  // was cancelled at the IRP (operator must issue a credit note).
  | "skipped"
  // Non-terminal: the worker hasn't gotten to this row yet, or is
  // mid-flight. The worker mutates this in-place as it advances.
  | "pending"
  | "running";

interface BulkResultRow {
  orderId: number;
  orderNumber: string | null;
  status: BulkResultStatus;
  message: string | null;
  errorCode: string | null;
}

interface BulkBatchState {
  id: string;
  organizationId: number;
  createdAt: number; // epoch ms
  completedAt: number | null;
  status: "running" | "completed";
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: Map<number, BulkResultRow>;
  // Insertion order is the display order (the order ids the caller
  // submitted, deduped). We materialise this from the Map's iteration
  // order, which preserves insertion order for non-numeric-but-here-
  // numeric keys; keep a parallel array for an explicit guarantee.
  orderIdsInOrder: number[];
}

// Process-local store. The state is small (<=1000 rows × a few
// strings) and the SMB user expects to see the result of their own
// click within minutes — there's no operator value in surviving an
// API restart, and persisting intermediate state to the DB would
// duplicate what `sales_orders.irpStatus` already records. If the
// process restarts mid-batch the per-order writes that already
// landed are still in `sales_orders`, and the operator can re-run
// the bulk action; only the volatile batch summary is lost.
const bulkBatches = new Map<string, BulkBatchState>();

const BULK_BATCH_TTL_MS = 60 * 60 * 1000; // 1 hour
const BULK_MAX_ORDERS = 200;
// Sequential by default. The IRP enforces account-level rate limits
// and parallel calls don't reliably help; serial keeps the load
// predictable and the failure modes simple. If a tenant ever needs
// throughput we can lift this carefully.
const BULK_CONCURRENCY = 1;

function pruneStaleBatches(now: number = Date.now()): void {
  for (const [id, b] of bulkBatches) {
    if (
      b.status === "completed" &&
      b.completedAt != null &&
      now - b.completedAt > BULK_BATCH_TTL_MS
    ) {
      bulkBatches.delete(id);
    } else if (now - b.createdAt > 4 * BULK_BATCH_TTL_MS) {
      // Hard ceiling — even a stuck "running" batch shouldn't live
      // forever. 4× TTL is a generous bound on the longest plausible
      // run (sequential × max orders × per-call timeout).
      bulkBatches.delete(id);
    }
  }
}

function serializeBulkBatch(b: BulkBatchState) {
  return {
    id: b.id,
    status: b.status,
    createdAt: new Date(b.createdAt).toISOString(),
    completedAt:
      b.completedAt != null ? new Date(b.completedAt).toISOString() : null,
    total: b.total,
    processed: b.processed,
    succeeded: b.succeeded,
    failed: b.failed,
    skipped: b.skipped,
    results: b.orderIdsInOrder.map((id) => b.results.get(id)!),
  };
}

const bulkRequestSchema = z.object({
  orderIds: z
    .array(z.number().int().positive())
    .min(1, "Pick at least one order to register")
    .max(
      BULK_MAX_ORDERS,
      `Pick at most ${BULK_MAX_ORDERS} orders per bulk run`,
    ),
});

/**
 * Attempt to register an IRN for a single order as part of a bulk
 * batch. Returns a structured result instead of writing an HTTP
 * response; updates `sales_orders.irpStatus` and friends the same
 * way the single-order route does (so the SalesOrderDetail page
 * reflects the result regardless of how the IRN was registered).
 */
async function processOrderForBulk(
  orgId: number,
  orderId: number,
): Promise<Omit<BulkResultRow, "orderId">> {
  // Idempotent claim: same CAS the single-order route uses. If the
  // claim fails we read the current state and translate it into a
  // result row — never start a duplicate IRP submission.
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
        eq(salesOrdersTable.id, orderId),
        eq(salesOrdersTable.organizationId, orgId),
        inArray(salesOrdersTable.status, [
          "shipped",
          "delivered",
          "invoiced",
          "paid",
        ]),
        or(
          isNull(salesOrdersTable.irpStatus),
          eq(salesOrdersTable.irpStatus, "failed"),
          eq(salesOrdersTable.irpStatus, "cancelled"),
        ),
      ),
    )
    .returning({ id: salesOrdersTable.id, orderNumber: salesOrdersTable.orderNumber });

  if (claim.length === 0) {
    const order = await loadOrderForIrn(orgId, orderId);
    if (!order) {
      return {
        orderNumber: null,
        status: "ineligible",
        message: "Sales order not found",
        errorCode: "not_found",
      };
    }
    if (order.irn && order.irpStatus === "active") {
      return {
        orderNumber: order.orderNumber,
        status: "already_issued",
        message: "An active IRN already exists for this order.",
        errorCode: "irn_already_issued",
      };
    }
    if (order.irpStatus === "pending") {
      return {
        orderNumber: order.orderNumber,
        status: "skipped",
        message: "Another IRN registration is already in flight.",
        errorCode: "irn_in_flight",
      };
    }
    if (order.irpStatus === "cancelled") {
      return {
        orderNumber: order.orderNumber,
        status: "skipped",
        message:
          "This invoice was already cancelled at the IRP. Issue a credit note instead.",
        errorCode: "irn_cancelled",
      };
    }
    return {
      orderNumber: order.orderNumber,
      status: "ineligible",
      message: `E-invoice can only be registered after the order has shipped. Current status: ${order.status}.`,
      errorCode: "ineligible_status",
    };
  }

  const orderNumber = claim[0]!.orderNumber;
  const order = await loadOrderForIrn(orgId, orderId);
  if (!order) {
    // Race: deleted between claim and load. Leave the pending claim
    // in place — the row no longer exists so it can't matter.
    return {
      orderNumber,
      status: "ineligible",
      message: "Sales order not found",
      errorCode: "not_found",
    };
  }

  let payload: GenerateIrnInput;
  try {
    payload = buildIrnPayloadFromOrder(order).payload;
  } catch (err) {
    const fields = persistedErrorFields(err);
    await db
      .update(salesOrdersTable)
      .set({ irpStatus: "failed", ...fields })
      .where(eq(salesOrdersTable.id, orderId));
    logger.warn(
      { orgId, orderId, err: err instanceof Error ? err.message : String(err) },
      "einvoice: bulk per-order payload build failed",
    );
    return {
      orderNumber,
      status: "failed",
      message: fields.irpError,
      errorCode: fields.irpErrorCode,
    };
  }

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
    return {
      orderNumber,
      status: "success",
      message: `IRN ${result.irn}`,
      errorCode: null,
    };
  } catch (err) {
    const fields = persistedErrorFields(err);
    await db
      .update(salesOrdersTable)
      .set({ irpStatus: "failed", ...fields })
      .where(eq(salesOrdersTable.id, orderId));
    logger.warn(
      {
        orgId,
        orderId,
        err: err instanceof Error ? err.message : String(err),
      },
      "einvoice: bulk per-order IRP call failed",
    );
    return {
      orderNumber,
      status: "failed",
      message: fields.irpError,
      errorCode: fields.irpErrorCode,
    };
  }
}

/**
 * Background worker for a bulk batch. Mutates the batch state
 * in-place as it advances; the GET endpoint polls the same Map.
 */
async function runBulkBatch(batch: BulkBatchState): Promise<void> {
  try {
    // Concurrency=1 today; if we ever raise it, slice the work list
    // into BULK_CONCURRENCY parallel workers and Promise.all them.
    void BULK_CONCURRENCY;
    for (const orderId of batch.orderIdsInOrder) {
      const row = batch.results.get(orderId)!;
      // Skip rows the classifier already settled (e.g. ineligible
      // ahead of time so the UI shows the verdict instantly).
      if (row.status !== "pending") continue;
      row.status = "running";
      try {
        const out = await processOrderForBulk(batch.organizationId, orderId);
        row.status = out.status;
        row.message = out.message;
        row.errorCode = out.errorCode;
        if (out.orderNumber) row.orderNumber = out.orderNumber;
      } catch (err) {
        // Catch-all so one row's crash doesn't kill the whole batch.
        logger.error(
          { orgId: batch.organizationId, orderId, err },
          "einvoice: bulk worker crashed on a row (continuing)",
        );
        row.status = "failed";
        row.message =
          err instanceof Error ? err.message : "Unexpected worker error";
        row.errorCode = "worker_crashed";
      }
      tallyRow(batch, row);
      batch.processed += 1;
    }
  } finally {
    batch.status = "completed";
    batch.completedAt = Date.now();
  }
}

function tallyRow(batch: BulkBatchState, row: BulkResultRow): void {
  switch (row.status) {
    case "success":
    case "already_issued":
      batch.succeeded += 1;
      return;
    case "failed":
      batch.failed += 1;
      return;
    case "skipped":
    case "ineligible":
      batch.skipped += 1;
      return;
    default:
      // pending/running shouldn't reach here; only call after a row
      // has settled.
      return;
  }
}

/**
 * Look up every requested order in one DB hit and pre-classify each
 * row. Orders the caller submitted that don't belong to this tenant
 * are reported as `ineligible` with a "not found" message — never
 * leak the existence of cross-tenant rows.
 */
async function classifyBulkOrders(
  orgId: number,
  requestedIds: number[],
  connectedAndEnabled: boolean,
): Promise<{
  rows: Map<number, BulkResultRow>;
  orderIdsInOrder: number[];
}> {
  // Dedupe but preserve first-seen order so the UI rows stay stable.
  const seen = new Set<number>();
  const orderIdsInOrder: number[] = [];
  for (const id of requestedIds) {
    if (!seen.has(id)) {
      seen.add(id);
      orderIdsInOrder.push(id);
    }
  }
  const lookups = await db
    .select({
      id: salesOrdersTable.id,
      orderNumber: salesOrdersTable.orderNumber,
      status: salesOrdersTable.status,
      irpStatus: salesOrdersTable.irpStatus,
      irn: salesOrdersTable.irn,
      customerGstNumber: customersTable.gstNumber,
    })
    .from(salesOrdersTable)
    .innerJoin(
      customersTable,
      eq(customersTable.id, salesOrdersTable.customerId),
    )
    .where(
      and(
        eq(salesOrdersTable.organizationId, orgId),
        inArray(salesOrdersTable.id, orderIdsInOrder),
      ),
    );
  const byId = new Map(lookups.map((r) => [r.id, r]));
  const rows = new Map<number, BulkResultRow>();
  for (const id of orderIdsInOrder) {
    const r = byId.get(id);
    if (!r) {
      rows.set(id, {
        orderId: id,
        orderNumber: null,
        status: "ineligible",
        message: "Sales order not found",
        errorCode: "not_found",
      });
      continue;
    }
    if (!connectedAndEnabled) {
      rows.set(id, {
        orderId: id,
        orderNumber: r.orderNumber,
        status: "ineligible",
        message: "E-invoicing is not connected or is disabled.",
        errorCode: "einvoice_not_connected",
      });
      continue;
    }
    if (
      !["shipped", "delivered", "invoiced", "paid"].includes(r.status)
    ) {
      rows.set(id, {
        orderId: id,
        orderNumber: r.orderNumber,
        status: "ineligible",
        message: `E-invoice can only be registered after the order has shipped. Current status: ${r.status}.`,
        errorCode: "ineligible_status",
      });
      continue;
    }
    if (!r.customerGstNumber) {
      rows.set(id, {
        orderId: id,
        orderNumber: r.orderNumber,
        status: "ineligible",
        message: "Customer has no GSTIN — IRN is only required for B2B.",
        errorCode: "missing_buyer_gstin",
      });
      continue;
    }
    if (r.irn && r.irpStatus === "active") {
      // Already issued — skip ahead of time so the UI shows it
      // instantly without spending a worker slot. This is what
      // makes a re-run on a partial-success batch only re-attempt
      // the failures.
      rows.set(id, {
        orderId: id,
        orderNumber: r.orderNumber,
        status: "already_issued",
        message: "An active IRN already exists for this order.",
        errorCode: "irn_already_issued",
      });
      continue;
    }
    if (r.irpStatus === "pending") {
      rows.set(id, {
        orderId: id,
        orderNumber: r.orderNumber,
        status: "skipped",
        message: "Another IRN registration is already in flight.",
        errorCode: "irn_in_flight",
      });
      continue;
    }
    if (r.irpStatus === "cancelled") {
      rows.set(id, {
        orderId: id,
        orderNumber: r.orderNumber,
        status: "skipped",
        message:
          "This invoice was already cancelled at the IRP. Issue a credit note instead.",
        errorCode: "irn_cancelled",
      });
      continue;
    }
    // Eligible — leave it pending for the worker.
    rows.set(id, {
      orderId: id,
      orderNumber: r.orderNumber,
      status: "pending",
      message: null,
      errorCode: null,
    });
  }
  return { rows, orderIdsInOrder };
}

router.post("/einvoice/bulk", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const parsed = bulkRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodError(res, parsed.error);
      return;
    }
    const orgRows = await db
      .select({
        enabled: organizationsTable.eInvoiceEnabled,
        gstin: organizationsTable.eInvoiceGstin,
        passwordEncrypted: organizationsTable.eInvoiceApiPasswordEncrypted,
      })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, t.organizationId))
      .limit(1);
    const org = orgRows[0];
    const connected = !!(org?.gstin && org.passwordEncrypted);
    const connectedAndEnabled = !!(connected && org?.enabled);
    if (!connected) {
      res.status(400).json({
        error: "E-invoice is not configured for this organization.",
        code: "einvoice_not_connected",
      });
      return;
    }
    if (!org?.enabled) {
      res.status(400).json({
        error:
          "E-invoicing is currently disabled for this organization. Enable it before running a bulk registration.",
        code: "einvoice_disabled",
      });
      return;
    }

    const { rows, orderIdsInOrder } = await classifyBulkOrders(
      t.organizationId,
      parsed.data.orderIds,
      connectedAndEnabled,
    );

    pruneStaleBatches();
    const batch: BulkBatchState = {
      id: randomUUID(),
      organizationId: t.organizationId,
      createdAt: Date.now(),
      completedAt: null,
      status: "running",
      total: orderIdsInOrder.length,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      results: rows,
      orderIdsInOrder,
    };
    // Tally rows the classifier already settled so the initial GET
    // shows accurate counts (and `processed` reflects real progress).
    for (const id of orderIdsInOrder) {
      const r = rows.get(id)!;
      if (r.status !== "pending" && r.status !== "running") {
        tallyRow(batch, r);
        batch.processed += 1;
      }
    }
    bulkBatches.set(batch.id, batch);

    // Fire-and-forget the worker. We deliberately never `await` it
    // here; the response goes back immediately and the UI polls the
    // GET endpoint for progress. Any uncaught error inside is
    // already swallowed by `runBulkBatch`'s try/finally.
    void runBulkBatch(batch);

    res.status(202).json(serializeBulkBatch(batch));
  } catch (err) {
    next(err);
  }
});

const bulkBatchIdParamSchema = z.object({
  batchId: z.string().min(1),
});

router.get("/einvoice/bulk/:batchId", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const parsed = bulkBatchIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      sendZodError(res, parsed.error);
      return;
    }
    pruneStaleBatches();
    const batch = bulkBatches.get(parsed.data.batchId);
    // Scope strictly per-org: don't even acknowledge cross-tenant
    // batch ids exist.
    if (!batch || batch.organizationId !== t.organizationId) {
      res.status(404).json({ error: "Bulk batch not found or expired" });
      return;
    }
    res.json(serializeBulkBatch(batch));
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
