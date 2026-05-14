// Coverage for the Warehouse picker + Warehouse column on the Items
// page (added in Task #24). The picker defaults to "All warehouses",
// switching to a specific warehouse renders that warehouse name in
// every row's Warehouse cell, and the cross-warehouse "+N more" badge
// shows up only when an item's stock is split across warehouses.

import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

// jsdom has neither ResizeObserver nor PointerEvent; both are touched
// by the radix Select primitive used by the warehouse picker. The
// minimal stubs below let the picker open without crashing.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;
if (
  typeof (globalThis as unknown as { PointerEvent?: unknown }).PointerEvent ===
  "undefined"
) {
  class PointerEventStub extends MouseEvent {
    pointerId = 0;
    pointerType = "mouse";
    width = 1;
    height = 1;
    pressure = 0;
    tangentialPressure = 0;
    tiltX = 0;
    tiltY = 0;
    twist = 0;
    isPrimary = true;
  }
  (globalThis as unknown as { PointerEvent: unknown }).PointerEvent =
    PointerEventStub;
}
// hasPointerCapture is also referenced by radix Select; jsdom hasn't
// implemented it. A no-op shim keeps the open/close machinery happy.
if (
  typeof (Element.prototype as unknown as { hasPointerCapture?: unknown })
    .hasPointerCapture === "undefined"
) {
  (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture =
    () => false;
  (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture =
    () => undefined;
  (Element.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture =
    () => undefined;
}
if (
  typeof (Element.prototype as unknown as { scrollIntoView?: unknown })
    .scrollIntoView === "undefined"
) {
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
    () => undefined;
}

type Warehouse = { id: number; name: string; isVirtual: boolean };
type WarehouseStockEntry = {
  warehouseId: number;
  warehouseName: string;
  quantity: number;
};
type Item = {
  id: number;
  sku: string;
  name: string;
  barcode: string | null;
  category: string | null;
  unit: string;
  salePrice: number;
  reorderLevel: number;
  totalStock: number;
  stockAtWarehouse: number | null;
  warehouseStock: WarehouseStockEntry[] | null;
  hasVariants: boolean;
  isBundle: boolean;
  parentItemId: number | null;
  variantOptions: Record<string, unknown> | null;
  variantCount: number;
  imageUrl: string | null;
  description: string | null;
  hsnCode: string | null;
  taxRate: number;
  purchasePrice: number;
  trackBatches: boolean;
  barcodeSource: "auto" | "manual" | null;
};

const WH_MAIN: Warehouse = { id: 1, name: "Main Warehouse", isVirtual: false };
const WH_NORTH: Warehouse = { id: 2, name: "North Depot", isVirtual: false };
const WH_VIRTUAL: Warehouse = {
  id: 3,
  name: "Job Worker Co",
  isVirtual: true,
};

function makeItem(overrides: Partial<Item>): Item {
  return {
    id: 0,
    sku: "SKU",
    name: "Item",
    barcode: null,
    category: null,
    unit: "ea",
    salePrice: 0,
    reorderLevel: 0,
    totalStock: 0,
    stockAtWarehouse: null,
    warehouseStock: null,
    hasVariants: false,
    isBundle: false,
    parentItemId: null,
    variantOptions: null,
    variantCount: 0,
    imageUrl: null,
    description: null,
    hsnCode: null,
    taxRate: 0,
    purchasePrice: 0,
    trackBatches: false,
    barcodeSource: null,
    ...overrides,
  };
}

// Two items: ITEM_SPLIT lives in two real warehouses (so the
// "+1 more" badge should appear in the All-warehouses view), and
// ITEM_SINGLE only lives in the main warehouse.
const ITEM_SPLIT = makeItem({
  id: 101,
  sku: "SKU-SPLIT",
  name: "Splitter Widget",
  totalStock: 12,
  stockAtWarehouse: 10,
  warehouseStock: [
    {
      warehouseId: WH_MAIN.id,
      warehouseName: WH_MAIN.name,
      quantity: 10,
    },
    {
      warehouseId: WH_NORTH.id,
      warehouseName: WH_NORTH.name,
      quantity: 2,
    },
  ],
});
const ITEM_SINGLE = makeItem({
  id: 202,
  sku: "SKU-SINGLE",
  name: "Single Widget",
  totalStock: 5,
  stockAtWarehouse: 5,
  warehouseStock: [
    {
      warehouseId: WH_MAIN.id,
      warehouseName: WH_MAIN.name,
      quantity: 5,
    },
  ],
});

let lastListItemsParams: Record<string, unknown> | undefined;
let warehouses: Warehouse[] = [WH_MAIN, WH_NORTH, WH_VIRTUAL];

vi.mock("@/lib/queryKeys", () => {
  return {
    useListItems: (params?: Record<string, unknown>) => {
      // The page calls useListItems twice — once with options for the
      // table, and a second {} call to seed category/unit dropdowns.
      // We only care about the first (option-bearing) call.
      if (params && Object.keys(params).length > 0) {
        lastListItemsParams = params;
      }
      const data =
        params?.warehouseId !== undefined
          ? // Picker scoped to a specific warehouse: only items present
            // there. Replace warehouseStock with the scoped slice.
            [ITEM_SPLIT, ITEM_SINGLE].map((it) => {
              const wid = params!.warehouseId as number;
              const cell = (it.warehouseStock ?? []).find(
                (w) => w.warehouseId === wid,
              );
              return {
                ...it,
                stockAtWarehouse: cell?.quantity ?? 0,
                warehouseStock: cell ? [cell] : [],
              };
            })
          : [ITEM_SPLIT, ITEM_SINGLE];
      return { data, isLoading: false };
    },
    useListWarehouses: () => ({ data: warehouses, isLoading: false }),
    useCreateItem: () => ({ mutate: vi.fn(), isPending: false }),
    useUpdateItem: () => ({ mutate: vi.fn(), isPending: false }),
    useDeleteItem: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn() }),
}));

vi.mock("@/hooks/use-focus-param", () => ({
  useFocusParam: () => ({ focusId: null, clear: () => {} }),
  useNewParam: () => ({ shouldOpenNew: false, clear: () => {} }),
}));

// The bulk import / barcode scanner / debounce dialogs are not on the
// happy path of the warehouse-picker behaviour we're testing; stub
// them out to avoid pulling in their own heavy dep trees.
vi.mock("@/components/BulkImportItemsDialog", () => ({
  BulkImportItemsDialog: () => null,
}));
vi.mock("@/components/BarcodeScannerDialog", () => ({
  BarcodeScannerDialog: () => null,
}));
// ImageUploader pulls in @workspace/object-storage-web → uppy → a
// JSX runtime resolution that vitest can't satisfy in this monorepo
// layout. Stub the component out — it's only reachable through the
// edit sheet, which we don't open in these tests.
vi.mock("@/components/ImageUploader", () => ({
  ImageUploader: () => null,
}));
vi.mock("@/hooks/use-debounce", () => ({
  useDebounce: <T,>(v: T) => v,
}));

import Items from "./Items";

function renderItems() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Router>
        <Items />
      </Router>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  lastListItemsParams = undefined;
  warehouses = [WH_MAIN, WH_NORTH, WH_VIRTUAL];
});
afterEach(() => cleanup());

describe("Items page Warehouse column", () => {
  it("defaults the picker to 'All warehouses' and shows the breakdown", () => {
    renderItems();

    // Picker shows the "All warehouses" placeholder by default.
    const trigger = screen.getByTestId("select-items-warehouse");
    expect(trigger.textContent ?? "").toMatch(/all warehouses/i);

    // The split item shows its top warehouse + a "+1 more" badge.
    const splitCell = screen.getByTestId(`text-warehouse-${ITEM_SPLIT.id}`);
    expect(splitCell.textContent ?? "").toContain("Main Warehouse");
    const moreBadge = screen.getByTestId(`text-warehouse-${ITEM_SPLIT.id}-more`);
    expect(moreBadge.textContent ?? "").toContain("+1 more");

    // The single-warehouse item shows just its warehouse with no
    // "+N more" badge alongside it.
    const singleCell = screen.getByTestId(`text-warehouse-${ITEM_SINGLE.id}`);
    expect(singleCell.textContent ?? "").toContain("Main Warehouse");
    expect(
      screen.queryByTestId(`text-warehouse-${ITEM_SINGLE.id}-more`),
    ).toBeNull();

    // Stock cells render the per-item totalStock under "all".
    expect(
      screen.getByTestId(`text-stock-${ITEM_SPLIT.id}`).textContent ?? "",
    ).toContain("12");
    expect(
      screen.getByTestId(`text-stock-${ITEM_SINGLE.id}`).textContent ?? "",
    ).toContain("5");

    // Sanity: the request actually asked for the breakdown and did NOT
    // pin a warehouseId.
    expect(lastListItemsParams?.includeWarehouseBreakdown).toBe(true);
    expect(lastListItemsParams?.warehouseId).toBeUndefined();
  });

  it("switching to a specific warehouse renders that warehouse name in each cell and scopes the stock cell", () => {
    renderItems();

    // Open the picker and pick "North Depot".
    fireEvent.click(screen.getByTestId("select-items-warehouse"));
    const option = screen.getByRole("option", { name: "North Depot" });
    fireEvent.click(option);

    // Picker now reflects the chosen warehouse.
    expect(
      screen.getByTestId("select-items-warehouse").textContent ?? "",
    ).toContain("North Depot");

    // Both items now show "North Depot" in the Warehouse cell. Even
    // for the single-warehouse item (which has no stock there in the
    // fixture), the picker has scoped the column so the warehouse
    // name is what gets rendered.
    expect(
      screen.getByTestId(`text-warehouse-${ITEM_SPLIT.id}`).textContent ?? "",
    ).toContain("North Depot");
    expect(
      screen.getByTestId(`text-warehouse-${ITEM_SINGLE.id}`).textContent ?? "",
    ).toContain("North Depot");

    // No "+N more" badge in the scoped view — we're already pinned
    // to a single warehouse.
    expect(
      screen.queryByTestId(`text-warehouse-${ITEM_SPLIT.id}-more`),
    ).toBeNull();

    // Stock cell now shows the per-warehouse stock, not the total.
    // ITEM_SPLIT has 2 in North Depot; ITEM_SINGLE has 0 there.
    expect(
      screen.getByTestId(`text-stock-${ITEM_SPLIT.id}`).textContent ?? "",
    ).toContain("2 ea");
    expect(
      screen.getByTestId(`text-stock-${ITEM_SINGLE.id}`).textContent ?? "",
    ).toContain("0 ea");

    // The list query was actually asked for the picked warehouse.
    expect(lastListItemsParams?.warehouseId).toBe(WH_NORTH.id);
    expect(lastListItemsParams?.includeWarehouseBreakdown).toBe(true);
  });

  it("the picker hides virtual job-worker warehouses from its options", () => {
    renderItems();

    fireEvent.click(screen.getByTestId("select-items-warehouse"));
    // Real warehouses appear; the virtual one does not.
    expect(screen.getByRole("option", { name: "Main Warehouse" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "North Depot" })).toBeTruthy();
    expect(
      screen.queryByRole("option", { name: "Job Worker Co" }),
    ).toBeNull();
  });
});
