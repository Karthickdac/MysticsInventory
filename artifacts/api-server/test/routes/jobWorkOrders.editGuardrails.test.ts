// Tests for the PATCH /job-work-orders/:id edit guardrails.
//
// The route splits into three behaviours based on the order's status:
//   * draft: full edit is allowed (quantity, components, rate, …)
//   * issued / partially_received: rate-only edit (plus expected
//     return date and notes); every other field is rejected.
//   * completed / cancelled: every edit is rejected.
//
// We additionally assert that editing the rate after stock has moved
// does NOT re-price historical receipts or the auto-generated
// supplier bills they produced.

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
vi.mock("../../src/lib/tenant", () => ({
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
  assertOwnership: async () => ({ ok: true as const }),
  findParentItems: async () => [],
  findBundleItems: async () => [],
  getDefaultWarehouseId: async () => 1,
}));

import jobWorkOrdersRouter from "../../src/routes/jobWorkOrders";

const ORG = 7001;

interface Fixture {
  supplierId: number;
  outputItemId: number;
  componentItemId: number;
  altComponentItemId: number;
  sourceWarehouseId: number;
  destWarehouseId: number;
  vendorWarehouseId: number;
  jwoId: number;
}

// Seed an org with a JWO in the requested status. The order has one
// component (a second component item is also seeded so full-edit
// tests can swap the component list).
async function seed(status: string): Promise<Fixture> {
  await memDb.seed(tables.organizationsTable, {
    id: ORG,
    name: "Org",
    slug: "org",
  });
  const supplier = await memDb.seed(tables.suppliersTable, {
    organizationId: ORG,
    name: "Worker",
    isJobWorker: true,
    outstandingPayable: "0",
  });
  const outputItem = await memDb.seed(tables.itemsTable, {
    organizationId: ORG,
    name: "Output",
    sku: "OUT",
    hasVariants: false,
    isBundle: false,
    archivedAt: null,
  });
  const componentItem = await memDb.seed(tables.itemsTable, {
    organizationId: ORG,
    name: "Comp",
    sku: "COMP",
    hasVariants: false,
    isBundle: false,
    archivedAt: null,
  });
  const altComponentItem = await memDb.seed(tables.itemsTable, {
    organizationId: ORG,
    name: "Comp2",
    sku: "COMP2",
    hasVariants: false,
    isBundle: false,
    archivedAt: null,
  });
  const source = await memDb.seed(tables.warehousesTable, {
    organizationId: ORG,
    name: "Main",
    code: "MAIN",
    isVirtual: false,
    isDefault: true,
    jobWorkerSupplierId: null,
  });
  const dest = await memDb.seed(tables.warehousesTable, {
    organizationId: ORG,
    name: "Finished",
    code: "FIN",
    isVirtual: false,
    isDefault: false,
    jobWorkerSupplierId: null,
  });
  const vendor = await memDb.seed(tables.warehousesTable, {
    organizationId: ORG,
    name: "Worker premises",
    code: `JW-${supplier.id}`,
    isVirtual: true,
    isDefault: false,
    jobWorkerSupplierId: supplier.id,
  });
  await memDb.seed(tables.itemWarehouseStockTable, {
    organizationId: ORG,
    itemId: componentItem.id,
    warehouseId: source.id,
    quantity: "100",
  });

  const jwo = await memDb.seed(tables.jobWorkOrdersTable, {
    organizationId: ORG,
    jwoNumber: "JWO-1",
    supplierId: supplier.id,
    outputItemId: outputItem.id,
    outputQuantity: "10",
    sourceWarehouseId: source.id,
    destWarehouseId: dest.id,
    vendorWarehouseId: vendor.id,
    jobChargeRate: "5",
    expectedReturnDate: null,
    notes: null,
    status,
  });
  await memDb.seed(tables.jobWorkOrderComponentsTable, {
    organizationId: ORG,
    jobWorkOrderId: jwo.id,
    componentItemId: componentItem.id,
    quantityPerOutput: "2",
    totalQuantity: "20",
  });

  return {
    supplierId: supplier.id as number,
    outputItemId: outputItem.id as number,
    componentItemId: componentItem.id as number,
    altComponentItemId: altComponentItem.id as number,
    sourceWarehouseId: source.id as number,
    destWarehouseId: dest.id as number,
    vendorWarehouseId: vendor.id as number,
    jwoId: jwo.id as number,
  };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(jobWorkOrdersRouter);
  return app;
}

describe("PATCH /job-work-orders/:id — draft full-edit path", () => {
  let app: Express;
  let f: Fixture;

  beforeEach(async () => {
    await memDb.reset();
    f = await seed("draft");
    app = buildApp();
  });

  it("accepts a full edit (quantity, rate, components, dates, notes)", async () => {
    const res = await request(app)
      .patch(`/job-work-orders/${f.jwoId}`)
      .set("x-test-org-id", String(ORG))
      .send({
        outputQuantity: 25,
        jobChargeRate: 12,
        expectedReturnDate: "2026-06-30",
        notes: "updated",
        components: [
          { componentItemId: f.altComponentItemId, quantityPerOutput: 3 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({
      outputQuantity: 25,
      jobChargeRate: 12,
      expectedReturnDate: "2026-06-30",
      notes: "updated",
      status: "draft",
    });
    // Components were replaced — only the new component item remains.
    expect(res.body.components).toHaveLength(1);
    expect(res.body.components[0]).toMatchObject({
      componentItemId: f.altComponentItemId,
      quantityPerOutput: 3,
    });

    const stored = (await memDb.rowsOf("job_work_orders"))
      .find((r) => r.id === f.jwoId) as {
      outputQuantity: string;
      jobChargeRate: string;
    };
    expect(Number(stored.outputQuantity)).toBe(25);
    expect(Number(stored.jobChargeRate)).toBe(12);
  });
});

describe("PATCH /job-work-orders/:id — issued / partially_received rate-only path", () => {
  let app: Express;

  beforeEach(async () => {
    await memDb.reset();
    app = buildApp();
  });

  for (const status of ["issued", "partially_received"]) {
    describe(`status=${status}`, () => {
      let f: Fixture;
      beforeEach(async () => {
        await memDb.reset();
        f = await seed(status);
        app = buildApp();
      });

      it("accepts a jobChargeRate edit", async () => {
        const res = await request(app)
          .patch(`/job-work-orders/${f.jwoId}`)
          .set("x-test-org-id", String(ORG))
          .send({ jobChargeRate: 9 });
        expect(res.status).toBe(200);
        expect(res.body.order.jobChargeRate).toBe(9);
        expect(res.body.order.status).toBe(status);

        const stored = (await memDb.rowsOf("job_work_orders"))
          .find((r) => r.id === f.jwoId) as { jobChargeRate: string };
        expect(Number(stored.jobChargeRate)).toBe(9);
      });

      it("accepts expectedReturnDate and notes alongside the rate", async () => {
        const res = await request(app)
          .patch(`/job-work-orders/${f.jwoId}`)
          .set("x-test-org-id", String(ORG))
          .send({
            jobChargeRate: 7,
            expectedReturnDate: "2026-09-01",
            notes: "renegotiated",
          });
        expect(res.status).toBe(200);
        expect(res.body.order).toMatchObject({
          jobChargeRate: 7,
          expectedReturnDate: "2026-09-01",
          notes: "renegotiated",
        });
      });

      it.each([
        ["outputQuantity", { outputQuantity: 99 }],
        ["sourceWarehouseId", { sourceWarehouseId: 2 }],
        ["destWarehouseId", { destWarehouseId: 3 }],
        ["supplierId", { supplierId: 4 }],
        ["outputItemId", { outputItemId: 5 }],
        [
          "components",
          {
            components: [
              { componentItemId: 1, quantityPerOutput: 1 },
            ],
          },
        ],
      ])("rejects an edit that touches %s", async (_label, body) => {
        const res = await request(app)
          .patch(`/job-work-orders/${f.jwoId}`)
          .set("x-test-org-id", String(ORG))
          .send(body);
        expect(res.status).toBe(400);
        expect(String(res.body.error)).toMatch(
          /only the per-unit job charge rate/i,
        );

        // Order row is bit-for-bit unchanged.
        const stored = (await memDb.rowsOf("job_work_orders"))
          .find((r) => r.id === f.jwoId) as {
          outputQuantity: string;
          jobChargeRate: string;
          status: string;
        };
        expect(Number(stored.outputQuantity)).toBe(10);
        expect(Number(stored.jobChargeRate)).toBe(5);
        expect(stored.status).toBe(status);
      });

      it("rejects a negative jobChargeRate", async () => {
        const res = await request(app)
          .patch(`/job-work-orders/${f.jwoId}`)
          .set("x-test-org-id", String(ORG))
          .send({ jobChargeRate: -1 });
        expect(res.status).toBe(400);
        expect(String(res.body.error)).toMatch(/zero or greater/i);
      });

      it("rejects an empty body (no editable fields provided)", async () => {
        const res = await request(app)
          .patch(`/job-work-orders/${f.jwoId}`)
          .set("x-test-org-id", String(ORG))
          .send({});
        expect(res.status).toBe(400);
        expect(String(res.body.error)).toMatch(
          /provide at least one of jobChargeRate/i,
        );
      });
    });
  }
});

describe("PATCH /job-work-orders/:id — completed and cancelled orders are read-only", () => {
  let app: Express;

  beforeEach(async () => {
    await memDb.reset();
    app = buildApp();
  });

  for (const status of ["completed", "cancelled"]) {
    it(`rejects every edit on a ${status} order, including a rate-only edit`, async () => {
      await memDb.reset();
      const f = await seed(status);
      app = buildApp();

      // Rate-only attempt — still rejected.
      const rateRes = await request(app)
        .patch(`/job-work-orders/${f.jwoId}`)
        .set("x-test-org-id", String(ORG))
        .send({ jobChargeRate: 99 });
      expect(rateRes.status).toBe(400);
      expect(String(rateRes.body.error)).toMatch(
        new RegExp(`cannot edit a ${status}`, "i"),
      );

      // Quantity attempt — also rejected.
      const qtyRes = await request(app)
        .patch(`/job-work-orders/${f.jwoId}`)
        .set("x-test-org-id", String(ORG))
        .send({ outputQuantity: 99 });
      expect(qtyRes.status).toBe(400);

      // Order row unchanged.
      const stored = (await memDb.rowsOf("job_work_orders"))
        .find((r) => r.id === f.jwoId) as {
        outputQuantity: string;
        jobChargeRate: string;
        status: string;
      };
      expect(Number(stored.outputQuantity)).toBe(10);
      expect(Number(stored.jobChargeRate)).toBe(5);
      expect(stored.status).toBe(status);
    });
  }
});

describe("PATCH /job-work-orders/:id — rate edit does not re-price history", () => {
  let app: Express;
  let f: Fixture;

  beforeEach(async () => {
    await memDb.reset();
    f = await seed("issued");
    app = buildApp();
  });

  it("leaves existing receipts and their auto-generated bills untouched", async () => {
    // Issue components and receive 5 finished units at the original
    // rate of 5/unit so we have a historical receipt + auto-bill to
    // protect from a later rate change.
    const issueRes = await request(app)
      .post(`/job-work-orders/${f.jwoId}/issue`)
      .set("x-test-org-id", String(ORG))
      .send({
        issueDate: "2026-02-01",
        lines: [{ componentItemId: f.componentItemId, quantity: 10 }],
      });
    expect(issueRes.status).toBe(201);

    const receiveRes = await request(app)
      .post(`/job-work-orders/${f.jwoId}/receive`)
      .set("x-test-org-id", String(ORG))
      .send({
        receivedDate: "2026-02-05",
        finishedQuantity: 5,
        scrapQuantity: 0,
        // Omit jobCharge so the route derives it from the order's
        // rate (5 * 5 = 25). This is the very value the rate change
        // must NOT retroactively rewrite.
        components: [
          {
            componentItemId: f.componentItemId,
            quantityConsumed: 10,
          },
        ],
      });
    expect(receiveRes.status).toBe(201);
    const receipt = receiveRes.body.receipts[0] as {
      id: number;
      jobCharge: number;
      purchaseOrderId: number | null;
    };
    expect(receipt.jobCharge).toBe(25);
    expect(receipt.purchaseOrderId).not.toBeNull();
    const billId = receipt.purchaseOrderId!;

    // Bump the rate from 5 to 12.
    const patchRes = await request(app)
      .patch(`/job-work-orders/${f.jwoId}`)
      .set("x-test-org-id", String(ORG))
      .send({ jobChargeRate: 12 });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.order.jobChargeRate).toBe(12);

    // Receipt's recorded charge is unchanged.
    const storedReceipt = (await memDb.rowsOf("job_work_receipts"))
      .find((r) => r.id === receipt.id) as { jobCharge: string };
    expect(Number(storedReceipt.jobCharge)).toBe(25);

    // Auto-bill totals are unchanged.
    const bill = (await memDb.rowsOf("purchase_orders"))
      .find((p) => p.id === billId) as {
      total: string;
      balanceDue: string;
      subtotal: string;
    };
    expect(Number(bill.total)).toBe(25);
    expect(Number(bill.balanceDue)).toBe(25);
    expect(Number(bill.subtotal)).toBe(25);

    // Auto-bill line still priced at the original 5/unit.
    const lines = (await memDb.rowsOf("purchase_order_lines"))
      .filter((l) => l.purchaseOrderId === billId) as Array<{
      unitPrice: string;
      lineTotal: string;
    }>;
    expect(lines).toHaveLength(1);
    expect(Number(lines[0].unitPrice)).toBe(5);
    expect(Number(lines[0].lineTotal)).toBe(25);

    // Supplier payable still matches the original charge.
    const supplier = (await memDb.rowsOf("suppliers"))
      .find((s) => s.id === f.supplierId) as { outstandingPayable: string };
    expect(Number(supplier.outstandingPayable)).toBe(25);
  });
});
