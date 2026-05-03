// Cross-tenant isolation tests for the einvoice router.
//
// Mirrors `jobWorkOrders.tenant.test.ts`: ORG_A=1001 / ORG_B=2002,
// each seeded with their own organization row, owner membership,
// customer, item, sales order. We then assert that no endpoint
// (connection management, per-order generate/cancel/qr, bulk batch
// readback) ever leaks data from the other tenant.
//
// Heavy IRP/network behaviour (`generateIrn`, `cancelIrn`,
// `einvoiceAuthLogin`) is exhaustively covered by `einvoice.test.ts`.
// Here we only need their isolation surface, so we mock the lib down
// to the smallest signature each route consumes.

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

// ── Mock external/lib dependencies before importing the router ──────

vi.mock("@workspace/db", () => createInMemoryDbModuleMock());

vi.mock("../../src/lib/tenant", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/lib/tenant")>(
      "../../src/lib/tenant",
    );
  return {
    ...actual,
    tenantMiddleware: (req: Request, res: Response, next: NextFunction) => {
      const orgId = Number(req.header("x-test-org-id"));
      if (!Number.isFinite(orgId) || orgId <= 0) {
        res.status(401).json({ error: "missing x-test-org-id header" });
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

vi.mock("../../src/lib/encryption", () => ({
  encryptString: (s: string) => `enc:${s}`,
  decryptString: (s: string) => s.replace(/^enc:/u, ""),
}));

vi.mock("../../src/lib/einvoice", () => ({
  einvoiceAuthLogin: vi.fn(async () => ({
    token: "TKN",
    expiresAt: new Date(Date.now() + 3600_000),
  })),
  generateIrn: vi.fn(async () => ({
    irn: "IRN-FRESH",
    ackNumber: "ACK-1",
    ackDate: "2026-05-01 10:00:00",
    signedQrCode: "qr-data",
  })),
  cancelIrn: vi.fn(async () => ({ cancelledAt: "2026-05-02 11:00:00" })),
  parseIrpAckDate: (s: string | null | undefined) => (s ? new Date() : null),
  isIrpCancellable: () => true,
  EinvoiceApiError: class extends Error {
    status = 400;
    code: string | null = null;
    context: unknown = null;
  },
  EinvoiceAuthError: class extends Error {},
  EinvoiceNotConnectedError: class extends Error {},
}));

vi.mock("../../src/lib/einvoicePayload", () => ({
  buildIrnPayloadFromOrder: () => ({ payload: { fake: true } }),
}));

vi.mock("qrcode", () => ({
  default: { toBuffer: vi.fn(async () => Buffer.from("png")) },
  toBuffer: vi.fn(async () => Buffer.from("png")),
}));

import einvoiceRouter from "../../src/routes/einvoice";

const ORG_A = 1001;
const ORG_B = 2002;

interface OrgFixture {
  orgId: number;
  customerId: number;
  customerName: string;
  itemId: number;
  salesOrderId: number;
  salesOrderNumber: string;
  bulkBatchId: string;
  gstin: string;
}

async function seedOrg(label: "A" | "B", orgId: number): Promise<OrgFixture> {
  const gstin = label === "A" ? "27ABCDE1234F1Z5" : "29ZZZZZ9999Z1Z5";
  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
    gstNumber: gstin,
    state: "Maharashtra",
    eInvoiceEnabled: true,
    eInvoiceGstin: gstin,
    eInvoiceApiUsername: `user_${label.toLowerCase()}`,
    eInvoiceApiPasswordEncrypted: "enc:pw",
    eInvoiceClientIdEncrypted: null,
    eInvoiceClientSecretEncrypted: null,
    eInvoiceTokenEncrypted: "enc:tkn",
    eInvoiceTokenExpiresAt: new Date(Date.now() + 3600_000),
    eInvoiceConnectedAt: new Date(),
    eInvoiceLastErrorAt: null,
    eInvoiceLastErrorMessage: null,
  });
  await memDb.seed(tables.organizationMembersTable, {
    organizationId: orgId,
    userId: orgId * 10,
    role: "owner",
  });
  const customer = await memDb.seed(tables.customersTable, {
    organizationId: orgId,
    name: `Customer ${label}`,
    company: `${label} Pvt Ltd`,
    gstNumber: gstin,
    billingAddress: "1 Road",
    shippingAddress: "1 Road",
    placeOfSupply: "Maharashtra",
    email: null,
    phone: null,
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
    unit: "ea",
    salePrice: "100",
    purchasePrice: "50",
    hsnCode: "1234",
    taxRate: "18",
    archivedAt: null,
  });
  const so = await memDb.seed(tables.salesOrdersTable, {
    organizationId: orgId,
    orderNumber: `INV-${label}-1`,
    customerId: customer.id,
    warehouseId: warehouse.id,
    status: "shipped",
    orderDate: "2026-05-01",
    subtotal: "100",
    taxTotal: "18",
    total: "118",
    amountPaid: "0",
    balanceDue: "118",
    irn: label === "B" ? "IRN-EXISTING-B" : null,
    irpStatus: label === "B" ? "active" : null,
    irpAckDate: label === "B" ? new Date() : null,
    irpQrPayload: label === "B" ? "qr-b" : null,
    irpAckNumber: label === "B" ? "ACK-B" : null,
  });
  await memDb.seed(tables.salesOrderLinesTable, {
    organizationId: orgId,
    salesOrderId: so.id,
    itemId: item.id,
    description: null,
    quantity: "1",
    unitPrice: "100",
    taxRate: "18",
    lineSubtotal: "100",
    lineTax: "18",
    lineTotal: "118",
  });
  const bulkBatchId = `batch-${label.toLowerCase()}-1`;
  await memDb.seed(tables.einvoiceBulkBatchesTable, {
    id: bulkBatchId,
    organizationId: orgId,
    status: "completed",
    total: 1,
    processed: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
    orderIdsInOrder: [so.id],
    results: {
      [String(so.id)]: {
        orderId: so.id,
        orderNumber: `INV-${label}-1`,
        status: "success",
        message: null,
        errorCode: null,
        irn: label === "B" ? "IRN-EXISTING-B" : null,
        ackNumber: null,
        ackDate: null,
      },
    },
    concurrency: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: new Date(),
    completedAt: new Date(),
    recoveryClaimedAt: new Date(),
  });
  return {
    orgId,
    customerId: customer.id as number,
    customerName: `Customer ${label}`,
    itemId: item.id as number,
    salesOrderId: so.id as number,
    salesOrderNumber: `INV-${label}-1`,
    bulkBatchId,
    gstin,
  };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(einvoiceRouter);
  // Surface errors as JSON so failing tests have something useful
  // to diagnose against (the default Express handler returns an
  // HTML page that supertest can't introspect easily).
  app.use(
    (
      err: Error,
      _req: Request,
      res: Response,
      _next: NextFunction,
    ): void => {
      res.status(500).json({ error: err.message, stack: err.stack });
    },
  );
  return app;
}

describe("einvoice cross-tenant isolation", () => {
  let app: Express;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeEach(async () => {
    await memDb.reset();
    a = await seedOrg("A", ORG_A);
    b = await seedOrg("B", ORG_B);
    app = buildApp();
  });

  describe("auth", () => {
    const endpoints: Array<["get" | "post" | "patch" | "delete", string]> = [
      ["get", "/einvoice/connection"],
      ["post", "/einvoice/connection"],
      ["patch", "/einvoice/connection"],
      ["delete", "/einvoice/connection"],
      ["post", `/sales-orders/1/einvoice/generate`],
      ["post", `/sales-orders/1/einvoice/cancel`],
      ["get", `/sales-orders/1/einvoice/qr.png`],
      ["post", "/einvoice/bulk"],
      ["get", `/einvoice/bulk/anything`],
    ];
    for (const [method, path] of endpoints) {
      it(`rejects ${method.toUpperCase()} ${path} without an x-test-org-id header`, async () => {
        const res = await (request(app) as unknown as Record<
          string,
          (p: string) => request.Test
        >)[method]!(path);
        expect(res.status).toBe(401);
      });
    }
  });

  describe("GET /einvoice/connection", () => {
    it("returns only the caller's GSTIN", async () => {
      const res = await request(app)
        .get("/einvoice/connection")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      expect(res.body.gstin).toBe(a.gstin);
      expect(res.body.gstin).not.toBe(b.gstin);
      expect(res.body.connected).toBe(true);
    });

    it("ORG_B sees its own credentials", async () => {
      const res = await request(app)
        .get("/einvoice/connection")
        .set("x-test-org-id", String(ORG_B));
      expect(res.status).toBe(200);
      expect(res.body.gstin).toBe(b.gstin);
      expect(res.body.gstin).not.toBe(a.gstin);
    });
  });

  describe("PATCH /einvoice/connection", () => {
    it("only flips the caller's enabled flag", async () => {
      const res = await request(app)
        .patch("/einvoice/connection")
        .set("x-test-org-id", String(ORG_A))
        .send({ enabled: false });
      expect(res.status).toBe(200);
      // Walk the in-memory rows directly: ORG_A flipped, ORG_B
      // untouched.
      const orgs = (await memDb.rowsOf(tables.organizationsTable.__table));
      const aRow = orgs.find((r) => r.id === ORG_A);
      const bRow = orgs.find((r) => r.id === ORG_B);
      expect(aRow?.eInvoiceEnabled).toBe(false);
      expect(bRow?.eInvoiceEnabled).toBe(true);
    });
  });

  describe("DELETE /einvoice/connection", () => {
    it("only wipes the caller's credentials", async () => {
      const res = await request(app)
        .delete("/einvoice/connection")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const orgs = (await memDb.rowsOf(tables.organizationsTable.__table));
      const aRow = orgs.find((r) => r.id === ORG_A);
      const bRow = orgs.find((r) => r.id === ORG_B);
      expect(aRow?.eInvoiceGstin).toBeNull();
      expect(bRow?.eInvoiceGstin).toBe(b.gstin);
    });
  });

  describe("POST /sales-orders/:id/einvoice/generate", () => {
    it("ORG_A requesting ORG_B's sales order id is rejected (no row claimable)", async () => {
      const res = await request(app)
        .post(`/sales-orders/${b.salesOrderId}/einvoice/generate`)
        .set("x-test-org-id", String(ORG_A));
      // The atomic claim filters on (id, organizationId), so ORG_A
      // can't even acquire the claim and we fall through to the
      // 404 / 4xx branch. The key invariant is that ORG_B's order
      // is *not* mutated.
      expect([400, 404, 409]).toContain(res.status);
      const bSo = (await memDb
        .rowsOf(tables.salesOrdersTable.__table))
        .find((r) => r.id === b.salesOrderId);
      expect(bSo?.irn).toBe("IRN-EXISTING-B");
      expect(bSo?.irpStatus).toBe("active");
    });
  });

  describe("POST /sales-orders/:id/einvoice/cancel", () => {
    it("ORG_A cannot cancel ORG_B's IRN", async () => {
      const res = await request(app)
        .post(`/sales-orders/${b.salesOrderId}/einvoice/cancel`)
        .set("x-test-org-id", String(ORG_A))
        .send({ reasonCode: "1", reasonRemark: "duplicate" });
      expect(res.status).toBe(404);
      const bSo = (await memDb
        .rowsOf(tables.salesOrdersTable.__table))
        .find((r) => r.id === b.salesOrderId);
      // ORG_B's IRN must remain active (not cancelled).
      expect(bSo?.irpStatus).toBe("active");
    });
  });

  describe("GET /sales-orders/:id/einvoice/qr.png", () => {
    it("ORG_A cannot fetch ORG_B's signed QR", async () => {
      const res = await request(app)
        .get(`/sales-orders/${b.salesOrderId}/einvoice/qr.png`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
    });

    it("ORG_B sees its own QR (smoke check)", async () => {
      const res = await request(app)
        .get(`/sales-orders/${b.salesOrderId}/einvoice/qr.png`)
        .set("x-test-org-id", String(ORG_B));
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/png/u);
    });
  });

  describe("GET /einvoice/bulk/:batchId", () => {
    it("ORG_A cannot read ORG_B's bulk batch", async () => {
      const res = await request(app)
        .get(`/einvoice/bulk/${b.bulkBatchId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
    });

    it("ORG_B can read its own bulk batch", async () => {
      const res = await request(app)
        .get(`/einvoice/bulk/${b.bulkBatchId}`)
        .set("x-test-org-id", String(ORG_B));
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(b.bulkBatchId);
    });
  });
});
