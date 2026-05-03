// Cross-tenant isolation tests for the job-work-orders routes.
//
// These tests seed two organisations side-by-side and assert that
// every read endpoint (list, detail, both reports) and every write
// endpoint (issue, receive) refuses to leak or mutate the other
// organisation's data.
//
// They use a small in-memory database simulator (see
// `helpers/inMemoryDb.ts`) so we can exercise real WHERE filtering
// and joins instead of the queue-based stub used elsewhere. The
// simulator implements just enough of Drizzle's surface for these
// routes; if a future change introduces a new query shape the
// simulator throws loudly.

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
// We replace `tenantMiddleware` with a header-driven stub so each
// supertest call can declare which org it acts as. The rest of the
// tenant module isn't needed because none of the routes under test
// call into `assertOwnership` etc.
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

const ORG_A = 1001;
const ORG_B = 2002;

interface OrgFixture {
  orgId: number;
  supplierId: number;
  outputItemId: number;
  componentItemId: number;
  sourceWarehouseId: number;
  destWarehouseId: number;
  vendorWarehouseId: number;
  jwoId: number;
  issueId: number;
  receiptId: number;
}

async function seedOrg(label: "A" | "B", orgId: number): Promise<OrgFixture> {
  // Organisation row.
  await memDb.seed(tables.organizationsTable, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
  });

  // Supplier (job worker) belonging to this org.
  const supplier = await memDb.seed(tables.suppliersTable, {
    organizationId: orgId,
    name: `Worker ${label}`,
    isJobWorker: true,
    outstandingPayable: "0",
  });

  // Items: one output (finished good) + one component (raw material).
  const outputItem = await memDb.seed(tables.itemsTable, {
    organizationId: orgId,
    name: `Output ${label}`,
    sku: `OUT-${label}`,
    hasVariants: false,
    isBundle: false,
    archivedAt: null,
  });
  const componentItem = await memDb.seed(tables.itemsTable, {
    organizationId: orgId,
    name: `Comp ${label}`,
    sku: `COMP-${label}`,
    hasVariants: false,
    isBundle: false,
    archivedAt: null,
  });

  // Warehouses: source + destination (real) + vendor (virtual,
  // tied to the job-worker supplier so the report joins land).
  const source = await memDb.seed(tables.warehousesTable, {
    organizationId: orgId,
    name: `Main ${label}`,
    code: `MAIN-${label}`,
    isVirtual: false,
    isDefault: true,
    jobWorkerSupplierId: null,
  });
  const dest = await memDb.seed(tables.warehousesTable, {
    organizationId: orgId,
    name: `Finished ${label}`,
    code: `FIN-${label}`,
    isVirtual: false,
    isDefault: false,
    jobWorkerSupplierId: null,
  });
  const vendor = await memDb.seed(tables.warehousesTable, {
    organizationId: orgId,
    name: `Worker premises ${label}`,
    code: `JW-${supplier.id}`,
    isVirtual: true,
    isDefault: false,
    jobWorkerSupplierId: supplier.id,
  });

  // Plenty of source-warehouse stock so the issue route doesn't
  // fail the on-hand check.
  await memDb.seed(tables.itemWarehouseStockTable, {
    organizationId: orgId,
    itemId: componentItem.id,
    warehouseId: source.id,
    quantity: "100",
  });
  // Pre-existing stock at the vendor — both for the "stock with
  // job worker" report assertion and so receipts can deduct from it.
  await memDb.seed(tables.itemWarehouseStockTable, {
    organizationId: orgId,
    itemId: componentItem.id,
    warehouseId: vendor.id,
    quantity: "10",
  });

  // The JWO itself, in ISSUED state so it accepts both more issues
  // and receipts.
  const jwo = await memDb.seed(tables.jobWorkOrdersTable, {
    organizationId: orgId,
    jwoNumber: `JWO-${label}-1`,
    supplierId: supplier.id,
    outputItemId: outputItem.id,
    outputQuantity: "20",
    sourceWarehouseId: source.id,
    destWarehouseId: dest.id,
    vendorWarehouseId: vendor.id,
    jobChargeRate: "5",
    expectedReturnDate: `2026-0${label === "A" ? 1 : 2}-15`,
    notes: null,
    status: "issued",
  });

  await memDb.seed(tables.jobWorkOrderComponentsTable, {
    organizationId: orgId,
    jobWorkOrderId: jwo.id,
    componentItemId: componentItem.id,
    quantityPerOutput: "2",
    totalQuantity: "40",
  });

  // One historical issue + one issue line.
  const issue = await memDb.seed(tables.jobWorkIssuesTable, {
    organizationId: orgId,
    jobWorkOrderId: jwo.id,
    issueNumber: `JWI-${label}-1`,
    issueDate: "2026-01-10",
    notes: null,
  });
  await memDb.seed(tables.jobWorkIssueLinesTable, {
    organizationId: orgId,
    jobWorkIssueId: issue.id,
    componentItemId: componentItem.id,
    quantity: "10",
  });

  // One historical receipt + one receipt component.
  const receipt = await memDb.seed(tables.jobWorkReceiptsTable, {
    organizationId: orgId,
    jobWorkOrderId: jwo.id,
    receiptNumber: `JWR-${label}-1`,
    receivedDate: "2026-01-20",
    finishedQuantity: "5",
    scrapQuantity: "0",
    jobCharge: "25",
    notes: null,
    status: "received",
  });
  await memDb.seed(tables.jobWorkReceiptComponentsTable, {
    organizationId: orgId,
    jobWorkReceiptId: receipt.id,
    componentItemId: componentItem.id,
    quantityConsumed: "5",
    scrapQuantity: "0",
  });

  return {
    orgId,
    supplierId: supplier.id as number,
    outputItemId: outputItem.id as number,
    componentItemId: componentItem.id as number,
    sourceWarehouseId: source.id as number,
    destWarehouseId: dest.id as number,
    vendorWarehouseId: vendor.id as number,
    jwoId: jwo.id as number,
    issueId: issue.id as number,
    receiptId: receipt.id as number,
  };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(jobWorkOrdersRouter);
  return app;
}

describe("job-work-orders cross-tenant isolation", () => {
  let app: Express;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeEach(async () => {
    await memDb.reset();
    a = await seedOrg("A", ORG_A);
    b = await seedOrg("B", ORG_B);
    app = buildApp();
  });

  // ──────────────────────────────────────────────────────────────
  // LIST
  // ──────────────────────────────────────────────────────────────

  describe("GET /job-work-orders (list + receipt totals)", () => {
    it("only returns the caller's own JWOs", async () => {
      const resA = await request(app)
        .get("/job-work-orders")
        .set("x-test-org-id", String(ORG_A));
      expect(resA.status).toBe(200);
      const idsA = resA.body.map((r: { id: number }) => r.id);
      expect(idsA).toEqual([a.jwoId]);
      expect(idsA).not.toContain(b.jwoId);

      const resB = await request(app)
        .get("/job-work-orders")
        .set("x-test-org-id", String(ORG_B));
      expect(resB.status).toBe(200);
      const idsB = resB.body.map((r: { id: number }) => r.id);
      expect(idsB).toEqual([b.jwoId]);
      expect(idsB).not.toContain(a.jwoId);
    });

    it("the list-totals receipt rollup never crosses orgs", async () => {
      // Org A's only receipt is for 5 finished units. If the rollup
      // accidentally pulled org B's receipt as well, totals would
      // double. We assert exactly the per-org expected totals, which
      // would fail on any cross-contamination.
      const resA = await request(app)
        .get("/job-work-orders")
        .set("x-test-org-id", String(ORG_A));
      expect(resA.status).toBe(200);
      expect(resA.body).toHaveLength(1);
      expect(resA.body[0]).toMatchObject({
        id: a.jwoId,
        receivedQuantity: 5,
        scrappedQuantity: 0,
      });

      const resB = await request(app)
        .get("/job-work-orders")
        .set("x-test-org-id", String(ORG_B));
      expect(resB.status).toBe(200);
      expect(resB.body).toHaveLength(1);
      expect(resB.body[0]).toMatchObject({
        id: b.jwoId,
        receivedQuantity: 5,
        scrappedQuantity: 0,
      });
    });
  });

  // ──────────────────────────────────────────────────────────────
  // DETAIL
  // ──────────────────────────────────────────────────────────────

  describe("GET /job-work-orders/:id (detail)", () => {
    it("returns 404 when fetching the other org's JWO", async () => {
      const resA = await request(app)
        .get(`/job-work-orders/${b.jwoId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(resA.status).toBe(404);

      const resB = await request(app)
        .get(`/job-work-orders/${a.jwoId}`)
        .set("x-test-org-id", String(ORG_B));
      expect(resB.status).toBe(404);
    });

    it("only includes the caller's own components, issues and receipts", async () => {
      const res = await request(app)
        .get(`/job-work-orders/${a.jwoId}`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      // Components
      expect(
        res.body.components.map((c: { componentItemId: number }) => c.componentItemId),
      ).toEqual([a.componentItemId]);
      expect(
        res.body.components.map((c: { componentItemId: number }) => c.componentItemId),
      ).not.toContain(b.componentItemId);
      // Issues
      expect(res.body.issues.map((i: { id: number }) => i.id)).toEqual([
        a.issueId,
      ]);
      expect(res.body.issues.map((i: { id: number }) => i.id)).not.toContain(
        b.issueId,
      );
      // Receipts
      expect(res.body.receipts.map((r: { id: number }) => r.id)).toEqual([
        a.receiptId,
      ]);
      expect(res.body.receipts.map((r: { id: number }) => r.id)).not.toContain(
        b.receiptId,
      );
    });
  });

  // ──────────────────────────────────────────────────────────────
  // ISSUE
  // ──────────────────────────────────────────────────────────────

  describe("POST /job-work-orders/:id/issue", () => {
    it.each([
      { caller: "A", callerOrg: ORG_A, target: () => b, victim: "B", victimOrg: ORG_B },
      { caller: "B", callerOrg: ORG_B, target: () => a, victim: "A", victimOrg: ORG_A },
    ])(
      "returns 404 when org $caller targets org $victim's JWO",
      async ({ callerOrg, target, victimOrg }) => {
        const targetFix = target();
        const victimComponentId =
          victimOrg === ORG_B ? a.componentItemId : b.componentItemId;
        const before = (await memDb.rowsOf("job_work_issues"))
          .filter((r) => r.organizationId === victimOrg).length;

        const res = await request(app)
          .post(`/job-work-orders/${targetFix.jwoId}/issue`)
          .set("x-test-org-id", String(callerOrg))
          .send({
            issueDate: "2026-02-01",
            lines: [{ componentItemId: victimComponentId, quantity: 1 }],
          });
        expect(res.status).toBe(404);

        // Victim's issue ledger is untouched.
        const after = (await memDb.rowsOf("job_work_issues"))
          .filter((r) => r.organizationId === victimOrg).length;
        expect(after).toBe(before);
        // And no rogue caller-org issue was created against the victim's order.
        const crossover = (await memDb.rowsOf("job_work_issues"))
          .filter(
            (r) =>
              r.jobWorkOrderId === targetFix.jwoId &&
              r.organizationId === callerOrg,
          );
        expect(crossover).toHaveLength(0);
      },
    );

    it("only mutates the caller's own org when issuing successfully", async () => {
      const bIssuesBefore = (await memDb.rowsOf("job_work_issues"))
        .filter((r) => r.organizationId === ORG_B).length;
      const bStockBefore = (await memDb.rowsOf("item_warehouse_stock"))
        .filter((r) => r.organizationId === ORG_B)
        .map((r) => ({ itemId: r.itemId, warehouseId: r.warehouseId, quantity: r.quantity }));

      const res = await request(app)
        .post(`/job-work-orders/${a.jwoId}/issue`)
        .set("x-test-org-id", String(ORG_A))
        .send({
          issueDate: "2026-02-05",
          lines: [
            { componentItemId: a.componentItemId, quantity: 4 },
          ],
        });
      expect(res.status).toBe(201);

      // Org A's issue ledger grew, Org B's didn't.
      const aIssuesAfter = (await memDb.rowsOf("job_work_issues"))
        .filter((r) => r.organizationId === ORG_A).length;
      const bIssuesAfter = (await memDb.rowsOf("job_work_issues"))
        .filter((r) => r.organizationId === ORG_B).length;
      expect(aIssuesAfter).toBeGreaterThan(0);
      expect(bIssuesAfter).toBe(bIssuesBefore);

      // Org B's stock rows are bit-for-bit identical.
      const bStockAfter = (await memDb.rowsOf("item_warehouse_stock"))
        .filter((r) => r.organizationId === ORG_B)
        .map((r) => ({ itemId: r.itemId, warehouseId: r.warehouseId, quantity: r.quantity }));
      expect(bStockAfter).toEqual(bStockBefore);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // RECEIVE
  // ──────────────────────────────────────────────────────────────

  describe("POST /job-work-orders/:id/receive", () => {
    it.each([
      { caller: "A", callerOrg: ORG_A, target: () => b, victim: "B", victimOrg: ORG_B },
      { caller: "B", callerOrg: ORG_B, target: () => a, victim: "A", victimOrg: ORG_A },
    ])(
      "returns 404 when org $caller targets org $victim's JWO",
      async ({ callerOrg, target, victimOrg }) => {
        const targetFix = target();
        const callerComponentId =
          callerOrg === ORG_A ? a.componentItemId : b.componentItemId;
        const beforeReceipts = (await memDb.rowsOf("job_work_receipts"))
          .filter((r) => r.organizationId === victimOrg).length;
        const beforePos = (await memDb.rowsOf("purchase_orders"))
          .filter((r) => r.organizationId === victimOrg).length;

        const res = await request(app)
          .post(`/job-work-orders/${targetFix.jwoId}/receive`)
          .set("x-test-org-id", String(callerOrg))
          .send({
            receivedDate: "2026-02-10",
            finishedQuantity: 1,
            scrapQuantity: 0,
            jobCharge: 5,
            components: [
              { componentItemId: callerComponentId, quantityConsumed: 2 },
            ],
          });
        expect(res.status).toBe(404);

        // No new rows in the victim org from the failed cross-tenant attempt.
        const afterReceipts = (await memDb.rowsOf("job_work_receipts"))
          .filter((r) => r.organizationId === victimOrg).length;
        const afterPos = (await memDb.rowsOf("purchase_orders"))
          .filter((r) => r.organizationId === victimOrg).length;
        expect(afterReceipts).toBe(beforeReceipts);
        expect(afterPos).toBe(beforePos);
      },
    );

    it("a successful receive updates only the caller's org", async () => {
      const bSupplierPayableBefore = (
        (await memDb.rowsOf("suppliers"))
          .find((r) => r.id === b.supplierId) as { outstandingPayable: string }
      ).outstandingPayable;
      const bStockBefore = (await memDb.rowsOf("item_warehouse_stock"))
        .filter((r) => r.organizationId === ORG_B)
        .map((r) => ({ itemId: r.itemId, warehouseId: r.warehouseId, quantity: r.quantity }));

      const res = await request(app)
        .post(`/job-work-orders/${a.jwoId}/receive`)
        .set("x-test-org-id", String(ORG_A))
        .send({
          receivedDate: "2026-02-12",
          finishedQuantity: 2,
          scrapQuantity: 0,
          jobCharge: 10,
          components: [
            { componentItemId: a.componentItemId, quantityConsumed: 4 },
          ],
        });
      expect(res.status).toBe(201);

      // Org A's supplier payable grew; org B's payable is unchanged.
      const bSupplierPayableAfter = (
        (await memDb.rowsOf("suppliers"))
          .find((r) => r.id === b.supplierId) as { outstandingPayable: string }
      ).outstandingPayable;
      expect(bSupplierPayableAfter).toBe(bSupplierPayableBefore);

      // Org B's stock didn't budge.
      const bStockAfter = (await memDb.rowsOf("item_warehouse_stock"))
        .filter((r) => r.organizationId === ORG_B)
        .map((r) => ({ itemId: r.itemId, warehouseId: r.warehouseId, quantity: r.quantity }));
      expect(bStockAfter).toEqual(bStockBefore);

      // The auto-generated supplier bill belongs to org A only.
      const newPos = (await memDb.rowsOf("purchase_orders"));
      expect(newPos.length).toBeGreaterThan(0);
      for (const po of newPos) {
        expect(po.organizationId).toBe(ORG_A);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────
  // REPORTS
  // ──────────────────────────────────────────────────────────────

  describe("GET /reports/stock-with-job-workers", () => {
    it("only lists vendor stock for the caller's org", async () => {
      const resA = await request(app)
        .get("/reports/stock-with-job-workers")
        .set("x-test-org-id", String(ORG_A));
      expect(resA.status).toBe(200);
      // Exactly one row — A's component sitting at A's vendor warehouse.
      expect(resA.body.rows).toHaveLength(1);
      expect(resA.body.rows[0]).toMatchObject({
        supplierId: a.supplierId,
        warehouseId: a.vendorWarehouseId,
        itemId: a.componentItemId,
      });
      // No leakage of B's supplier / vendor warehouse / item.
      const flat = JSON.stringify(resA.body);
      expect(flat).not.toContain(`"supplierId":${b.supplierId}`);
      expect(flat).not.toContain(`"warehouseId":${b.vendorWarehouseId}`);
      expect(flat).not.toContain(`"itemId":${b.componentItemId}`);

      const resB = await request(app)
        .get("/reports/stock-with-job-workers")
        .set("x-test-org-id", String(ORG_B));
      expect(resB.status).toBe(200);
      expect(resB.body.rows).toHaveLength(1);
      expect(resB.body.rows[0]).toMatchObject({
        supplierId: b.supplierId,
        warehouseId: b.vendorWarehouseId,
        itemId: b.componentItemId,
      });
    });
  });

  describe("GET /reports/pending-job-work", () => {
    it("only includes the caller's pending JWOs", async () => {
      const resA = await request(app)
        .get("/reports/pending-job-work")
        .set("x-test-org-id", String(ORG_A));
      expect(resA.status).toBe(200);
      const idsA = resA.body.rows.map(
        (r: { jobWorkOrderId: number }) => r.jobWorkOrderId,
      );
      expect(idsA).toEqual([a.jwoId]);
      expect(idsA).not.toContain(b.jwoId);

      const resB = await request(app)
        .get("/reports/pending-job-work")
        .set("x-test-org-id", String(ORG_B));
      expect(resB.status).toBe(200);
      const idsB = resB.body.rows.map(
        (r: { jobWorkOrderId: number }) => r.jobWorkOrderId,
      );
      expect(idsB).toEqual([b.jwoId]);
      expect(idsB).not.toContain(a.jwoId);
    });

    it("the issued/consumed roll-ups never include the other org's rows", async () => {
      // Each org has exactly one historical issue (10 units issued)
      // and one historical receipt (5 consumed). Without org-scoping
      // on the issued or consumed sub-queries, these numbers would
      // double when both orgs are seeded.
      const res = await request(app)
        .get("/reports/pending-job-work")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(1);
      // ordered = 20, finished = 5, scrapped = 0 → remaining = 15
      // issued = 10, consumed = 5 → componentsAtVendor = 5
      expect(res.body.rows[0]).toMatchObject({
        jobWorkOrderId: a.jwoId,
        orderedQuantity: 20,
        receivedQuantity: 5,
        scrappedQuantity: 0,
        remainingQuantity: 15,
        componentsAtVendorTotal: 5,
      });
    });
  });
});
