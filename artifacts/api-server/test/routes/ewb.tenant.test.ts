// Cross-tenant isolation tests for the e-way bill router.
//
// ORG_A=1001 / ORG_B=2002 each have their own org row, owner
// membership, customer, warehouse, item, and a sales order in a
// status that's eligible for EWB generation. ORG_B's sales order
// already has an active EWB so we can also exercise update / cancel
// / qr / pdf isolation.

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

vi.mock("../../src/lib/ewb", () => ({
  ewbAuthLogin: vi.fn(async () => ({
    token: "TKN",
    expiresAt: new Date(Date.now() + 3600_000),
  })),
  generateEwb: vi.fn(async () => ({
    ewayBillNo: "EWB-FRESH",
    ewayBillDate: "01/05/2026 10:00:00 AM",
    validUpto: "02/05/2026 10:00:00 AM",
  })),
  generateEwbByIrn: vi.fn(async () => ({
    ewayBillNo: "EWB-FRESH",
    ewayBillDate: "01/05/2026 10:00:00 AM",
    validUpto: "02/05/2026 10:00:00 AM",
  })),
  updateVehicleEwb: vi.fn(async () => ({
    validUpto: "02/05/2026 10:00:00 AM",
  })),
  cancelEwb: vi.fn(async () => ({
    cancelledAt: "01/05/2026 11:00:00 AM",
  })),
  parseNicDateTime: () => new Date(),
  buildEwbQrPayload: (n: string) => `qr:${n}`,
  EwbApiError: class extends Error {
    status = 400;
  },
  EwbAuthError: class extends Error {},
  EwbNotConnectedError: class extends Error {},
}));

vi.mock("../../src/lib/ewbPdf", () => ({
  renderEwbPdf: vi.fn(async () => Buffer.from("pdf")),
}));

vi.mock("qrcode", () => ({
  default: { toBuffer: vi.fn(async () => Buffer.from("png")) },
  toBuffer: vi.fn(async () => Buffer.from("png")),
}));

import ewbRouter from "../../src/routes/ewb";

const ORG_A = 1001;
const ORG_B = 2002;

interface OrgFixture {
  orgId: number;
  customerId: number;
  warehouseId: number;
  itemId: number;
  salesOrderId: number;
  salesOrderNumber: string;
  gstin: string;
  ewbNumber: string | null;
}

async function seedOrg(label: "A" | "B", orgId: number): Promise<OrgFixture> {
  const gstin = label === "A" ? "27ABCDE1234F1Z5" : "29ZZZZZ9999Z1Z5";
  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
    gstNumber: gstin,
    state: label === "A" ? "Maharashtra" : "Karnataka",
    addressLine1: "1 Brigade Road",
    city: label === "A" ? "Mumbai" : "Bengaluru",
    postalCode: "560001",
    ewbGstin: gstin,
    ewbApiUsername: `user_${label.toLowerCase()}`,
    ewbApiPasswordEncrypted: "enc:pw",
    ewbTokenEncrypted: "enc:tkn",
    ewbTokenExpiresAt: new Date(Date.now() + 3600_000),
    ewbConnectedAt: new Date(),
    ewbLastErrorAt: null,
    ewbLastErrorMessage: null,
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
    billingAddress: "1 MG Road, City - 560001",
    shippingAddress: "1 MG Road, City - 560001",
    placeOfSupply: label === "A" ? "Maharashtra" : "Karnataka",
    email: null,
    phone: null,
    outstandingBalance: "0",
  });
  const warehouse = await memDb.seed(tables.warehousesTable, {
    organizationId: orgId,
    name: `WH ${label}`,
    code: `WH-${label}`,
    addressLine1: "1 Industrial Estate",
    city: label === "A" ? "Mumbai" : "Bengaluru",
    state: label === "A" ? "Maharashtra" : "Karnataka",
    country: "IN",
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
  const ewbNumber = label === "B" ? "EWB-EXISTING-B" : null;
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
    ewbNumber,
    ewbStatus: ewbNumber ? "active" : null,
    ewbDate: ewbNumber ? new Date() : null,
    ewbValidUntil: ewbNumber ? new Date(Date.now() + 86_400_000) : null,
    ewbQrPayload: ewbNumber ? `qr:${ewbNumber}` : null,
    ewbVehicleNumber: ewbNumber ? "MH01AB1234" : null,
    ewbTransportMode: ewbNumber ? "1" : null,
    ewbTransporterName: null,
    ewbTransporterId: null,
    ewbDistanceKm: ewbNumber ? 100 : null,
    ewbDispatchAddress: null,
    ewbShipToAddress: null,
    ewbCancelledAt: null,
    ewbCancelReason: null,
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
  return {
    orgId,
    customerId: customer.id as number,
    warehouseId: warehouse.id as number,
    itemId: item.id as number,
    salesOrderId: so.id as number,
    salesOrderNumber: `INV-${label}-1`,
    gstin,
    ewbNumber,
  };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(ewbRouter);
  app.use(
    (
      err: Error,
      _req: Request,
      res: Response,
      _next: NextFunction,
    ): void => {
      res.status(500).json({ error: err.message });
    },
  );
  return app;
}

describe("ewb cross-tenant isolation", () => {
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
    const endpoints: Array<["get" | "post" | "delete", string]> = [
      ["get", "/ewb/connection"],
      ["post", "/ewb/connection"],
      ["delete", "/ewb/connection"],
      ["post", `/sales-orders/1/ewb/generate`],
      ["post", `/sales-orders/1/ewb/update-vehicle`],
      ["post", `/sales-orders/1/ewb/cancel`],
      ["get", `/sales-orders/1/ewb/qr.png`],
      ["get", `/sales-orders/1/ewb.pdf`],
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

  describe("GET /ewb/connection", () => {
    it("returns only the caller's GSTIN", async () => {
      const res = await request(app)
        .get("/ewb/connection")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      expect(res.body.gstin).toBe(a.gstin);
      expect(res.body.gstin).not.toBe(b.gstin);
    });

    it("ORG_B sees its own credentials", async () => {
      const res = await request(app)
        .get("/ewb/connection")
        .set("x-test-org-id", String(ORG_B));
      expect(res.status).toBe(200);
      expect(res.body.gstin).toBe(b.gstin);
    });
  });

  describe("DELETE /ewb/connection", () => {
    it("only wipes the caller's credentials", async () => {
      const res = await request(app)
        .delete("/ewb/connection")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      const orgs = (await memDb.rowsOf(tables.organizationsTable.__table));
      const aRow = orgs.find((r) => r.id === ORG_A);
      const bRow = orgs.find((r) => r.id === ORG_B);
      expect(aRow?.ewbGstin).toBeNull();
      expect(bRow?.ewbGstin).toBe(b.gstin);
    });
  });

  describe("POST /sales-orders/:id/ewb/update-vehicle", () => {
    it("ORG_A cannot update ORG_B's active EWB", async () => {
      const res = await request(app)
        .post(`/sales-orders/${b.salesOrderId}/ewb/update-vehicle`)
        .set("x-test-org-id", String(ORG_A))
        .send({
          vehicleNumber: "MH99XX9999",
          fromPlace: "Mumbai",
          fromState: 27,
          reasonCode: "1",
        });
      expect(res.status).toBe(404);
      const bSo = (await memDb
        .rowsOf(tables.salesOrdersTable.__table))
        .find((r) => r.id === b.salesOrderId);
      // ORG_B's vehicle number must not have changed.
      expect(bSo?.ewbVehicleNumber).toBe("MH01AB1234");
    });
  });

  describe("POST /sales-orders/:id/ewb/cancel", () => {
    it("ORG_A cannot cancel ORG_B's EWB", async () => {
      const res = await request(app)
        .post(`/sales-orders/${b.salesOrderId}/ewb/cancel`)
        .set("x-test-org-id", String(ORG_A))
        .send({ reasonCode: "1", reasonRem: "duplicate" });
      expect(res.status).toBe(404);
      const bSo = (await memDb
        .rowsOf(tables.salesOrdersTable.__table))
        .find((r) => r.id === b.salesOrderId);
      expect(bSo?.ewbStatus).toBe("active");
    });
  });

  describe("GET /sales-orders/:id/ewb/qr.png", () => {
    it("ORG_A cannot fetch ORG_B's EWB QR", async () => {
      const res = await request(app)
        .get(`/sales-orders/${b.salesOrderId}/ewb/qr.png`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
    });

    it("ORG_B can fetch its own EWB QR", async () => {
      const res = await request(app)
        .get(`/sales-orders/${b.salesOrderId}/ewb/qr.png`)
        .set("x-test-org-id", String(ORG_B));
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/png/u);
    });
  });

  describe("GET /sales-orders/:id/ewb.pdf", () => {
    it("ORG_A cannot fetch ORG_B's EWB PDF", async () => {
      const res = await request(app)
        .get(`/sales-orders/${b.salesOrderId}/ewb.pdf`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
    });

    it("ORG_B can fetch its own EWB PDF", async () => {
      const res = await request(app)
        .get(`/sales-orders/${b.salesOrderId}/ewb.pdf`)
        .set("x-test-org-id", String(ORG_B));
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/pdf/u);
    });
  });
});
