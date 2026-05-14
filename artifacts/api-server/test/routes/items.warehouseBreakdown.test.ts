// Coverage for the `includeWarehouseBreakdown` flag on `GET /items`.
//
// Companion to items.tenant.test.ts. The flag drives the per-warehouse
// `warehouseStock` array on each item — used by the Items page Warehouse
// column. We exercise four behaviours that cheap regressions could
// silently break:
//   (a) flag off → `warehouseStock` is null on every row.
//   (b) flag on  → physical items return correct per-warehouse rows
//       and rows for virtual job-worker warehouses are excluded.
//   (c) bundles  → derived per-warehouse stock (floor of components),
//       layered on top of physical-item rows.
//   (d) cross-tenant → the breakdown only ever names the caller's
//       warehouses, even when the other org has identically-named
//       warehouses with stock on a colliding-sku item.

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

import itemsRouter from "../../src/routes/items";

const ORG_A = 5001;
const ORG_B = 6002;

type WarehouseStockRow = {
  warehouseId: number;
  warehouseName: string;
  quantity: number;
};
type ItemRow = {
  id: number;
  name: string;
  warehouseStock: WarehouseStockRow[] | null;
  totalStock: number;
};

interface OrgFixture {
  orgId: number;
  mainWhId: number;
  secondaryWhId: number;
  virtualWhId: number;
  physicalItemId: number;
  // Bundle item + its two leaf components.
  bundleItemId: number;
  componentAItemId: number;
  componentBItemId: number;
}

async function seedItem(
  orgId: number,
  overrides: Record<string, unknown>,
): Promise<number> {
  const row = await memDb.seed(tables.itemsTable as never, {
    organizationId: orgId,
    name: "Item",
    sku: "SKU",
    description: null,
    category: null,
    unit: "ea",
    barcode: null,
    salePrice: "0",
    purchasePrice: "0",
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
    ...overrides,
  });
  return row.id as number;
}

async function seedStock(
  orgId: number,
  itemId: number,
  warehouseId: number,
  quantity: string,
): Promise<void> {
  await memDb.seed(tables.itemWarehouseStockTable as never, {
    organizationId: orgId,
    itemId,
    warehouseId,
    quantity,
  });
}

async function seedOrg(label: "A" | "B", orgId: number): Promise<OrgFixture> {
  await memDb.seed(tables.organizationsTable as never, {
    id: orgId,
    name: `Org ${label}`,
    slug: `org-${label.toLowerCase()}`,
  });
  const main = await memDb.seed(tables.warehousesTable as never, {
    organizationId: orgId,
    name: "Main Warehouse",
    code: `MAIN-${label}`,
    isVirtual: false,
    isDefault: true,
  });
  const secondary = await memDb.seed(tables.warehousesTable as never, {
    organizationId: orgId,
    name: `Secondary ${label}`,
    code: `SEC-${label}`,
    isVirtual: false,
    isDefault: false,
  });
  // Virtual job-worker warehouse: must be excluded from the breakdown
  // even when it carries stock for the item.
  const virtual = await memDb.seed(tables.warehousesTable as never, {
    organizationId: orgId,
    name: `Job Worker ${label}`,
    code: `JW-${label}`,
    isVirtual: true,
    isDefault: false,
  });

  // Physical leaf item with stock split across all three warehouses
  // (including the virtual one we expect to see filtered out).
  const physicalItemId = await seedItem(orgId, {
    name: `Physical ${label}`,
    sku: `PHYS-${label}`,
  });
  await seedStock(orgId, physicalItemId, main.id as number, "10");
  await seedStock(orgId, physicalItemId, secondary.id as number, "4");
  await seedStock(orgId, physicalItemId, virtual.id as number, "7");

  // Bundle scenario: parent bundle + 2 component leaves.
  // Component A: 6 in main, 4 in secondary (qpb=2)
  // Component B: 5 in main, 1 in secondary (qpb=1)
  // Derived bundle stock: main = floor(min(6/2, 5/1)) = 3
  //                      secondary = floor(min(4/2, 1/1)) = 1
  // Total derived = 4.
  const componentAItemId = await seedItem(orgId, {
    name: `Component A ${label}`,
    sku: `COMP-A-${label}`,
  });
  const componentBItemId = await seedItem(orgId, {
    name: `Component B ${label}`,
    sku: `COMP-B-${label}`,
  });
  await seedStock(orgId, componentAItemId, main.id as number, "6");
  await seedStock(orgId, componentAItemId, secondary.id as number, "4");
  await seedStock(orgId, componentBItemId, main.id as number, "5");
  await seedStock(orgId, componentBItemId, secondary.id as number, "1");

  const bundleItemId = await seedItem(orgId, {
    name: `Bundle ${label}`,
    sku: `BUN-${label}`,
    isBundle: true,
  });
  await memDb.seed(tables.itemBundleComponentsTable as never, {
    organizationId: orgId,
    parentItemId: bundleItemId,
    componentItemId: componentAItemId,
    quantityPerBundle: "2",
  });
  await memDb.seed(tables.itemBundleComponentsTable as never, {
    organizationId: orgId,
    parentItemId: bundleItemId,
    componentItemId: componentBItemId,
    quantityPerBundle: "1",
  });

  return {
    orgId,
    mainWhId: main.id as number,
    secondaryWhId: secondary.id as number,
    virtualWhId: virtual.id as number,
    physicalItemId,
    bundleItemId,
    componentAItemId,
    componentBItemId,
  };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(itemsRouter);
  return app;
}

describe("GET /items includeWarehouseBreakdown", () => {
  let app: Express;
  let a: OrgFixture;
  let b: OrgFixture;

  beforeEach(async () => {
    await memDb.reset();
    a = await seedOrg("A", ORG_A);
    b = await seedOrg("B", ORG_B);
    app = buildApp();
  });

  it("flag off → warehouseStock is null on every row", async () => {
    const res = await request(app)
      .get("/items")
      .set("x-test-org-id", String(ORG_A));
    expect(res.status).toBe(200);
    const rows = res.body as ItemRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.warehouseStock).toBeNull();
    }
  });

  it("flag on → physical items get per-warehouse rows excluding virtual warehouses", async () => {
    const res = await request(app)
      .get("/items?includeWarehouseBreakdown=true")
      .set("x-test-org-id", String(ORG_A));
    expect(res.status).toBe(200);
    const rows = res.body as ItemRow[];
    const physical = rows.find((r) => r.id === a.physicalItemId);
    expect(physical).toBeDefined();
    expect(physical!.warehouseStock).not.toBeNull();
    const breakdown = physical!.warehouseStock!;
    // Only the two non-virtual warehouses; the virtual one with qty=7
    // must be filtered out at the source.
    expect(breakdown.map((w) => w.warehouseId).sort()).toEqual(
      [a.mainWhId, a.secondaryWhId].sort(),
    );
    const byId = new Map(breakdown.map((w) => [w.warehouseId, w]));
    expect(byId.get(a.mainWhId)!.quantity).toBe(10);
    expect(byId.get(a.mainWhId)!.warehouseName).toBe("Main Warehouse");
    expect(byId.get(a.secondaryWhId)!.quantity).toBe(4);
    expect(byId.get(a.secondaryWhId)!.warehouseName).toBe("Secondary A");
    // Sanity: the row for the virtual warehouse really is absent.
    for (const w of breakdown) {
      expect(w.warehouseId).not.toBe(a.virtualWhId);
    }
  });

  it("flag on → bundles get derived per-warehouse stock (floor across components)", async () => {
    const res = await request(app)
      .get("/items?includeWarehouseBreakdown=true")
      .set("x-test-org-id", String(ORG_A));
    expect(res.status).toBe(200);
    const rows = res.body as ItemRow[];
    const bundle = rows.find((r) => r.id === a.bundleItemId);
    expect(bundle).toBeDefined();
    expect(bundle!.warehouseStock).not.toBeNull();
    const breakdown = bundle!.warehouseStock!;
    const byId = new Map(breakdown.map((w) => [w.warehouseId, w]));
    // Derived: main = min(floor(6/2), floor(5/1)) = 3
    //          secondary = min(floor(4/2), floor(1/1)) = 1
    expect(byId.get(a.mainWhId)?.quantity).toBe(3);
    expect(byId.get(a.secondaryWhId)?.quantity).toBe(1);
    // Virtual warehouses are never in the bundle breakdown either.
    for (const w of breakdown) {
      expect(w.warehouseId).not.toBe(a.virtualWhId);
    }
    // The physical-row branch and the bundle-row branch agree on the
    // total surfaced as `totalStock` (sum of derived per-warehouse).
    expect(bundle!.totalStock).toBe(4);
  });

  it("cross-tenant: the breakdown only ever names the caller's warehouses", async () => {
    // Both orgs have the same shaped fixtures, so without proper
    // org-scoping the JOIN against `warehouses` could leak the other
    // org's warehouse names or quantities.
    const res = await request(app)
      .get("/items?includeWarehouseBreakdown=true")
      .set("x-test-org-id", String(ORG_A));
    expect(res.status).toBe(200);
    const rows = res.body as ItemRow[];

    const orgAWarehouseIds = new Set([
      a.mainWhId,
      a.secondaryWhId,
      a.virtualWhId,
    ]);
    for (const r of rows) {
      // The whole response must be org A's items only.
      expect(r.id).not.toBe(b.physicalItemId);
      expect(r.id).not.toBe(b.bundleItemId);
      expect(r.id).not.toBe(b.componentAItemId);
      expect(r.id).not.toBe(b.componentBItemId);
      // And every warehouse in every breakdown must belong to org A.
      for (const w of r.warehouseStock ?? []) {
        expect(orgAWarehouseIds.has(w.warehouseId)).toBe(true);
        // The other org's warehouses share suffix "B" — guard against
        // a name leak in case ids ever get reshuffled.
        expect(w.warehouseName).not.toContain(" B");
      }
    }
  });
});
