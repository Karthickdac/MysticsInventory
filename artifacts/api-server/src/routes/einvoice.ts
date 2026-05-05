import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
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
  einvoiceBulkBatchesTable,
  type EinvoiceBulkBatch,
  type BulkResultRow,
  type BulkResultStatus,
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
    irpAckNumber: r.order.irpAckNumber,
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
        .where(
          and(
            eq(salesOrdersTable.id, orderId),
            eq(salesOrdersTable.organizationId, orgId),
          ),
        );
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
        .where(
          and(
            eq(salesOrdersTable.id, orderId),
            eq(salesOrdersTable.organizationId, orgId),
          ),
        );
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
    .where(
      and(
        eq(salesOrdersTable.id, orderId),
        eq(salesOrdersTable.organizationId, orgId),
      ),
    );
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
        .where(
          and(
            eq(salesOrdersTable.id, id),
            eq(salesOrdersTable.organizationId, t.organizationId),
          ),
        );
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
        .where(
          and(
            eq(salesOrdersTable.id, id),
            eq(salesOrdersTable.organizationId, t.organizationId),
          ),
        );
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
        .where(
          and(
            eq(salesOrdersTable.id, id),
            eq(salesOrdersTable.organizationId, t.organizationId),
          ),
        );
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
        .where(
          and(
            eq(salesOrdersTable.id, id),
            eq(salesOrdersTable.organizationId, t.organizationId),
          ),
        );
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

// `BulkResultStatus` and `BulkResultRow` come from `@workspace/db` so
// the persisted jsonb shape and the in-process shape can never drift.

const BULK_BATCH_TTL_MS = 60 * 60 * 1000; // 1 hour after completion
// Hard ceiling — even a stuck "running" batch shouldn't live forever.
// 4× TTL is a generous bound on the longest plausible run (sequential
// × max orders × per-call timeout).
const BULK_BATCH_HARD_TTL_MS = 4 * BULK_BATCH_TTL_MS;
const BULK_MAX_ORDERS = 200;
// Modest in-process fan-out for the bulk worker. The persisted-batch
// refactor made per-row settlement atomic at the DB level (jsonb_set
// against the row's current value, serialised by the row lock), so
// raising concurrency no longer risks lost-update or counter drift.
//
// We default to 3 — comfortably under NIC's documented per-GSTIN
// throughput envelope while still cutting wall-clock time on a
// 100-order batch by ~3×. Overridable via BULK_CONCURRENCY (clamped
// 1..10 so a misconfig can't hammer the IRP).
const BULK_CONCURRENCY_DEFAULT = 3;
const BULK_CONCURRENCY = (() => {
  const raw = process.env["BULK_CONCURRENCY"];
  if (!raw) return BULK_CONCURRENCY_DEFAULT;
  const n = Number.parseInt(raw, 10);
  // Unparseable / non-positive values fall back to the documented
  // default rather than silently downgrading to 1 — operators who
  // typo'd a value should still get the intended throughput.
  if (!Number.isFinite(n) || n < 1) return BULK_CONCURRENCY_DEFAULT;
  if (n > 10) return 10;
  return n;
})();

// Defensive token bucket against the IRP. Even with the concurrency
// cap above, a few orders that resolve quickly back-to-back could
// briefly burst above NIC's rate guidance. Enforcing a minimum
// spacing between submissions caps the average rate to roughly
// 1000 / BULK_IRP_MIN_SPACING_MS calls per second per process,
// independent of how many workers are awake.
//
// Default 150ms ≈ 6.7 RPS cap — well under the documented per-GSTIN
// envelope and harmless to a single-order user click (the spacing
// only gates bulk submissions, not the manual /generate route).
const BULK_IRP_MIN_SPACING_MS_DEFAULT = 150;
const BULK_IRP_MIN_SPACING_MS = (() => {
  const raw = process.env["BULK_IRP_MIN_SPACING_MS"];
  if (!raw) return BULK_IRP_MIN_SPACING_MS_DEFAULT;
  const n = Number.parseInt(raw, 10);
  // Same fallback policy as BULK_CONCURRENCY: typos shouldn't
  // silently disable the spacing guard.
  if (!Number.isFinite(n) || n < 0) return BULK_IRP_MIN_SPACING_MS_DEFAULT;
  if (n > 5000) return 5000;
  return n;
})();

// Monotonic timestamp guarding the next allowed IRP submission. Node
// is single-threaded so the read-then-write is race-free; awaiting
// workers each reserve their slot synchronously before sleeping.
let nextIrpSubmissionAt = 0;
async function awaitIrpSlot(): Promise<void> {
  if (BULK_IRP_MIN_SPACING_MS === 0) return;
  const now = Date.now();
  const slot = Math.max(now, nextIrpSubmissionAt);
  nextIrpSubmissionAt = slot + BULK_IRP_MIN_SPACING_MS;
  const wait = slot - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/**
 * Delete batches that have outlived their TTL.
 *  - Completed batches: kept BULK_BATCH_TTL_MS past their completion
 *    so the operator can come back, see the summary, and retry.
 *  - Any batch (running or otherwise): force-deleted past the hard
 *    ceiling so a wedged worker can never leak rows.
 */
async function pruneStaleBatches(now: Date = new Date()): Promise<void> {
  const completedCutoff = new Date(now.getTime() - BULK_BATCH_TTL_MS);
  const hardCutoff = new Date(now.getTime() - BULK_BATCH_HARD_TTL_MS);
  await db
    // org-scope-allow: TTL-based global cleanup. Bulk-batch rows are an
    // operational queue; expired rows from any tenant are reaped together.
    .delete(einvoiceBulkBatchesTable)
    .where(
      or(
        and(
          eq(einvoiceBulkBatchesTable.status, "completed"),
          lt(einvoiceBulkBatchesTable.completedAt, completedCutoff),
        ),
        lt(einvoiceBulkBatchesTable.createdAt, hardCutoff),
      ),
    );
}

async function loadBulkBatch(
  id: string,
): Promise<EinvoiceBulkBatch | null> {
  const rows = await db
    .select()
    // org-scope-allow: batches are addressed by UUID; org-scoping is enforced
    // at the call sites that present a batch back to a request handler.
    .from(einvoiceBulkBatchesTable)
    .where(eq(einvoiceBulkBatchesTable.id, id))
    .limit(1);
  return rows[0] ?? null;
}

function serializeBulkBatch(b: EinvoiceBulkBatch) {
  // Wall-clock duration (ms). For a completed batch this is the
  // single source of truth that both the operator dialog and the
  // structured completion log derive their headline numbers from.
  // For a still-running batch we leave it null — a partial duration
  // would be misleading next to a partial throughput.
  const durationMs =
    b.completedAt != null
      ? Math.max(0, b.completedAt.getTime() - b.startedAt.getTime())
      : null;
  // Throughput in orders/sec, rounded to 1 decimal so the number
  // surfaces useful precision without pretending to measure
  // sub-tenth-of-a-second jitter. A zero-duration completion (every
  // row was pre-classified — no IRP work) collapses to 0 rather
  // than dividing by zero.
  const ordersPerSecond =
    durationMs != null && durationMs > 0
      ? Math.round((b.processed / (durationMs / 1000)) * 10) / 10
      : durationMs === 0
        ? 0
        : null;
  return {
    id: b.id,
    status: b.status,
    createdAt: b.createdAt.toISOString(),
    startedAt: b.startedAt.toISOString(),
    completedAt: b.completedAt ? b.completedAt.toISOString() : null,
    durationMs,
    ordersPerSecond,
    concurrency: b.concurrency,
    total: b.total,
    processed: b.processed,
    succeeded: b.succeeded,
    failed: b.failed,
    skipped: b.skipped,
    // `orderIdsInOrder` is the canonical display order (the order ids
    // the caller submitted, deduped). Looking up each row from the
    // jsonb map preserves that order even though the map itself is
    // unordered.
    //
    // We normalise the IRN identifiers to explicit `null` here so
    // the serialized shape matches the OpenAPI contract (which
    // marks `irn` / `ackNumber` / `ackDate` as required-and-nullable)
    // even for batches that were persisted before these fields
    // existed in the row schema.
    results: b.orderIdsInOrder.map((id) => {
      const r = b.results[String(id)]!;
      return {
        ...r,
        irn: r.irn ?? null,
        ackNumber: r.ackNumber ?? null,
        ackDate: r.ackDate ?? null,
      };
    }),
  };
}

/**
 * Recompute the per-status counters from the merged results map.
 * Single source of truth so an in-memory tally can never drift from
 * what's actually in the persisted jsonb.
 */
function computeCounters(
  orderIdsInOrder: number[],
  results: Record<string, BulkResultRow>,
): {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
} {
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  for (const id of orderIdsInOrder) {
    const r = results[String(id)];
    if (!r) continue;
    if (r.status === "pending" || r.status === "running") continue;
    processed += 1;
    if (r.status === "success" || r.status === "already_issued") {
      succeeded += 1;
    } else if (r.status === "failed") {
      failed += 1;
    } else if (r.status === "skipped" || r.status === "ineligible") {
      skipped += 1;
    }
  }
  return { processed, succeeded, failed, skipped };
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
        // Surface the existing IRN (and ack identifiers) so the
        // bulk dialog and CSV export show a populated row instead
        // of leaving the IRN column blank — accountants re-running
        // a partial batch shouldn't have to cross-reference the
        // order detail page just to recover the IRN.
        irn: order.irn,
        ackNumber: order.irpAckNumber,
        ackDate: order.irpAckDate ? order.irpAckDate.toISOString() : null,
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
      .where(
        and(
          eq(salesOrdersTable.id, orderId),
          eq(salesOrdersTable.organizationId, orgId),
        ),
      );
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
    // Defensive minimum-spacing gate at the IRP wire call boundary.
    // Pulling it here (rather than at worker admission) means the
    // gate measures real submissions to NIC: variable per-order DB
    // latency before this point doesn't compress the effective rate.
    await awaitIrpSlot();
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
      .where(
        and(
          eq(salesOrdersTable.id, orderId),
          eq(salesOrdersTable.organizationId, orgId),
        ),
      );
    // Echo the IRN/ack data into the row payload too — the dialog
    // historically parses it back out of the message, but having
    // the structured fields makes the CSV export and any future
    // consumers cleaner. The message is preserved unchanged so we
    // don't regress callers (or tests) that read it.
    const ackDateForRow = parseIrpAckDate(result.ackDate) ?? new Date();
    return {
      orderNumber,
      status: "success",
      message: `IRN ${result.irn}`,
      errorCode: null,
      irn: result.irn,
      ackNumber: result.ackNumber,
      ackDate: ackDateForRow.toISOString(),
    };
  } catch (err) {
    const fields = persistedErrorFields(err);
    await db
      .update(salesOrdersTable)
      .set({ irpStatus: "failed", ...fields })
      .where(
        and(
          eq(salesOrdersTable.id, orderId),
          eq(salesOrdersTable.organizationId, orgId),
        ),
      );
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
 * Persist one row's settlement back to the batch row in the DB.
 *
 * Done as a single atomic UPDATE statement. Critical detail: every
 * SET expression references the row's CURRENT `results` value (no
 * pre-fetched snapshot), so Postgres' row-level lock on UPDATE
 * serialises concurrent writers — a second writer waits for the
 * first to commit, then reads the freshly-written jsonb (already
 * containing the first writer's patch) and applies its own
 * jsonb_set on top. No lost updates.
 *
 * The same UPDATE also refreshes `recovery_claimed_at` so the
 * current owner's claim never expires while it's actively making
 * progress; another process will only take over if no row has been
 * persisted for RECOVERY_CLAIM_TTL_MS.
 *
 * If the batch row was pruned mid-run, the UPDATE simply matches no
 * rows and we drop the write silently.
 */
async function persistRowSettlement(
  batchId: string,
  orderId: number,
  row: BulkResultRow,
): Promise<void> {
  const key = String(orderId);
  const rowJson = JSON.stringify(row);
  // org-scope-allow: batch id is a globally unique UUID, so a lookup
  // by id alone targets exactly one tenant's row.
  await db.execute(sql`
    UPDATE einvoice_bulk_batches
    SET
      results = jsonb_set(
        coalesce(results, '{}'::jsonb),
        ARRAY[${key}],
        ${rowJson}::jsonb,
        true
      ),
      processed = (
        SELECT count(*)::int
        FROM jsonb_each(
          jsonb_set(
            coalesce(results, '{}'::jsonb),
            ARRAY[${key}],
            ${rowJson}::jsonb,
            true
          )
        ) v
        WHERE v.value->>'status' NOT IN ('pending', 'running')
      ),
      succeeded = (
        SELECT count(*)::int
        FROM jsonb_each(
          jsonb_set(
            coalesce(results, '{}'::jsonb),
            ARRAY[${key}],
            ${rowJson}::jsonb,
            true
          )
        ) v
        WHERE v.value->>'status' IN ('success', 'already_issued')
      ),
      failed = (
        SELECT count(*)::int
        FROM jsonb_each(
          jsonb_set(
            coalesce(results, '{}'::jsonb),
            ARRAY[${key}],
            ${rowJson}::jsonb,
            true
          )
        ) v
        WHERE v.value->>'status' = 'failed'
      ),
      skipped = (
        SELECT count(*)::int
        FROM jsonb_each(
          jsonb_set(
            coalesce(results, '{}'::jsonb),
            ARRAY[${key}],
            ${rowJson}::jsonb,
            true
          )
        ) v
        WHERE v.value->>'status' IN ('skipped', 'ineligible')
      ),
      recovery_claimed_at = now(),
      updated_at = now()
    WHERE id = ${batchId}
  `);
}

async function markBatchCompleted(batchId: string): Promise<void> {
  const now = new Date();
  // Atomic flip from 'running' to 'completed'. RETURNING * lets us
  // emit a single structured completion log line — operators can
  // grep for `einvoice.bulk.completed` to compare wall-clock time
  // and achieved throughput across runs without scraping the DB.
  const updated = await db
    // org-scope-allow: batch was already claimed by this worker via its UUID;
    // we're flipping status on that exact claimed row.
    .update(einvoiceBulkBatchesTable)
    .set({ status: "completed", completedAt: now, updatedAt: now })
    .where(eq(einvoiceBulkBatchesTable.id, batchId))
    .returning();
  const row = updated[0];
  if (!row) return;
  const durationMs = Math.max(0, now.getTime() - row.startedAt.getTime());
  // Throughput against the rows the worker actually settled. Mirrors
  // the formula in serializeBulkBatch so the log line and the
  // dialog can never disagree.
  const ordersPerSecond =
    durationMs > 0
      ? Math.round((row.processed / (durationMs / 1000)) * 10) / 10
      : 0;
  logger.info(
    {
      event: "einvoice.bulk.completed",
      batchId: row.id,
      orgId: row.organizationId,
      total: row.total,
      processed: row.processed,
      succeeded: row.succeeded,
      failed: row.failed,
      skipped: row.skipped,
      concurrency: row.concurrency,
      startedAt: row.startedAt.toISOString(),
      completedAt: now.toISOString(),
      durationMs,
      ordersPerSecond,
    },
    `einvoice: bulk batch completed in ${(durationMs / 1000).toFixed(1)}s (${ordersPerSecond} orders/s, concurrency ${row.concurrency})`,
  );
}

/**
 * Background worker for a bulk batch. Loads the batch from the DB,
 * iterates the order ids in submission order, and persists each
 * row's settlement back to the DB so progress survives a restart.
 *
 * If the batch row is missing (pruned, or the id is wrong) the
 * worker exits silently — nothing to do.
 */
async function runBulkBatch(batchId: string): Promise<void> {
  let batch: EinvoiceBulkBatch | null = null;
  try {
    batch = await loadBulkBatch(batchId);
    if (!batch) return;

    // Build the work list: only rows the classifier left as "pending"
    // need a worker. Skip everything the up-front classifier settled
    // (ineligible / already_issued / skipped) and anything a previous
    // attempt already finished — recovery re-enters this function
    // after a restart and we don't want to redo finished rows.
    const workIds: number[] = [];
    for (const orderId of batch.orderIdsInOrder) {
      const row = batch.results[String(orderId)];
      if (row && row.status === "pending") workIds.push(orderId);
    }

    if (workIds.length > 0) {
      // Capture for the closure so TS narrows `batch` to non-null in
      // the worker (it can be reassigned to null in the catch path
      // otherwise).
      const orgId = batch.organizationId;
      const initialResults = batch.results;

      // Shared cursor — JS is single-threaded, so the post-increment
      // is atomic between awaits. Each worker grabs the next index
      // synchronously, then yields on the IRP slot / DB await.
      let cursor = 0;
      const concurrency = Math.max(
        1,
        Math.min(BULK_CONCURRENCY, workIds.length),
      );

      const worker = async (): Promise<void> => {
        while (true) {
          const i = cursor++;
          if (i >= workIds.length) return;
          const orderId = workIds[i]!;
          const initialRow = initialResults[String(orderId)]!;
          let settled: BulkResultRow;
          try {
            // Note: the IRP-spacing gate (awaitIrpSlot) is applied
            // inside processOrderForBulk, immediately before the
            // generateIrn wire call. Pulling it down to that point
            // means the gate measures actual submissions to NIC and
            // isn't compressed by the variable DB work that runs
            // before each IRP call.
            const out = await processOrderForBulk(orgId, orderId);
            settled = {
              orderId,
              orderNumber: out.orderNumber ?? initialRow.orderNumber,
              status: out.status,
              message: out.message,
              errorCode: out.errorCode,
              // Carry the IRN identifiers through to the persisted
              // row when the per-order branch produced them. We
              // explicitly normalise to `null` (rather than leaving
              // `undefined`) so the jsonb shape and the OpenAPI
              // contract stay in lockstep — every row carries
              // these keys, populated for success / already_issued
              // and null elsewhere.
              irn: out.irn ?? null,
              ackNumber: out.ackNumber ?? null,
              ackDate: out.ackDate ?? null,
            };
          } catch (err) {
            // Catch-all so one row's crash doesn't kill the batch.
            logger.error(
              { orgId, orderId, err },
              "einvoice: bulk worker crashed on a row (continuing)",
            );
            settled = {
              orderId,
              orderNumber: initialRow.orderNumber,
              status: "failed",
              message:
                err instanceof Error ? err.message : "Unexpected worker error",
              errorCode: "worker_crashed",
              // Explicit nulls so the persisted jsonb shape stays
              // consistent with every other settled row — the
              // serializer normalises missing keys too, but
              // writing them at source means a future ad-hoc
              // jsonb query won't be tripped up by older shape.
              irn: null,
              ackNumber: null,
              ackDate: null,
            };
          }
          await persistRowSettlement(batchId, orderId, settled);
        }
      };

      const workers = Array.from({ length: concurrency }, () => worker());
      await Promise.all(workers);
    }

    // Only mark completed when every worker finished cleanly. A
    // fatal (non-row-scoped) error like a DB outage propagates out
    // of Promise.all and skips this; the batch stays in 'running'
    // state so the next recovery cycle — after the claim heartbeat
    // expires — can pick it up.
    await markBatchCompleted(batchId);
  } catch (err) {
    logger.error(
      { err, batchId, orgId: batch?.organizationId },
      "einvoice: bulk batch aborted by fatal error, leaving in 'running' for recovery",
    );
  }
}

/**
 * How long after a recovery claim is taken we treat it as stale and
 * let another process (or this same process on a later boot) take
 * over. Long enough that a healthy worker finishing its rows will
 * mark the batch "completed" before the claim expires; short enough
 * that a crashed-mid-recovery batch isn't stuck forever.
 */
const RECOVERY_CLAIM_TTL_MS = 10 * 60 * 1000;

/**
 * Recovery hook: called once at API startup. Finds every batch left
 * in "running" state from a prior process (deploy, crash, workflow
 * restart) and — for each batch we can atomically claim — re-spawns
 * its worker so the operator's run picks up where it left off.
 *
 * The claim is a conditional UPDATE that flips `recoveryClaimedAt`
 * from null/stale to now() and only spawns a worker when the row is
 * actually claimed. That makes recovery safe under accidental double
 * invocation (boot scripts, multi-replica deploys, signal storms):
 * only one process owns a given batch at a time. A claim older than
 * RECOVERY_CLAIM_TTL_MS is considered abandoned and re-claimable.
 *
 * For each claimed batch we also reset any sales_orders rows still
 * marked irpStatus='pending' (the in-flight IRP call that died with
 * the previous process) to 'failed' code 'interrupted' so the
 * worker's eligibility check will re-pick them up.
 */
export async function recoverInFlightBulkBatches(): Promise<void> {
  try {
    await pruneStaleBatches();
  } catch (err) {
    logger.error({ err }, "einvoice: prune-on-startup failed (continuing)");
  }
  let running: EinvoiceBulkBatch[];
  try {
    running = await db
      .select()
      // org-scope-allow: startup recovery scans every running batch across
      // all tenants and re-claims each one (next allow comment).
      .from(einvoiceBulkBatchesTable)
      .where(eq(einvoiceBulkBatchesTable.status, "running"));
  } catch (err) {
    logger.error(
      { err },
      "einvoice: failed to scan running batches at startup",
    );
    return;
  }
  for (const batch of running) {
    let claimed: EinvoiceBulkBatch[];
    try {
      const staleBefore = new Date(Date.now() - RECOVERY_CLAIM_TTL_MS);
      claimed = await db
        // org-scope-allow: cross-tenant startup recovery reclaim. Each
        // running batch (regardless of org) is re-claimed atomically so the
        // worker process that wins recovery resumes it.
        .update(einvoiceBulkBatchesTable)
        .set({ recoveryClaimedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(einvoiceBulkBatchesTable.id, batch.id),
            eq(einvoiceBulkBatchesTable.status, "running"),
            or(
              isNull(einvoiceBulkBatchesTable.recoveryClaimedAt),
              lt(einvoiceBulkBatchesTable.recoveryClaimedAt, staleBefore),
            ),
          ),
        )
        .returning();
    } catch (err) {
      logger.error(
        { err, batchId: batch.id, orgId: batch.organizationId },
        "einvoice: claim attempt failed at startup (skipping)",
      );
      continue;
    }
    if (claimed.length === 0) {
      // Another process already owns this batch (or claimed it
      // recently and is still working on it). Leave it alone.
      logger.info(
        { batchId: batch.id, orgId: batch.organizationId },
        "einvoice: bulk batch already claimed by another process, skipping",
      );
      continue;
    }
    const claimedBatch = claimed[0];
    const stillPendingIds = claimedBatch.orderIdsInOrder.filter((id) => {
      const r = claimedBatch.results[String(id)];
      return r != null && r.status === "pending";
    });
    if (stillPendingIds.length > 0) {
      try {
        await db
          .update(salesOrdersTable)
          .set({
            irpStatus: "failed",
            irpError:
              "The server restarted while this IRN was being registered. We've reset it so the bulk run can retry.",
            irpErrorCode: "interrupted",
            irpErrorContext: null,
          })
          .where(
            and(
              eq(salesOrdersTable.organizationId, claimedBatch.organizationId),
              inArray(salesOrdersTable.id, stillPendingIds),
              eq(salesOrdersTable.irpStatus, "pending"),
            ),
          );
      } catch (err) {
        logger.error(
          {
            err,
            batchId: claimedBatch.id,
            orgId: claimedBatch.organizationId,
          },
          "einvoice: failed to reset orphaned in-flight claims (continuing)",
        );
      }
    }
    logger.info(
      {
        batchId: claimedBatch.id,
        orgId: claimedBatch.organizationId,
        pending: stillPendingIds.length,
      },
      "einvoice: resuming bulk batch after restart",
    );
    void runBulkBatch(claimedBatch.id);
  }
}

/**
 * Periodic maintenance scheduler. Returns the timer handle so callers
 * can stop it during shutdown or tests. Each tick does two things:
 *  1. Prune batch rows older than the retention window.
 *  2. Re-run recovery so any batch left in 'running' by a fatal
 *     mid-loop error (without a process restart) gets picked up
 *     once its claim heartbeat goes stale (RECOVERY_CLAIM_TTL_MS).
 *
 * Recovery is safely idempotent: each batch is gated by an atomic
 * conditional UPDATE on `recoveryClaimedAt`, so an already-active
 * worker will never be re-spawned and overlapping interval ticks
 * cannot double-fire.
 */
export function startBulkBatchPruneScheduler(
  intervalMs: number = 10 * 60 * 1000,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void pruneStaleBatches().catch((err) => {
      logger.error({ err }, "einvoice: scheduled prune failed");
    });
    void recoverInFlightBulkBatches().catch((err) => {
      logger.error({ err }, "einvoice: scheduled recovery failed");
    });
  }, intervalMs);
  // Don't keep the event loop alive just for the maintenance timer.
  if (typeof timer.unref === "function") timer.unref();
  return timer;
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
  rows: Record<string, BulkResultRow>;
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
      // Pulled into the up-front classifier so the `already_issued`
      // branch below can surface the existing IRN on the row
      // payload — the UI / CSV would otherwise be stuck with a
      // generic message and no IRN.
      irpAckNumber: salesOrdersTable.irpAckNumber,
      irpAckDate: salesOrdersTable.irpAckDate,
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
  const rows: Record<string, BulkResultRow> = {};
  const setRow = (id: number, row: BulkResultRow) => {
    rows[String(id)] = row;
  };
  for (const id of orderIdsInOrder) {
    const r = byId.get(id);
    if (!r) {
      setRow(id, {
        orderId: id,
        orderNumber: null,
        status: "ineligible",
        message: "Sales order not found",
        errorCode: "not_found",
      });
      continue;
    }
    if (!connectedAndEnabled) {
      setRow(id, {
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
      setRow(id, {
        orderId: id,
        orderNumber: r.orderNumber,
        status: "ineligible",
        message: `E-invoice can only be registered after the order has shipped. Current status: ${r.status}.`,
        errorCode: "ineligible_status",
      });
      continue;
    }
    if (!r.customerGstNumber) {
      setRow(id, {
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
      // the failures. Carrying the existing IRN in the row payload
      // means the bulk dialog and CSV export can show it in the
      // IRN column without operators cross-referencing the order
      // detail page.
      setRow(id, {
        orderId: id,
        orderNumber: r.orderNumber,
        status: "already_issued",
        message: "An active IRN already exists for this order.",
        errorCode: "irn_already_issued",
        irn: r.irn,
        ackNumber: r.irpAckNumber,
        ackDate: r.irpAckDate ? r.irpAckDate.toISOString() : null,
      });
      continue;
    }
    if (r.irpStatus === "pending") {
      setRow(id, {
        orderId: id,
        orderNumber: r.orderNumber,
        status: "skipped",
        message: "Another IRN registration is already in flight.",
        errorCode: "irn_in_flight",
      });
      continue;
    }
    if (r.irpStatus === "cancelled") {
      setRow(id, {
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
    setRow(id, {
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

    // Initial counters from the classifier — anything not "pending"
    // or "running" was settled up-front (e.g. ineligible, missing
    // GSTIN, or already-issued) so the first GET reflects real
    // progress and `processed` agrees with the row statuses.
    const counters = computeCounters(orderIdsInOrder, rows);
    const batchId = randomUUID();
    const now = new Date();
    // Effective worker fan-out for this batch — the same clamp the
    // worker applies, captured here so the API response (and the
    // completion log) report the value that actually shaped the run.
    // Counts only the rows the classifier left as "pending" since
    // pre-settled rows don't take a worker slot.
    const eligibleCount = orderIdsInOrder.reduce(
      (n, id) => (rows[String(id)]!.status === "pending" ? n + 1 : n),
      0,
    );
    const effectiveConcurrency =
      eligibleCount > 0
        ? Math.max(1, Math.min(BULK_CONCURRENCY, eligibleCount))
        : 1;
    const inserted = await db
      .insert(einvoiceBulkBatchesTable)
      .values({
        id: batchId,
        organizationId: t.organizationId,
        status: "running",
        total: orderIdsInOrder.length,
        processed: counters.processed,
        succeeded: counters.succeeded,
        failed: counters.failed,
        skipped: counters.skipped,
        orderIdsInOrder,
        results: rows,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        concurrency: effectiveConcurrency,
        // Mark this process as the owner from the moment the batch
        // exists. Without this, a recovery tick that fired between
        // the INSERT and the worker's first persistRowSettlement
        // heartbeat could see a 'running' batch with null
        // recoveryClaimedAt and atomically claim it on a different
        // replica, double-spawning the worker. The first per-row
        // UPDATE refreshes this timestamp; if no row settles within
        // RECOVERY_CLAIM_TTL_MS the batch becomes reclaimable.
        recoveryClaimedAt: now,
      })
      .returning();
    const batch = inserted[0];
    if (!batch) {
      // Defensive: a no-row return should never happen with a single
      // INSERT...RETURNING, but if it does, surface a clear error
      // rather than crashing the worker call below.
      throw new Error("Failed to create bulk batch row");
    }

    // Fire-and-forget the worker. We deliberately never `await` it
    // here; the response goes back immediately and the UI polls the
    // GET endpoint for progress. The worker re-loads the batch by
    // id from the DB so it always sees the freshest state — and so
    // recovery after a restart can call `runBulkBatch(id)` directly.
    // Any uncaught error inside is swallowed by the try/finally.
    void runBulkBatch(batchId);

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
    const batch = await loadBulkBatch(parsed.data.batchId);
    // Scope strictly per-org: don't even acknowledge cross-tenant
    // batch ids exist. A missing row covers both "never existed" and
    // "expired and pruned" — same 404 either way.
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
