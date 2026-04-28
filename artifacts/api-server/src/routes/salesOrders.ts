import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  salesOrdersTable,
  salesOrderLinesTable,
  customersTable,
  warehousesTable,
  itemsTable,
  itemWarehouseStockTable,
  stockMovementsTable,
  emailLogTable,
} from "@workspace/db";
import { tenantMiddleware, assertOwnership, findParentItems } from "../lib/tenant";
import {
  serializeSalesOrder,
  serializeOrderLine,
  serializeEmailLog,
} from "../lib/serializers";
import { computeOrderTotals, nextOrderNumber } from "../lib/orderHelpers";
import { toNum, toStr } from "../lib/numeric";
import { pushStockToShopify } from "../lib/shopifyOutbound";
import { loadShipmentsForOrder } from "./shipments";
import { loadInvoiceForOrder } from "../lib/invoiceData";
import { sendEmail, EmailNotConfiguredError } from "../lib/email";
import { signInvoiceUrl } from "../lib/invoiceLinks";
import { getActivePaymentLink } from "./paymentLinks";
import { logger } from "../lib/logger";
import { tryAutoGenerateIrn } from "./einvoice";

// `shipped` and `partially_shipped` are derived server-side from
// recorded shipments — clients cannot set them directly via PATCH /status.
const PATCHABLE_SALES_STATUSES = [
  "draft",
  "confirmed",
  "delivered",
  "invoiced",
  "paid",
  "cancelled",
] as const;
type PatchableSalesStatus = (typeof PATCHABLE_SALES_STATUSES)[number];
function isPatchableSalesStatus(s: string): s is PatchableSalesStatus {
  return (PATCHABLE_SALES_STATUSES as readonly string[]).includes(s);
}

const router: IRouter = Router();
router.use(tenantMiddleware);

router.get("/sales-orders", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const conds = [eq(salesOrdersTable.organizationId, t.organizationId)];
    if (req.query.status) conds.push(eq(salesOrdersTable.status, String(req.query.status)));
    if (req.query.customerId)
      conds.push(eq(salesOrdersTable.customerId, Number(req.query.customerId)));
    const rows = await db
      .select({
        order: salesOrdersTable,
        customerName: customersTable.name,
        customerGstNumber: customersTable.gstNumber,
        warehouseName: warehousesTable.name,
      })
      .from(salesOrdersTable)
      .innerJoin(customersTable, eq(customersTable.id, salesOrdersTable.customerId))
      .innerJoin(
        warehousesTable,
        eq(warehousesTable.id, salesOrdersTable.warehouseId),
      )
      .where(and(...conds))
      .orderBy(desc(salesOrdersTable.createdAt));
    res.json(
      rows.map((r) =>
        serializeSalesOrder(
          r.order,
          r.customerName,
          r.warehouseName,
          r.customerGstNumber,
        ),
      ),
    );
  } catch (err) {
    next(err);
  }
});

async function loadDetail(orgId: number, orderId: number) {
  const orderRows = await db
    .select({
      order: salesOrdersTable,
      customerName: customersTable.name,
      customerGstNumber: customersTable.gstNumber,
      warehouseName: warehousesTable.name,
    })
    .from(salesOrdersTable)
    .innerJoin(customersTable, eq(customersTable.id, salesOrdersTable.customerId))
    .innerJoin(warehousesTable, eq(warehousesTable.id, salesOrdersTable.warehouseId))
    .where(
      and(eq(salesOrdersTable.id, orderId), eq(salesOrdersTable.organizationId, orgId)),
    )
    .limit(1);
  if (!orderRows[0]) return null;
  const lineRows = await db
    .select({
      line: salesOrderLinesTable,
      itemName: itemsTable.name,
      sku: itemsTable.sku,
      variantOptions: itemsTable.variantOptions,
      trackBatches: itemsTable.trackBatches,
    })
    .from(salesOrderLinesTable)
    .innerJoin(itemsTable, eq(itemsTable.id, salesOrderLinesTable.itemId))
    .where(eq(salesOrderLinesTable.salesOrderId, orderId));
  const shipments = await loadShipmentsForOrder(orgId, orderId);
  return {
    order: serializeSalesOrder(
      orderRows[0].order,
      orderRows[0].customerName,
      orderRows[0].warehouseName,
      orderRows[0].customerGstNumber,
    ),
    lines: lineRows.map((r) =>
      serializeOrderLine(
        r.line,
        r.itemName,
        r.sku,
        (r.variantOptions as Record<string, string> | null) ?? null,
        !!r.trackBatches,
      ),
    ),
    shipments,
  };
}

router.post("/sales-orders", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const b = req.body ?? {};
    if (!b.customerId || !b.warehouseId || !b.orderDate || !Array.isArray(b.lines) || b.lines.length === 0) {
      res.status(400).json({ error: "customerId, warehouseId, orderDate and lines are required" });
      return;
    }
    const itemIds = b.lines
      .map((l: { itemId: number }) => Number(l.itemId))
      .filter((n: number) => Number.isFinite(n) && n > 0);
    if (itemIds.length !== b.lines.length) {
      res.status(400).json({ error: "Every line must include itemId" });
      return;
    }
    const own = await assertOwnership({
      organizationId: t.organizationId,
      customerIds: [Number(b.customerId)],
      warehouseIds: [Number(b.warehouseId)],
      itemIds,
    });
    if (!own.ok) {
      res.status(400).json({ error: `Invalid ${own.missing}` });
      return;
    }
    const parents = await findParentItems(t.organizationId, itemIds);
    if (parents.length > 0) {
      res.status(400).json({
        error: `Cannot use parent items on a sales order. Pick a variant instead. Offending: ${parents
          .map((p) => p.sku)
          .join(", ")}`,
      });
      return;
    }
    const totals = computeOrderTotals(b.lines);
    const inserted = await db
      .insert(salesOrdersTable)
      .values({
        organizationId: t.organizationId,
        orderNumber: nextOrderNumber("SO"),
        customerId: b.customerId,
        warehouseId: b.warehouseId,
        status: "draft",
        orderDate: b.orderDate,
        expectedShipDate: b.expectedShipDate ?? null,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        amountPaid: "0",
        balanceDue: totals.total,
        notes: b.notes ?? null,
      })
      .returning();
    const order = inserted[0]!;
    if (totals.lines.length > 0) {
      await db.insert(salesOrderLinesTable).values(
        totals.lines.map((l) => ({
          salesOrderId: order.id,
          itemId: l.itemId,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxRate: l.taxRate,
          lineSubtotal: l.lineSubtotal,
          lineTax: l.lineTax,
          lineTotal: l.lineTotal,
        })),
      );
    }
    const detail = await loadDetail(t.organizationId, order.id);
    res.status(201).json(detail);
  } catch (err) {
    next(err);
  }
});

router.get("/sales-orders/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const detail = await loadDetail(t.organizationId, Number(req.params.id));
    if (!detail) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

router.patch("/sales-orders/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
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
    const existing = orderRows[0];
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (existing.status !== "draft") {
      res.status(400).json({
        error: "Only draft orders can be edited. Cancel and recreate to change a confirmed order.",
      });
      return;
    }
    const b = req.body ?? {};
    const customerId = b.customerId ? Number(b.customerId) : existing.customerId;
    const warehouseId = b.warehouseId ? Number(b.warehouseId) : existing.warehouseId;
    const itemIds = Array.isArray(b.lines)
      ? b.lines.map((l: { itemId: number }) => Number(l.itemId))
      : [];
    const own = await assertOwnership({
      organizationId: t.organizationId,
      customerIds: b.customerId ? [customerId] : undefined,
      warehouseIds: b.warehouseId ? [warehouseId] : undefined,
      itemIds: itemIds.length ? itemIds : undefined,
    });
    if (!own.ok) {
      res.status(400).json({ error: `Invalid ${own.missing}` });
      return;
    }
    if (itemIds.length) {
      const parents = await findParentItems(t.organizationId, itemIds);
      if (parents.length > 0) {
        res.status(400).json({
          error: `Cannot use parent items on a sales order. Pick a variant instead. Offending: ${parents
            .map((p) => p.sku)
            .join(", ")}`,
        });
        return;
      }
    }

    const update: Partial<typeof salesOrdersTable.$inferInsert> = {
      customerId,
      warehouseId,
      orderDate: b.orderDate ? String(b.orderDate) : existing.orderDate,
      expectedShipDate:
        b.expectedShipDate === undefined
          ? existing.expectedShipDate
          : b.expectedShipDate
            ? String(b.expectedShipDate)
            : null,
      notes: b.notes === undefined ? existing.notes : b.notes,
    };

    if (Array.isArray(b.lines)) {
      const totals = computeOrderTotals(b.lines);
      update.subtotal = totals.subtotal;
      update.taxTotal = totals.taxTotal;
      update.total = totals.total;
      // Drafts cannot have payments yet (balanceDue would block payment recording),
      // so amountPaid is always "0" here. Resync balanceDue = new total.
      update.balanceDue = totals.total;
      await db
        .delete(salesOrderLinesTable)
        .where(eq(salesOrderLinesTable.salesOrderId, id));
      if (totals.lines.length > 0) {
        await db.insert(salesOrderLinesTable).values(
          totals.lines.map((l) => ({
            salesOrderId: id,
            itemId: l.itemId,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            taxRate: l.taxRate,
            lineSubtotal: l.lineSubtotal,
            lineTax: l.lineTax,
            lineTotal: l.lineTotal,
          })),
        );
      }
    }

    await db
      .update(salesOrdersTable)
      .set(update)
      .where(eq(salesOrdersTable.id, id));
    const detail = await loadDetail(t.organizationId, id);
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

router.delete("/sales-orders/:id", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    await db
      .delete(salesOrdersTable)
      .where(
        and(eq(salesOrdersTable.id, id), eq(salesOrdersTable.organizationId, t.organizationId)),
      );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.patch("/sales-orders/:id/status", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const newStatus = String(req.body?.status ?? "");
    if (!newStatus) {
      res.status(400).json({ error: "status is required" });
      return;
    }
    if (newStatus === "returned") {
      res.status(400).json({
        error: "Use POST /sales-orders/:id/return to mark an order as returned.",
      });
      return;
    }
    if (newStatus === "shipped" || newStatus === "partially_shipped") {
      res.status(400).json({
        error:
          "Use POST /sales-orders/:id/shipments to record shipments. The order's shipped status is derived from recorded shipments.",
      });
      return;
    }
    if (!isPatchableSalesStatus(newStatus)) {
      res.status(400).json({
        error: `Invalid status. Allowed: ${PATCHABLE_SALES_STATUSES.join(", ")}`,
      });
      return;
    }
    const orderRows = await db
      .select()
      .from(salesOrdersTable)
      .where(
        and(eq(salesOrdersTable.id, id), eq(salesOrdersTable.organizationId, t.organizationId)),
      )
      .limit(1);
    const order = orderRows[0];
    if (!order) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (order.status === "returned") {
      res.status(400).json({
        error: "Returned orders are final and cannot change status.",
      });
      return;
    }

    // Validate per-status transition rules.
    const lineRows = await db
      .select({ qty: salesOrderLinesTable.quantity, shipped: salesOrderLinesTable.quantityShipped })
      .from(salesOrderLinesTable)
      .where(eq(salesOrderLinesTable.salesOrderId, id));
    const totalShipped = lineRows.reduce((s, l) => s + toNum(l.shipped), 0);

    if (newStatus === "draft" || newStatus === "confirmed") {
      if (totalShipped > 0) {
        res.status(400).json({
          error:
            "Cannot revert to draft or confirmed once shipments have been recorded. Cancel the shipments first.",
        });
        return;
      }
    }
    if (newStatus === "cancelled") {
      if (totalShipped > 0) {
        res.status(400).json({
          error:
            "Cannot cancel an order with recorded shipments. Cancel the shipments first, or use the return flow.",
        });
        return;
      }
      if (!["draft", "confirmed"].includes(order.status)) {
        res.status(400).json({
          error:
            "Cancellation is only allowed from draft or confirmed orders.",
        });
        return;
      }
    }
    if (newStatus === "delivered" && order.status !== "shipped") {
      res.status(400).json({
        error:
          "Mark the order delivered only after every line is fully shipped.",
      });
      return;
    }
    if (newStatus === "invoiced" && !["shipped", "delivered"].includes(order.status)) {
      res.status(400).json({
        error: "Invoiced is only valid after the order has shipped.",
      });
      return;
    }
    if (newStatus === "paid" && !["shipped", "delivered", "invoiced"].includes(order.status)) {
      res.status(400).json({
        error: "Paid is only valid after the order has shipped.",
      });
      return;
    }

    await db
      .update(salesOrdersTable)
      .set({ status: newStatus })
      .where(eq(salesOrdersTable.id, id));

    // Best-effort auto-register an IRN with the IRP whenever an
    // order transitions into `invoiced`. tryAutoGenerateIrn caps
    // its own total time budget (and uses per-fetch timeouts plus a
    // small retry policy), so awaiting it here gives a fast IRP
    // response time to land in the immediate detail payload while
    // never blocking the status transition: any failure is
    // persisted as irpStatus="failed" and the status update still
    // succeeds.
    if (newStatus === "invoiced" && order.status !== "invoiced") {
      await tryAutoGenerateIrn(t.organizationId, id);
    }

    const detail = await loadDetail(t.organizationId, id);
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

const RETURNABLE_SALES_STATUSES = [
  "shipped",
  "delivered",
  "invoiced",
  "paid",
];

router.post("/sales-orders/:id/return", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    const notes =
      typeof req.body?.notes === "string" && req.body.notes.trim()
        ? String(req.body.notes).trim()
        : null;

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
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!RETURNABLE_SALES_STATUSES.includes(order.status)) {
      res.status(400).json({
        error: `Only ${RETURNABLE_SALES_STATUSES.join(", ")} sales orders can be returned`,
      });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const claimed = await tx
        .update(salesOrdersTable)
        .set({ status: "returned" })
        .where(
          and(
            eq(salesOrdersTable.id, id),
            eq(salesOrdersTable.organizationId, t.organizationId),
            sql`${salesOrdersTable.status} IN ('shipped','delivered','invoiced','paid')`,
          ),
        )
        .returning({ id: salesOrdersTable.id });
      if (claimed.length === 0) {
        return { conflict: true as const };
      }

      const lines = await tx
        .select()
        .from(salesOrderLinesTable)
        .where(eq(salesOrderLinesTable.salesOrderId, id));

      let anyStockReversed = false;
      for (const line of lines) {
        const qty = toNum(line.quantityShipped);
        if (qty <= 0) continue;
        anyStockReversed = true;
        const stockRows = await tx
          .select()
          .from(itemWarehouseStockTable)
          .where(
            and(
              eq(itemWarehouseStockTable.organizationId, t.organizationId),
              eq(itemWarehouseStockTable.itemId, line.itemId),
              eq(itemWarehouseStockTable.warehouseId, order.warehouseId),
            ),
          )
          .limit(1);
        if (stockRows[0]) {
          await tx
            .update(itemWarehouseStockTable)
            .set({ quantity: toStr(toNum(stockRows[0].quantity) + qty) })
            .where(eq(itemWarehouseStockTable.id, stockRows[0].id));
        } else {
          await tx.insert(itemWarehouseStockTable).values({
            organizationId: t.organizationId,
            itemId: line.itemId,
            warehouseId: order.warehouseId,
            quantity: toStr(qty),
          });
        }
        await tx.insert(stockMovementsTable).values({
          organizationId: t.organizationId,
          itemId: line.itemId,
          warehouseId: order.warehouseId,
          movementType: "sales_return",
          quantity: toStr(qty),
          referenceType: "sales_order",
          referenceId: id,
          notes:
            notes ??
            `Sales return for order ${order.orderNumber}`,
        });
      }
      if (!anyStockReversed) {
        return {
          conflict: false as const,
          empty: true as const,
          itemIds: [] as number[],
        };
      }
      return {
        conflict: false as const,
        empty: false as const,
        itemIds: lines.map((l) => l.itemId),
      };
    });

    if (result.conflict) {
      res.status(409).json({
        error: "Order has already been returned by another request.",
      });
      return;
    }
    for (const itemId of new Set(result.itemIds)) {
      pushStockToShopify(t.organizationId, itemId);
    }

    const detail = await loadDetail(t.organizationId, id);
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Invoice PDF + email-to-customer
// ---------------------------------------------------------------------------

router.get("/sales-orders/:id/invoice.pdf", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid sales order id" });
      return;
    }
    const result = await loadInvoiceForOrder(t.organizationId, id);
    if ("notFound" in result) {
      res.status(404).json({ error: "Sales order not found" });
      return;
    }
    if ("wrongStatus" in result) {
      res.status(400).json({
        error: `Invoice PDF is available after the order has shipped. Current status: ${result.wrongStatus}.`,
      });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="invoice-${result.orderNumber}.pdf"`,
    );
    res.setHeader("Cache-Control", "private, max-age=0, no-store");
    res.setHeader("Content-Length", String(result.pdf.length));
    res.send(result.pdf);
  } catch (err) {
    next(err);
  }
});

router.post("/sales-orders/:id/invoice/email", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid sales order id" });
      return;
    }
    const b = req.body ?? {};
    const to =
      typeof b.to === "string" && b.to.trim() ? String(b.to).trim() : null;
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      res.status(400).json({ error: "A valid recipient email (to) is required." });
      return;
    }
    const result = await loadInvoiceForOrder(t.organizationId, id);
    if ("notFound" in result) {
      res.status(404).json({ error: "Sales order not found" });
      return;
    }
    if ("wrongStatus" in result) {
      res.status(400).json({
        error: `Invoice can only be emailed after the order has shipped. Current status: ${result.wrongStatus}.`,
      });
      return;
    }
    const subject =
      typeof b.subject === "string" && b.subject.trim()
        ? String(b.subject).trim().slice(0, 200)
        : `Invoice ${result.orderNumber}`;
    const bodyText =
      typeof b.body === "string" && b.body.trim()
        ? String(b.body).trim()
        : `Hi ${result.customerName},\n\nPlease find attached invoice ${result.orderNumber} for your records.\n\nThanks!`;

    let baseUrl =
      process.env.PUBLIC_BASE_URL?.trim() ||
      process.env.REPLIT_DEV_DOMAIN?.trim() ||
      "";
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) baseUrl = `https://${baseUrl}`;
    // Full HTML attribute encoder: escapes the four characters that can break
    // out of an `href="..."` context.
    const escapeAttr = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const escapeText = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    let html = bodyText
      .split("\n")
      .map((line) => `<p>${escapeText(line)}</p>`)
      .join("");
    let textWithLinks = bodyText;
    if (baseUrl) {
      try {
        const link = signInvoiceUrl(baseUrl, t.organizationId, id);
        html += `<p><a href="${escapeAttr(link.url)}">View invoice online</a></p>`;
        textWithLinks += `\n\nView invoice online: ${link.url}`;
      } catch {
        // Signing secret missing — skip the link rather than failing the send.
      }
    }
    // Inject the active Razorpay payment link, if any. Surfacing this in the
    // invoice email is the whole point of generating one.
    try {
      const activeLink = await getActivePaymentLink(t.organizationId, id);
      if (activeLink) {
        html += `<p><strong>Pay this invoice online:</strong> <a href="${escapeAttr(activeLink.shortUrl)}">${escapeText(activeLink.shortUrl)}</a></p>`;
        textWithLinks += `\n\nPay this invoice online: ${activeLink.shortUrl}`;
      }
    } catch (linkErr) {
      // A failure here must not abort the send — payment link is auxiliary.
      logger.warn(
        { err: linkErr, salesOrderId: id },
        "Could not look up payment link for invoice email; sending without it",
      );
    }

    // Step 1: attempt to send. Capture outcome — never let an exception escape
    // out of this block so we can always attempt to log it before responding.
    let sendError: unknown = null;
    try {
      await sendEmail({
        to,
        subject,
        text: textWithLinks,
        html,
        attachments: [
          {
            filename: `invoice-${result.orderNumber}.pdf`,
            content: result.pdf,
            contentType: "application/pdf",
          },
        ],
      });
    } catch (err) {
      sendError = err;
    }

    const sendStatus: "sent" | "failed" = sendError ? "failed" : "sent";
    const errorMessage = sendError
      ? sendError instanceof Error
        ? sendError.message
        : "Email send failed"
      : null;

    // Step 2: try to record the outcome. Logging failure must NOT flip a
    // successful send into a "failed" response to the user.
    let logRow:
      | typeof emailLogTable.$inferSelect
      | { synthetic: true; status: "sent" | "failed"; errorMessage: string | null };
    try {
      const inserted = await db
        .insert(emailLogTable)
        .values({
          organizationId: t.organizationId,
          salesOrderId: id,
          kind: "invoice",
          recipient: to,
          subject,
          status: sendStatus,
          errorMessage,
          sentByUserId: t.userId,
        })
        .returning();
      logRow = inserted[0]!;
    } catch (logErr) {
      logger.error(
        { err: logErr, salesOrderId: id, sendStatus },
        "Failed to write email_log row",
      );
      logRow = { synthetic: true, status: sendStatus, errorMessage };
    }

    // Step 3: respond based on the *send* outcome (the user-observable truth),
    // independent of whether the log write succeeded.
    if (sendError) {
      const httpStatus =
        sendError instanceof EmailNotConfiguredError ? 503 : 502;
      res.status(httpStatus).json({
        error: errorMessage,
        emailLog:
          "synthetic" in logRow ? null : serializeEmailLog(logRow),
      });
      return;
    }
    res.status(201).json(
      "synthetic" in logRow
        ? {
            id: -1,
            organizationId: t.organizationId,
            salesOrderId: id,
            kind: "invoice",
            recipient: to,
            subject,
            status: "sent",
            errorMessage: null,
            sentByUserId: t.userId,
            sentAt: new Date().toISOString(),
            warning: "Email sent but the activity record could not be saved.",
          }
        : serializeEmailLog(logRow),
    );
  } catch (err) {
    next(err);
  }
});

router.get("/sales-orders/:id/email-log", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid sales order id" });
      return;
    }
    const rows = await db
      .select()
      .from(emailLogTable)
      .where(
        and(
          eq(emailLogTable.organizationId, t.organizationId),
          eq(emailLogTable.salesOrderId, id),
        ),
      )
      .orderBy(desc(emailLogTable.sentAt));
    res.json(rows.map(serializeEmailLog));
  } catch (err) {
    next(err);
  }
});

export default router;
