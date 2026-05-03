// Integration tests for the job-work auto-billing flow:
//   * Recording a JWO receipt with a per-unit charge auto-creates a
//     "billed" supplier purchase order, links it both ways, and
//     accrues the charge to the supplier's outstanding payable.
//   * Cancelling the receipt reverses every side-effect — finished-
//     goods stock at the destination warehouse, components at the
//     vendor warehouse, the supplier's payable, and deletes the
//     auto-bill itself.
//   * Cancellation is blocked once a supplier payment has been
//     allocated against the auto-bill (settle/refund first).
//   * The purchase-orders router rejects every mutation that would
//     mutate a JWO-linked auto-bill out from under the JWO.
//
// We use the same in-memory Drizzle simulator as the cross-tenant
// tests so we can exercise the real receive / cancel transactions
// end-to-end (joins, RETURNING, sql add/subtract, transactions).

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
import purchaseOrdersRouter from "../../src/routes/purchaseOrders";

const ORG = 4001;

interface Fixture {
  supplierId: number;
  outputItemId: number;
  componentItemId: number;
  sourceWarehouseId: number;
  destWarehouseId: number;
  vendorWarehouseId: number;
  jwoId: number;
}

// Seed a single org with one job-worker supplier, one output item,
// one component, three warehouses and a JWO sitting in ISSUED state
// (ready to accept further /issue and /receive calls). Source has
// plentiful component stock so the issue route's on-hand check
// doesn't fail.
async function seed(): Promise<Fixture> {
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
    status: "issued",
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
  app.use(purchaseOrdersRouter);
  return app;
}

// Convenience: issue 10 components then receive `finished` units
// with the given charge. Returns the receipt + bill ids extracted
// from the receive endpoint's response detail.
async function issueAndReceive(
  app: Express,
  f: Fixture,
  finished: number,
  jobCharge: number,
): Promise<{ receiptId: number; billId: number | null }> {
  const issueRes = await request(app)
    .post(`/job-work-orders/${f.jwoId}/issue`)
    .set("x-test-org-id", String(ORG))
    .send({
      issueDate: "2026-02-01",
      lines: [{ componentItemId: f.componentItemId, quantity: 10 }],
    });
  if (issueRes.status !== 201) {
    throw new Error(
      `issue failed: ${issueRes.status} ${JSON.stringify(issueRes.body)}`,
    );
  }
  const receiveRes = await request(app)
    .post(`/job-work-orders/${f.jwoId}/receive`)
    .set("x-test-org-id", String(ORG))
    .send({
      receivedDate: "2026-02-05",
      finishedQuantity: finished,
      scrapQuantity: 0,
      jobCharge,
      components: [
        {
          componentItemId: f.componentItemId,
          quantityConsumed: finished * 2,
        },
      ],
    });
  if (receiveRes.status !== 201) {
    throw new Error(
      `receive failed: ${receiveRes.status} ${JSON.stringify(receiveRes.body)}`,
    );
  }
  const receipt = receiveRes.body.receipts[0] as {
    id: number;
    purchaseOrderId: number | null;
  };
  return { receiptId: receipt.id, billId: receipt.purchaseOrderId };
}

async function stockOf(orgId: number, itemId: number, warehouseId: number): Promise<number> {
  const row = (await memDb.rowsOf("item_warehouse_stock"))
    .find(
      (r) =>
        r.organizationId === orgId &&
        r.itemId === itemId &&
        r.warehouseId === warehouseId,
    ) as { quantity: string } | undefined;
  return row ? Number(row.quantity) : 0;
}

async function payableOf(supplierId: number): Promise<number> {
  const row = (await memDb.rowsOf("suppliers"))
    .find((r) => r.id === supplierId) as { outstandingPayable: string };
  return Number(row.outstandingPayable);
}

describe("job-work auto-billing on receipt", () => {
  let app: Express;
  let f: Fixture;

  beforeEach(async () => {
    await memDb.reset();
    f = await seed();
    app = buildApp();
  });

  it("creates a 'billed' purchase order linked both ways and bumps supplier payable", async () => {
    // Receive 5 finished units with a 25 total job charge (5/unit).
    const { receiptId, billId } = await issueAndReceive(app, f, 5, 25);

    expect(billId).not.toBeNull();
    const bill = (await memDb.rowsOf("purchase_orders"))
      .find((p) => p.id === billId) as
      | {
          id: number;
          organizationId: number;
          supplierId: number;
          warehouseId: number;
          status: string;
          jobWorkReceiptId: number;
          subtotal: string;
          total: string;
          balanceDue: string;
          amountPaid: string;
          orderNumber: string;
        }
      | undefined;
    expect(bill).toBeDefined();
    expect(bill!.status).toBe("billed");
    expect(bill!.organizationId).toBe(ORG);
    expect(bill!.supplierId).toBe(f.supplierId);
    expect(bill!.warehouseId).toBe(f.destWarehouseId);
    // Forward link: PO points back at the receipt that created it.
    expect(bill!.jobWorkReceiptId).toBe(receiptId);
    expect(Number(bill!.total)).toBe(25);
    expect(Number(bill!.balanceDue)).toBe(25);
    expect(Number(bill!.amountPaid)).toBe(0);

    // The auto-bill must include exactly one line for the output item
    // priced at the per-unit charge with quantityReceived already set
    // (the goods are physically in the destination warehouse).
    const lines = (await memDb.rowsOf("purchase_order_lines"))
      .filter((l) => l.purchaseOrderId === billId) as Array<{
      itemId: number;
      quantity: string;
      quantityReceived: string;
      unitPrice: string;
      lineTotal: string;
    }>;
    expect(lines).toHaveLength(1);
    expect(lines[0].itemId).toBe(f.outputItemId);
    expect(Number(lines[0].quantity)).toBe(5);
    expect(Number(lines[0].quantityReceived)).toBe(5);
    expect(Number(lines[0].unitPrice)).toBe(5);
    expect(Number(lines[0].lineTotal)).toBe(25);

    // Supplier payable accrued by the full charge total.
    expect(await payableOf(f.supplierId)).toBe(25);

    // Reverse link: GET /:id detail surfaces the bill on the receipt
    // payload (so the UI's Receipts tab can deep-link).
    const detail = await request(app)
      .get(`/job-work-orders/${f.jwoId}`)
      .set("x-test-org-id", String(ORG));
    expect(detail.status).toBe(200);
    const receiptInDetail = detail.body.receipts.find(
      (r: { id: number }) => r.id === receiptId,
    );
    expect(receiptInDetail).toBeDefined();
    expect(receiptInDetail.purchaseOrderId).toBe(billId);
    expect(receiptInDetail.purchaseOrderNumber).toBe(bill!.orderNumber);
  });
});

describe("job-work receipt cancellation", () => {
  let app: Express;
  let f: Fixture;

  beforeEach(async () => {
    await memDb.reset();
    f = await seed();
    app = buildApp();
  });

  it("reverses stock, returns components, drops payable, and deletes the auto-bill", async () => {
    const { receiptId, billId } = await issueAndReceive(app, f, 5, 25);

    // After receive: dest has 5 finished, vendor has 0 components
    // (10 issued - 10 consumed), source has 90 components left,
    // supplier payable is 25, and the bill exists.
    expect(await stockOf(ORG, f.outputItemId, f.destWarehouseId)).toBe(5);
    expect(await stockOf(ORG, f.componentItemId, f.vendorWarehouseId)).toBe(0);
    expect(await stockOf(ORG, f.componentItemId, f.sourceWarehouseId)).toBe(90);
    expect(await payableOf(f.supplierId)).toBe(25);
    expect(
      (await memDb.rowsOf("purchase_orders")).some((p) => p.id === billId),
    ).toBe(true);

    const cancelRes = await request(app)
      .post(`/job-work-orders/${f.jwoId}/receipts/${receiptId}/cancel`)
      .set("x-test-org-id", String(ORG));
    expect(cancelRes.status).toBe(200);

    // Finished-goods stock at the destination warehouse is reversed.
    expect(await stockOf(ORG, f.outputItemId, f.destWarehouseId)).toBe(0);
    // Components return to the vendor warehouse (10 units back).
    expect(await stockOf(ORG, f.componentItemId, f.vendorWarehouseId)).toBe(10);
    // Source warehouse is untouched by receipt cancellation —
    // material was issued, not unissued.
    expect(await stockOf(ORG, f.componentItemId, f.sourceWarehouseId)).toBe(90);
    // Supplier payable is back to zero.
    expect(await payableOf(f.supplierId)).toBe(0);
    // Auto-bill row is deleted (purchase_orders + its lines).
    expect(
      (await memDb.rowsOf("purchase_orders")).some((p) => p.id === billId),
    ).toBe(false);
    // Receipt itself is soft-cancelled (kept for audit).
    const receipt = (await memDb.rowsOf("job_work_receipts"))
      .find((r) => r.id === receiptId) as { status: string };
    expect(receipt.status).toBe("cancelled");
  });

  it("cancels cleanly when there is no auto-bill (zero job charge)", async () => {
    // Receive 5 finished units with a 0 job charge: no bill, no
    // payable accrual — but stock and component movements still
    // happen and must reverse on cancel.
    const { receiptId, billId } = await issueAndReceive(app, f, 5, 0);

    expect(billId).toBeNull();
    // No purchase_orders row should have been created at all.
    expect((await memDb.rowsOf("purchase_orders"))).toHaveLength(0);
    // Supplier payable untouched.
    expect(await payableOf(f.supplierId)).toBe(0);
    // Stock side-effects still applied.
    expect(await stockOf(ORG, f.outputItemId, f.destWarehouseId)).toBe(5);
    expect(await stockOf(ORG, f.componentItemId, f.vendorWarehouseId)).toBe(0);

    const cancelRes = await request(app)
      .post(`/job-work-orders/${f.jwoId}/receipts/${receiptId}/cancel`)
      .set("x-test-org-id", String(ORG));
    expect(cancelRes.status).toBe(200);

    // Finished-goods stock at the destination warehouse is reversed.
    expect(await stockOf(ORG, f.outputItemId, f.destWarehouseId)).toBe(0);
    // Components return to the vendor warehouse.
    expect(await stockOf(ORG, f.componentItemId, f.vendorWarehouseId)).toBe(10);
    // Source warehouse untouched.
    expect(await stockOf(ORG, f.componentItemId, f.sourceWarehouseId)).toBe(90);
    // Payable still zero (nothing to reverse).
    expect(await payableOf(f.supplierId)).toBe(0);
    // Still no purchase_orders rows.
    expect((await memDb.rowsOf("purchase_orders"))).toHaveLength(0);
    // Receipt soft-cancelled for audit.
    const receipt = (await memDb.rowsOf("job_work_receipts"))
      .find((r) => r.id === receiptId) as { status: string };
    expect(receipt.status).toBe("cancelled");
  });

  it("only reverses the cancelled receipt's stock when a JWO has multiple receipts", async () => {
    // Two zero-charge receipts on the same JWO. Cancelling the first
    // must leave the second receipt's stock and component movements
    // intact.
    const first = await issueAndReceive(app, f, 3, 0);
    const second = await issueAndReceive(app, f, 4, 0);

    expect(first.billId).toBeNull();
    expect(second.billId).toBeNull();
    // Combined: 7 finished at dest. Vendor: 20 issued (10 per call) -
    // 14 consumed (3*2 + 4*2) = 6 components left at the vendor.
    expect(await stockOf(ORG, f.outputItemId, f.destWarehouseId)).toBe(7);
    expect(await stockOf(ORG, f.componentItemId, f.vendorWarehouseId)).toBe(6);

    const cancelRes = await request(app)
      .post(`/job-work-orders/${f.jwoId}/receipts/${first.receiptId}/cancel`)
      .set("x-test-org-id", String(ORG));
    expect(cancelRes.status).toBe(200);

    // Only the first receipt's 3 finished units are reversed: 4 left.
    expect(await stockOf(ORG, f.outputItemId, f.destWarehouseId)).toBe(4);
    // The first receipt's 6 components return to the vendor (6
    // already there + 6 returned = 12).
    expect(await stockOf(ORG, f.componentItemId, f.vendorWarehouseId)).toBe(12);
    // No payables involved.
    expect(await payableOf(f.supplierId)).toBe(0);

    // Cancelled receipt is soft-cancelled, the other stays active.
    const cancelled = (await memDb.rowsOf("job_work_receipts"))
      .find((r) => r.id === first.receiptId) as { status: string };
    expect(cancelled.status).toBe("cancelled");
    const survivor = (await memDb.rowsOf("job_work_receipts"))
      .find((r) => r.id === second.receiptId) as { status?: string };
    expect(survivor.status).not.toBe("cancelled");
  });

  it("rejects cancellation when a supplier payment has been allocated to the auto-bill", async () => {
    const { receiptId, billId } = await issueAndReceive(app, f, 5, 25);
    expect(billId).not.toBeNull();

    // Simulate a supplier payment having been applied to the bill.
    // The route only checks for the existence of an allocation row
    // pointing at this purchase order — no other columns are read.
    await memDb.seed(tables.supplierPaymentAllocationsTable, {
      organizationId: ORG,
      paymentId: 9999,
      purchaseOrderId: billId,
      amount: "10",
    });

    const cancelRes = await request(app)
      .post(`/job-work-orders/${f.jwoId}/receipts/${receiptId}/cancel`)
      .set("x-test-org-id", String(ORG));
    expect(cancelRes.status).toBe(400);
    expect(String(cancelRes.body.error)).toMatch(
      /supplier payments applied/i,
    );

    // Side-effects must not have been applied: bill still exists,
    // payable unchanged, finished-goods stock unchanged, receipt
    // still recorded (not soft-cancelled).
    expect(
      (await memDb.rowsOf("purchase_orders")).some((p) => p.id === billId),
    ).toBe(true);
    expect(await payableOf(f.supplierId)).toBe(25);
    expect(await stockOf(ORG, f.outputItemId, f.destWarehouseId)).toBe(5);
    // Receipt is still active — receive() doesn't touch `status` on
    // insert (the DB column defaults to 'received' in production),
    // so we assert it's anything other than the cancelled marker.
    const receipt = (await memDb.rowsOf("job_work_receipts"))
      .find((r) => r.id === receiptId) as { status?: string };
    expect(receipt.status).not.toBe("cancelled");
  });
});

describe("purchase-orders mutation guards for JWO-linked bills", () => {
  let app: Express;
  let f: Fixture;
  let billId: number;
  let receiptId: number;

  beforeEach(async () => {
    await memDb.reset();
    f = await seed();
    app = buildApp();
    const ids = await issueAndReceive(app, f, 5, 25);
    receiptId = ids.receiptId;
    expect(ids.billId).not.toBeNull();
    billId = ids.billId!;
  });

  it("PATCH /purchase-orders/:id/status is rejected on a JWO-linked bill", async () => {
    for (const status of ["cancelled", "paid", "draft"]) {
      const res = await request(app)
        .patch(`/purchase-orders/${billId}/status`)
        .set("x-test-org-id", String(ORG))
        .send({ status });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toMatch(
        /auto-created job-work bill|managed via the job-work receipt/i,
      );
    }
    // Bill status untouched after every blocked attempt.
    const bill = (await memDb.rowsOf("purchase_orders"))
      .find((p) => p.id === billId) as { status: string };
    expect(bill.status).toBe("billed");
  });

  it("POST /purchase-orders/:id/return is rejected on a JWO-linked bill", async () => {
    const res = await request(app)
      .post(`/purchase-orders/${billId}/return`)
      .set("x-test-org-id", String(ORG))
      .send({ notes: "trying to return" });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(
      /Auto-created job-work bills cannot be returned/i,
    );

    const bill = (await memDb.rowsOf("purchase_orders"))
      .find((p) => p.id === billId) as { status: string };
    expect(bill.status).toBe("billed");
    // No purchase_return movement should have been written.
    const returns = (await memDb.rowsOf("stock_movements"))
      .filter(
        (m) =>
          m.movementType === "purchase_return" && m.referenceId === billId,
      );
    expect(returns).toHaveLength(0);
  });

  it("DELETE /purchase-orders/:id is rejected on a JWO-linked bill", async () => {
    const res = await request(app)
      .delete(`/purchase-orders/${billId}`)
      .set("x-test-org-id", String(ORG));
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(
      /auto-created from a job-work receipt/i,
    );
    // Bill row must still be there, otherwise the receipt would be
    // left holding a dangling reference.
    expect(
      (await memDb.rowsOf("purchase_orders")).some((p) => p.id === billId),
    ).toBe(true);
    // Receipt itself unaffected.
    expect(
      (await memDb.rowsOf("job_work_receipts")).some((r) => r.id === receiptId),
    ).toBe(true);
  });
});
