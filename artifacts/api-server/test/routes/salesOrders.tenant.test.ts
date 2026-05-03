// Cross-tenant isolation tests for the sales-orders router.
//
// Sales orders is the broadest write-side router on the AR side: it owns
// the order list, detail, draft edits, status transitions, returns, the
// invoice PDF, the invoice email, and the per-order email log. Each
// surface must refuse to read or write the other org's rows. The invoice
// PDF / email / email-log paths join across customers, warehouses,
// shipments, and email_log, so they are particularly leak-prone.

import { describe, it, expect, beforeEach, vi } from "vitest";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";
import {
  createInMemoryDbModuleMock,
  memDb,
  tables,
} from "../helpers/inMemoryDb";

vi.mock("@workspace/db", () => createInMemoryDbModuleMock());
vi.mock("../../src/lib/tenant", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/lib/tenant")>(
      "../../src/lib/tenant",
    );
  return {
    ...actual,
    tenantMiddleware: (req: Request, _res: Response, next: NextFunction) => {
      const orgId = Number(req.header("x-test-org-id"));
      if (!Number.isFinite(orgId) || orgId <= 0) {
        _res.status(401).json({ error: "missing x-test-org-id header" });
        return;
      }
      req.tenant = {
        userId: orgId * 10,
        organizationId: orgId,
        role: "owner",
        clerkUserId: `user_test_${orgId}`,
        isSuperAdmin: false,
      };
      next();
    },
  };
});
vi.mock("../../src/lib/shopifyOutbound", () => ({
  pushStockToShopify: vi.fn(),
}));
// `shipments` is imported eagerly via `loadShipmentsForOrder`. It in turn
// imports lib/batches, so we stub batches with safe no-ops too.
vi.mock("../../src/lib/batches", () => ({
  applyBatchStockChange: vi.fn(),
  insertBatchMovement: vi.fn(),
  loadBatchMovementsForParents: vi.fn(async () => []),
  parseBatchPicks: vi.fn(() => ({ ok: true as const, rows: [] })),
}));
// loadInvoiceForOrder is the org-scoping gate for the invoice PDF and the
// invoice-email endpoints. Mock it to mimic the real behaviour: if the
// caller's org doesn't own the order, return notFound; otherwise return
// a minimal happy-path payload.
vi.mock("../../src/lib/invoiceData", () => ({
  loadInvoiceForOrder: vi.fn(async (orgId: number, id: number) => {
    const row = (await memDb.rowsOf("sales_orders"))
      .find((r) => r.id === id && r.organizationId === orgId);
    if (!row) return { notFound: true as const };
    return {
      orderNumber: String(row.orderNumber),
      customerName: "test",
      pdf: Buffer.from("pdf"),
    };
  }),
}));
// loadSalesOrderAckPdf is the org-scoping gate for the order-ack PDF
// endpoint (GET /sales-orders/:id/pdf). Same shape as loadInvoiceForOrder.
vi.mock("../../src/lib/salesOrderAckPdfData", () => ({
  loadSalesOrderAckPdf: vi.fn(async (orgId: number, id: number) => {
    const row = (await memDb.rowsOf("sales_orders"))
      .find((r) => r.id === id && r.organizationId === orgId);
    if (!row) return { notFound: true as const };
    return {
      orderNumber: String(row.orderNumber),
      pdf: Buffer.from("%PDF-fake"),
    };
  }),
}));
vi.mock("../../src/lib/email", () => ({
  EmailNotConfiguredError: class EmailNotConfiguredError extends Error {},
  isEmailConfigured: () => true,
  sendEmail: vi.fn(async () => undefined),
}));
vi.mock("../../src/lib/invoiceLinks", () => ({
  signInvoiceUrl: vi.fn(() => ({ url: "https://example.test/invoice", token: "tok" })),
  verifyInvoiceToken: vi.fn(),
}));
vi.mock("../../src/routes/paymentLinks", () => ({
  default: { use: () => undefined },
  getActivePaymentLink: vi.fn(async () => null),
}));
vi.mock("../../src/routes/einvoice", () => ({
  default: { use: () => undefined },
  tryAutoGenerateIrn: vi.fn(async () => undefined),
}));
vi.mock("../../src/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

import salesOrdersRouter from "../../src/routes/salesOrders";

const ORG_A = 1001;
const ORG_B = 2002;

interface OrgFixture {
  orgId: number;
  customerId: number;
  warehouseId: number;
  itemId: number;
  draftOrderId: number;
  emailLogId: number;
}

async function seedOrg(label: "A" | "B", orgId: number): Promise<OrgFixture> {
  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
  });
  const customer = await memDb.seed(tables.customersTable, {
    organizationId: orgId,
    name: `Customer ${label}`,
    email: null,
    phone: null,
    company: null,
    gstNumber: null,
    billingAddress: null,
    shippingAddress: null,
    placeOfSupply: null,
    notes: null,
    outstandingBalance: "0",
  });
  const warehouse = await memDb.seed(tables.warehousesTable, {
    organizationId: orgId,
    name: `WH ${label}`,
    code: `WH-${label}`,
    isVirtual: false,
    isDefault: true,
  });
  const item = await memDb.seed(tables.itemsTable, {
    organizationId: orgId,
    name: `Item ${label}`,
    sku: `SKU-${label}`,
    description: null,
    category: null,
    unit: "ea",
    barcode: null,
    salePrice: "10",
    purchasePrice: "5",
    hsnCode: null,
    taxRate: "0",
    reorderLevel: "0",
    imageUrl: null,
    hasVariants: false,
    isBundle: false,
    trackBatches: false,
    parentItemId: null,
    variantOptions: null,
    archivedAt: null,
  });
  const order = await memDb.seed(tables.salesOrdersTable, {
    organizationId: orgId,
    orderNumber: `SO-${label}-1`,
    customerId: customer.id,
    warehouseId: warehouse.id,
    status: "draft",
    orderDate: "2026-01-01",
    expectedShipDate: null,
    subtotal: "10",
    taxTotal: "0",
    total: "10",
    amountPaid: "0",
    balanceDue: "10",
    notes: null,
  });
  await memDb.seed(tables.salesOrderLinesTable, {
    organizationId: orgId,
    salesOrderId: order.id,
    itemId: item.id,
    description: null,
    quantity: "1",
    quantityShipped: "0",
    unitPrice: "10",
    taxRate: "0",
    lineSubtotal: "10",
    lineTax: "0",
    lineTotal: "10",
  });
  const log = await memDb.seed(tables.emailLogTable, {
    organizationId: orgId,
    salesOrderId: order.id,
    kind: "invoice",
    recipient: `${label.toLowerCase()}@example.test`,
    subject: `Invoice ${label}`,
    status: "sent",
    errorMessage: null,
    sentByUserId: orgId * 10,
    sentAt: new Date(),
  });
  return {
    orgId,
    customerId: customer.id as number,
    warehouseId: warehouse.id as number,
    itemId: item.id as number,
    draftOrderId: order.id as number,
    emailLogId: log.id as number,
  };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(salesOrdersRouter);
  return app;
}

describe("sales-orders cross-tenant isolation", () => {
  let app: Express;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeEach(async () => {
    await memDb.reset();
    a = await seedOrg("A", ORG_A);
    b = await seedOrg("B", ORG_B);
    app = buildApp();
  });

  describe("GET /sales-orders", () => {
    it("only returns the caller's orders", async () => {
      const res = await request(app)
        .get("/sales-orders")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ id: number }>).map((r) => r.id);
      expect(ids).toEqual([a.draftOrderId]);
      expect(ids).not.toContain(b.draftOrderId);
    });
  });

  describe("GET /sales-orders/:id", () => {
    it("returns 404 for the other org's order", async () => {
      const res = await request(app)
        .get(`/sales-orders/${b.draftOrderId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /sales-orders/:id", () => {
    it("returns 404 and never mutates the other org's draft", async () => {
      const before = JSON.stringify(
        (await memDb.rowsOf("sales_orders")).find((r) => r.id === b.draftOrderId),
      );
      const res = await request(app)
        .patch(`/sales-orders/${b.draftOrderId}`)
        .set("x-test-org-id", String(ORG_A))
        .send({ notes: "Hacked" });
      expect(res.status).toBe(404);
      const after = JSON.stringify(
        (await memDb.rowsOf("sales_orders")).find((r) => r.id === b.draftOrderId),
      );
      expect(after).toBe(before);
    });
  });

  describe("DELETE /sales-orders/:id", () => {
    it("returns 204 but never deletes the other org's row", async () => {
      // The route is org-scoped on its DELETE WHERE clause and returns 204
      // unconditionally. We assert that org B's row remains.
      const beforeCount = (await memDb.rowsOf("sales_orders"))
        .filter((r) => r.organizationId === ORG_B).length;
      const res = await request(app)
        .delete(`/sales-orders/${b.draftOrderId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(204);
      const afterCount = (await memDb.rowsOf("sales_orders"))
        .filter((r) => r.organizationId === ORG_B).length;
      expect(afterCount).toBe(beforeCount);
    });
  });

  describe("PATCH /sales-orders/:id/status", () => {
    it("returns 404 and never flips the other org's order status", async () => {
      const before = JSON.stringify(
        (await memDb.rowsOf("sales_orders")).find((r) => r.id === b.draftOrderId),
      );
      const res = await request(app)
        .patch(`/sales-orders/${b.draftOrderId}/status`)
        .set("x-test-org-id", String(ORG_A))
        .send({ status: "cancelled" });
      expect(res.status).toBe(404);
      const after = JSON.stringify(
        (await memDb.rowsOf("sales_orders")).find((r) => r.id === b.draftOrderId),
      );
      expect(after).toBe(before);
    });
  });

  describe("POST /sales-orders/:id/return", () => {
    it("returns 404 and never moves stock for the other org", async () => {
      const beforeMovements = (await memDb.rowsOf("stock_movements")).length;
      const res = await request(app)
        .post(`/sales-orders/${b.draftOrderId}/return`)
        .set("x-test-org-id", String(ORG_A))
        .send({});
      expect(res.status).toBe(404);
      expect((await memDb.rowsOf("stock_movements")).length).toBe(beforeMovements);
    });
  });

  describe("GET /sales-orders/:id/invoice.pdf", () => {
    it("returns 404 for the other org's order", async () => {
      const res = await request(app)
        .get(`/sales-orders/${b.draftOrderId}/invoice.pdf`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
    });
  });

  describe("GET /sales-orders/:id/pdf (order acknowledgement)", () => {
    it("returns 404 for the other org's order", async () => {
      const res = await request(app)
        .get(`/sales-orders/${b.draftOrderId}/pdf`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
    });

    it("returns 200 with a PDF body for the caller's own order", async () => {
      const res = await request(app)
        .get(`/sales-orders/${a.draftOrderId}/pdf`)
        .set("x-test-org-id", String(ORG_A))
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on("data", (c: Buffer) => chunks.push(c));
          response.on("end", () => callback(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
      expect(res.headers["content-disposition"]).toContain(".pdf");
      expect(Buffer.isBuffer(res.body)).toBe(true);
      expect((res.body as Buffer).length).toBeGreaterThan(0);
    });

    it("returns 400 for an invalid id", async () => {
      const res = await request(app)
        .get(`/sales-orders/abc/pdf`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(400);
    });
  });

  describe("POST /sales-orders/:id/invoice/email", () => {
    it("returns 404 and never sends mail for the other org's order", async () => {
      const res = await request(app)
        .post(`/sales-orders/${b.draftOrderId}/invoice/email`)
        .set("x-test-org-id", String(ORG_A))
        .send({ to: "intruder@example.test" });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /sales-orders/:id/email-log", () => {
    it("returns an empty list when fetching the other org's order log", async () => {
      // The route does not 404 the parent order — it just lists rows
      // matching (orgId, salesOrderId). Cross-tenant therefore yields [].
      const res = await request(app)
        .get(`/sales-orders/${b.draftOrderId}/email-log`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("only returns the caller's logs for their own order", async () => {
      const res = await request(app)
        .get(`/sales-orders/${a.draftOrderId}/email-log`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ id: number }>).map((r) => r.id);
      expect(ids).toEqual([a.emailLogId]);
      expect(ids).not.toContain(b.emailLogId);
    });
  });

  describe("POST /sales-orders", () => {
    it("rejects when customer / warehouse belong to the other org", async () => {
      const beforeCount = (await memDb.rowsOf("sales_orders"))
        .filter((r) => r.organizationId === ORG_B).length;
      const res = await request(app)
        .post("/sales-orders")
        .set("x-test-org-id", String(ORG_A))
        .send({
          customerId: b.customerId,
          warehouseId: b.warehouseId,
          orderDate: "2026-04-01",
          lines: [{ itemId: b.itemId, quantity: 1, unitPrice: 10 }],
        });
      expect(res.status).toBe(400);
      expect(
        (await memDb.rowsOf("sales_orders"))
          .filter((r) => r.organizationId === ORG_B).length,
      ).toBe(beforeCount);
    });
  });
});
