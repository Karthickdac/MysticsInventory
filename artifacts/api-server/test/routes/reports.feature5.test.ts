// Feature 5 smoke tests — the report filters, the two new endpoints
// (/reports/returns, /reports/discounts), strict query-param
// validation, and the Feature-4 shipment cancel-reason fields the
// returns report depends on.

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

import reportsRouter from "../../src/routes/reports";

const ORG = 7001;
const OTHER_ORG = 7002;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(reportsRouter);
  return app;
}

interface SeedHandles {
  customerId: number;
  warehouseId: number;
  itemId: number;
  item2Id: number;
  itemSku: string;
  soOldId: number;
  soNewId: number;
  shipmentOldId: number;
  shipmentNewId: number;
  soOldLineId: number;
  soNewLineId: number;
}

async function seed(orgId: number): Promise<SeedHandles> {
  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${orgId}`,
    slug: `org-${orgId}`,
    gstNumber: "27ABCDE1234F1Z5",
    state: "Maharashtra",
  });
  const customer = await memDb.seed(tables.customersTable, {
    organizationId: orgId,
    name: `Customer ${orgId}`,
    email: null,
    phone: null,
    company: null,
    gstNumber: null,
    billingAddress: null,
    shippingAddress: null,
    placeOfSupply: "Maharashtra",
    notes: null,
    outstandingBalance: "0",
  });
  const warehouse = await memDb.seed(tables.warehousesTable, {
    organizationId: orgId,
    name: `WH ${orgId}`,
    code: `WH-${orgId}`,
    isVirtual: false,
    isDefault: true,
  });
  const item = await memDb.seed(tables.itemsTable, {
    organizationId: orgId,
    name: `Item ${orgId}`,
    sku: `SKU-${orgId}`,
    description: null,
    category: null,
    unit: "ea",
    barcode: null,
    salePrice: "100",
    purchasePrice: "50",
    hsnCode: "1234",
    taxRate: "18",
    reorderLevel: "0",
    imageUrl: null,
    hasVariants: false,
    isBundle: false,
    trackBatches: false,
    parentItemId: null,
    variantOptions: null,
    archivedAt: null,
  });
  const item2 = await memDb.seed(tables.itemsTable, {
    organizationId: orgId,
    name: `Item2 ${orgId}`,
    sku: `SKU2-${orgId}`,
    description: null,
    category: null,
    unit: "ea",
    barcode: null,
    salePrice: "200",
    purchasePrice: "100",
    hsnCode: "1234",
    taxRate: "18",
    reorderLevel: "0",
    imageUrl: null,
    hasVariants: false,
    isBundle: false,
    trackBatches: false,
    parentItemId: null,
    variantOptions: null,
    archivedAt: null,
  });
  // Two sales orders on two different dates — used to verify the
  // /reports/sales-summary date filter and the /reports/discounts
  // trend windowing.
  const soOld = await memDb.seed(tables.salesOrdersTable, {
    organizationId: orgId,
    orderNumber: `SO-${orgId}-OLD`,
    customerId: customer.id,
    warehouseId: warehouse.id,
    status: "confirmed",
    orderDate: "2024-01-15",
    expectedShipDate: null,
    subtotal: "1000",
    taxTotal: "0",
    total: "1000",
    amountPaid: "0",
    balanceDue: "1000",
    notes: null,
  });
  const soNew = await memDb.seed(tables.salesOrdersTable, {
    organizationId: orgId,
    orderNumber: `SO-${orgId}-NEW`,
    customerId: customer.id,
    warehouseId: warehouse.id,
    status: "confirmed",
    orderDate: "2024-06-15",
    expectedShipDate: null,
    subtotal: "2000",
    taxTotal: "0",
    total: "2000",
    amountPaid: "0",
    balanceDue: "2000",
    notes: null,
  });
  // Three SO lines with discounts so /reports/discounts has both
  // multi-item and multi-line rollup coverage:
  //   soOld / item1: explicit 100 off, qty 1
  //   soNew / item1: 10% off, qty 2 → 200
  //   soNew / item2: explicit 50 off, qty 4
  const soOldLine = await memDb.seed(tables.salesOrderLinesTable, {
    organizationId: orgId,
    salesOrderId: soOld.id,
    itemId: item.id,
    description: null,
    quantity: "1",
    quantityShipped: "1",
    unitPrice: "1000",
    discountAmount: "100",
    discountPercent: "0",
    taxRate: "0",
    lineSubtotal: "900",
    lineTax: "0",
    lineTotal: "900",
  });
  const soNewLine = await memDb.seed(tables.salesOrderLinesTable, {
    organizationId: orgId,
    salesOrderId: soNew.id,
    itemId: item.id,
    description: null,
    quantity: "2",
    quantityShipped: "2",
    unitPrice: "1000",
    discountAmount: null,
    discountPercent: "10",
    taxRate: "0",
    lineSubtotal: "1800",
    lineTax: "0",
    lineTotal: "1800",
  });
  await memDb.seed(tables.salesOrderLinesTable, {
    organizationId: orgId,
    salesOrderId: soNew.id,
    itemId: item2.id,
    description: null,
    quantity: "4",
    quantityShipped: "4",
    unitPrice: "200",
    discountAmount: "50",
    discountPercent: "0",
    taxRate: "0",
    lineSubtotal: "750",
    lineTax: "0",
    lineTotal: "750",
  });
  // Two cancelled shipments with different reason codes for the
  // /reports/returns aggregation.
  const shipOld = await memDb.seed(tables.shipmentsTable, {
    organizationId: orgId,
    salesOrderId: soOld.id,
    shipmentNumber: `SH-${orgId}-OLD`,
    shipDate: "2024-01-16",
    status: "cancelled",
    notes: null,
    cancelReasonCode: "damaged",
    cancelReasonNotes: "box crushed",
    cancelledAt: new Date("2024-01-20T10:00:00.000Z"),
  });
  const shipNew = await memDb.seed(tables.shipmentsTable, {
    organizationId: orgId,
    salesOrderId: soNew.id,
    shipmentNumber: `SH-${orgId}-NEW`,
    shipDate: "2024-06-16",
    status: "cancelled",
    notes: null,
    cancelReasonCode: "customer_changed_mind",
    cancelReasonNotes: null,
    cancelledAt: new Date("2024-06-20T10:00:00.000Z"),
  });
  // shipmentLines so /reports/returns can sum unitsReturned:
  //   shipOld → 3 units of item1
  //   shipNew → 5 units of item1 + 2 units of item2 (line-fanout)
  await memDb.seed(tables.shipmentLinesTable, {
    organizationId: orgId,
    shipmentId: shipOld.id,
    salesOrderLineId: soOldLine.id,
    quantity: "3",
  });
  await memDb.seed(tables.shipmentLinesTable, {
    organizationId: orgId,
    shipmentId: shipNew.id,
    salesOrderLineId: soNewLine.id,
    quantity: "5",
  });
  await memDb.seed(tables.shipmentLinesTable, {
    organizationId: orgId,
    shipmentId: shipNew.id,
    salesOrderLineId: soNewLine.id,
    quantity: "2",
  });
  return {
    customerId: customer.id as number,
    warehouseId: warehouse.id as number,
    itemId: item.id as number,
    item2Id: item2.id as number,
    itemSku: `SKU-${orgId}`,
    soOldId: soOld.id as number,
    soNewId: soNew.id as number,
    shipmentOldId: shipOld.id as number,
    shipmentNewId: shipNew.id as number,
    soOldLineId: soOldLine.id as number,
    soNewLineId: soNewLine.id as number,
  };
}

describe("Feature 5 — reports filters + new endpoints", () => {
  let app: Express;
  let h: SeedHandles;

  beforeEach(async () => {
    await memDb.reset();
    h = await seed(ORG);
    await seed(OTHER_ORG); // noise — should never leak
    app = buildApp();
  });

  describe("GET /reports/sales-summary date filter", () => {
    it("totals both orders without filters", async () => {
      const r = await request(app)
        .get("/reports/sales-summary")
        .set("x-test-org-id", String(ORG));
      expect(r.status).toBe(200);
      expect(r.body.totalSales).toBe(3000);
      expect(r.body.orderCount).toBe(2);
    });
    it("respects from/to and excludes the older order", async () => {
      const r = await request(app)
        .get("/reports/sales-summary?from=2024-06-01&to=2024-06-30")
        .set("x-test-org-id", String(ORG));
      expect(r.status).toBe(200);
      expect(r.body.totalSales).toBe(2000);
      expect(r.body.orderCount).toBe(1);
      // Trend should be windowed to the filter range, not last 30 days
      // from today.
      expect(r.body.trend.length).toBeGreaterThan(0);
      expect(r.body.trend[0].date).toBe("2024-06-01");
      expect(r.body.trend.at(-1).date).toBe("2024-06-30");
    });
    it("rejects invalid date format with 400", async () => {
      const r = await request(app)
        .get("/reports/sales-summary?from=yesterday")
        .set("x-test-org-id", String(ORG));
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_from");
    });
    it("rejects from > to with 400 invalid_range", async () => {
      const r = await request(app)
        .get("/reports/sales-summary?from=2024-12-01&to=2024-01-01")
        .set("x-test-org-id", String(ORG));
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_range");
    });
    it("rejects non-positive customerId with 400", async () => {
      const r = await request(app)
        .get("/reports/sales-summary?customerId=abc")
        .set("x-test-org-id", String(ORG));
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_customerId");
    });
  });

  describe("GET /reports/returns", () => {
    it("lists both cancelled shipments and aggregates unitsReturned + byReason", async () => {
      const r = await request(app)
        .get("/reports/returns")
        .set("x-test-org-id", String(ORG));
      expect(r.status).toBe(200);
      expect(r.body.totalShipments).toBe(2);
      // shipOld=3, shipNew=5+2=7 → total 10.
      expect(r.body.totalUnits).toBe(10);
      const byReason = [...r.body.byReason].sort(
        (a: { reasonCode: string }, b: { reasonCode: string }) =>
          a.reasonCode.localeCompare(b.reasonCode),
      );
      expect(byReason).toEqual([
        { reasonCode: "customer_changed_mind", shipmentCount: 1, unitsReturned: 7 },
        { reasonCode: "damaged", shipmentCount: 1, unitsReturned: 3 },
      ]);
      // Rows are newest-first by cancelledAt.
      expect(r.body.rows[0].cancelReasonCode).toBe("customer_changed_mind");
      expect(r.body.rows[0].unitsReturned).toBe(7);
      expect(r.body.rows[0].cancelReasonNotes).toBeNull();
      expect(r.body.rows[1].cancelReasonCode).toBe("damaged");
      expect(r.body.rows[1].unitsReturned).toBe(3);
      expect(r.body.rows[1].cancelReasonNotes).toBe("box crushed");
    });
    it("filters by reasonCode", async () => {
      const r = await request(app)
        .get("/reports/returns?reasonCode=damaged")
        .set("x-test-org-id", String(ORG));
      expect(r.status).toBe(200);
      expect(r.body.totalShipments).toBe(1);
      expect(r.body.totalUnits).toBe(3);
      expect(r.body.rows[0].cancelReasonCode).toBe("damaged");
    });
    it("filters by from/to on cancelledAt", async () => {
      const r = await request(app)
        .get("/reports/returns?from=2024-06-01&to=2024-06-30")
        .set("x-test-org-id", String(ORG));
      expect(r.status).toBe(200);
      expect(r.body.totalShipments).toBe(1);
      expect(r.body.totalUnits).toBe(7);
      expect(r.body.rows[0].cancelReasonCode).toBe("customer_changed_mind");
    });
    it("filters by customerId", async () => {
      const r = await request(app)
        .get(`/reports/returns?customerId=${h.customerId}`)
        .set("x-test-org-id", String(ORG));
      expect(r.status).toBe(200);
      expect(r.body.totalShipments).toBe(2);
    });
    it("rejects invalid date with 400 { error: 'invalid_from' }", async () => {
      const r = await request(app)
        .get("/reports/returns?from=2024/01/01")
        .set("x-test-org-id", String(ORG));
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_from");
    });
    it("rejects from > to with 400 invalid_range", async () => {
      const r = await request(app)
        .get("/reports/returns?from=2024-12-01&to=2024-01-01")
        .set("x-test-org-id", String(ORG));
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_range");
    });
    it("rejects oversized reasonCode (>64) with 400 invalid_reasonCode", async () => {
      const r = await request(app)
        .get(`/reports/returns?reasonCode=${"x".repeat(65)}`)
        .set("x-test-org-id", String(ORG));
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_reasonCode");
    });
    it("rejects bad warehouseId with 400", async () => {
      const r = await request(app)
        .get("/reports/returns?warehouseId=0")
        .set("x-test-org-id", String(ORG));
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_warehouseId");
    });
    it("does not leak the other org's cancelled shipments", async () => {
      const r = await request(app)
        .get("/reports/returns")
        .set("x-test-org-id", String(ORG));
      const orderIds = r.body.rows.map(
        (x: { salesOrderId: number }) => x.salesOrderId,
      );
      expect(orderIds.sort()).toEqual([h.soOldId, h.soNewId].sort());
    });
  });

  describe("GET /reports/discounts", () => {
    it("sums explicit + percent discounts and rolls up by item (two items, ordered by discountTotal desc)", async () => {
      const r = await request(app)
        .get("/reports/discounts")
        .set("x-test-org-id", String(ORG));
      expect(r.status).toBe(200);
      // line A (item1, soOld): explicit 100. line B (item1, soNew): 10% * 2 * 1000 = 200. line C (item2, soNew): 50.
      // total = 350. item1 = 300, item2 = 50.
      expect(r.body.totalDiscount).toBe(350);
      expect(r.body.lineCount).toBe(3);
      expect(r.body.orderCount).toBe(2);
      expect(r.body.byItem.length).toBe(2);
      // Ordered by discountTotal desc.
      expect(r.body.byItem[0].itemId).toBe(h.itemId);
      expect(r.body.byItem[0].discountTotal).toBe(300);
      expect(r.body.byItem[0].unitsDiscounted).toBe(3); // 1 + 2
      expect(r.body.byItem[1].itemId).toBe(h.item2Id);
      expect(r.body.byItem[1].discountTotal).toBe(50);
      expect(r.body.byItem[1].unitsDiscounted).toBe(4);
    });
    it("date filter narrows window and re-buckets trend within from/to", async () => {
      const r = await request(app)
        .get("/reports/discounts?from=2024-06-01&to=2024-06-30")
        .set("x-test-org-id", String(ORG));
      expect(r.status).toBe(200);
      // soNew's two lines: 200 + 50 = 250.
      expect(r.body.totalDiscount).toBe(250);
      expect(r.body.lineCount).toBe(2);
      expect(r.body.orderCount).toBe(1);
      expect(Array.isArray(r.body.trend)).toBe(true);
      expect(r.body.trend.length).toBeGreaterThan(0);
      expect(r.body.trend[0].date).toBe("2024-06-01");
      expect(r.body.trend.at(-1).date).toBe("2024-06-30");
      // The only non-zero bucket is 2024-06-15.
      const bucket = r.body.trend.find(
        (b: { date: string }) => b.date === "2024-06-15",
      );
      expect(bucket).toBeTruthy();
      expect(bucket.discountTotal).toBe(250);
      // Buckets outside the spike are zero, not missing.
      const otherBucket = r.body.trend.find(
        (b: { date: string }) => b.date === "2024-06-10",
      );
      expect(otherBucket.discountTotal).toBe(0);
    });
    it("itemId filter narrows to item1 only", async () => {
      const r = await request(app)
        .get(`/reports/discounts?itemId=${h.itemId}`)
        .set("x-test-org-id", String(ORG));
      expect(r.status).toBe(200);
      expect(r.body.totalDiscount).toBe(300);
      expect(r.body.byItem).toHaveLength(1);
      expect(r.body.byItem[0].itemId).toBe(h.itemId);
    });
    it("unknown item returns zeros, not an error", async () => {
      const r = await request(app)
        .get("/reports/discounts?itemId=999999")
        .set("x-test-org-id", String(ORG));
      expect(r.status).toBe(200);
      expect(r.body.totalDiscount).toBe(0);
      expect(r.body.byItem).toEqual([]);
    });
    it("rejects negative itemId with 400", async () => {
      const r = await request(app)
        .get("/reports/discounts?itemId=-3")
        .set("x-test-org-id", String(ORG));
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_itemId");
    });
    it("rejects bad customerId with 400", async () => {
      const r = await request(app)
        .get("/reports/discounts?customerId=abc")
        .set("x-test-org-id", String(ORG));
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_customerId");
    });
  });
});
