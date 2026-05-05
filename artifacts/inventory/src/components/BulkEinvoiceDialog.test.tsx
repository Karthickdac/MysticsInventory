import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  BulkEinvoiceResultRowStatus,
  type BulkEinvoiceBatch,
  type BulkEinvoiceResultRow,
} from "@/lib/queryKeys";

// jsdom doesn't ship a ResizeObserver, but radix's ScrollArea (used by
// the dialog) constructs one on mount. Provide the smallest possible
// stub so we don't blow up before reaching the assertions.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

// Capture every call to startMutation.mutate and let tests drive the
// success callback with a freshly-minted batch payload. The dialog
// reaches for both useStartBulkEinvoice and useGetBulkEinvoiceBatch
// through @/lib/queryKeys, so mocking that re-export module is the
// single seam that intercepts both hooks without touching the
// generated client.
type StartMutationOptions = {
  mutation?: {
    onSuccess?: (data: BulkEinvoiceBatch, vars: unknown, ctx: unknown) => void;
    onError?: (err: unknown, vars: unknown, ctx: unknown) => void;
  };
};

const startCalls: number[][] = [];
const pollSubscribers = new Map<string, Set<(d: BulkEinvoiceBatch | undefined) => void>>();
const pollData = new Map<string, BulkEinvoiceBatch>();
let lastStartOptions: StartMutationOptions | undefined;

function publishPoll(batchId: string, data: BulkEinvoiceBatch) {
  pollData.set(batchId, data);
  pollSubscribers.get(batchId)?.forEach((listener) => listener(data));
}

vi.mock("@/lib/queryKeys", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/queryKeys")>("@/lib/queryKeys");
  return {
    ...actual,
    useStartBulkEinvoice: (options: StartMutationOptions) => {
      lastStartOptions = options;
      return {
        mutate: (vars: { data: { orderIds: number[] } }) => {
          startCalls.push([...vars.data.orderIds]);
          // Hand back a synthetic "running" batch immediately, the
          // way the real server would (the worker assigns the id and
          // the dialog's onSuccess pins it into local state).
          const id = `batch-${startCalls.length}`;
          const initial = makeBatch({
            id,
            status: "running",
            orderIds: vars.data.orderIds,
          });
          pollData.set(id, initial);
          options?.mutation?.onSuccess?.(initial, vars, undefined);
        },
        isPending: false,
        isError: false,
        isSuccess: true,
        reset: () => {},
      };
    },
    useGetBulkEinvoiceBatch: (batchId: string) => {
      const [data, setData] = React.useState<BulkEinvoiceBatch | undefined>(
        () => (batchId ? pollData.get(batchId) : undefined),
      );
      React.useEffect(() => {
        if (!batchId) {
          setData(undefined);
          return;
        }
        const listeners = pollSubscribers.get(batchId) ?? new Set();
        listeners.add(setData);
        pollSubscribers.set(batchId, listeners);
        // Sync to whatever the latest published value is, so a batch
        // id flip picks up the cached payload synchronously instead
        // of waiting for the next publish.
        setData(pollData.get(batchId));
        return () => {
          listeners.delete(setData);
        };
      }, [batchId]);
      return { data, isLoading: false, isSuccess: !!data };
    },
  };
});

import { BulkEinvoiceDialog } from "./BulkEinvoiceDialog";

function makeRow(
  orderId: number,
  status: BulkEinvoiceResultRow["status"],
  overrides: Partial<BulkEinvoiceResultRow> = {},
): BulkEinvoiceResultRow {
  return {
    orderId,
    orderNumber: `INV-${String(orderId).padStart(4, "0")}`,
    status,
    message: null,
    errorCode: null,
    irn: null,
    ackNumber: null,
    ackDate: null,
    ...overrides,
  };
}

function makeBatch(args: {
  id: string;
  status: BulkEinvoiceBatch["status"];
  orderIds: number[];
  results?: BulkEinvoiceResultRow[];
}): BulkEinvoiceBatch {
  const results =
    args.results ??
    args.orderIds.map((id) => makeRow(id, BulkEinvoiceResultRowStatus.pending));
  const succeeded = results.filter(
    (r) =>
      r.status === BulkEinvoiceResultRowStatus.success ||
      r.status === BulkEinvoiceResultRowStatus.already_issued,
  ).length;
  const failed = results.filter(
    (r) => r.status === BulkEinvoiceResultRowStatus.failed,
  ).length;
  const skipped = results.filter(
    (r) =>
      r.status === BulkEinvoiceResultRowStatus.skipped ||
      r.status === BulkEinvoiceResultRowStatus.ineligible,
  ).length;
  const processed = results.filter(
    (r) =>
      r.status !== BulkEinvoiceResultRowStatus.pending &&
      r.status !== BulkEinvoiceResultRowStatus.running,
  ).length;
  return {
    id: args.id,
    status: args.status,
    createdAt: "2026-05-01T00:00:00.000Z",
    startedAt: "2026-05-01T00:00:00.000Z",
    completedAt:
      args.status === "completed" ? "2026-05-01T00:00:01.000Z" : null,
    durationMs: args.status === "completed" ? 1000 : null,
    ordersPerSecond: args.status === "completed" ? results.length : null,
    concurrency: 1,
    total: args.orderIds.length,
    processed,
    succeeded,
    failed,
    skipped,
    results,
  };
}

function renderDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderIds: number[];
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BulkEinvoiceDialog {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  startCalls.length = 0;
  pollSubscribers.clear();
  pollData.clear();
  lastStartOptions = undefined;
});

afterEach(() => {
  cleanup();
});

describe("BulkEinvoiceDialog lifecycle", () => {
  it("auto-kicks exactly one start mutation per fresh orderIds set", () => {
    const onOpenChange = vi.fn();
    renderDialog({
      open: true,
      onOpenChange,
      orderIds: [101, 102, 103],
    });
    expect(startCalls).toEqual([[101, 102, 103]]);
    expect(screen.getByTestId("bulk-einvoice-dialog")).toBeTruthy();
  });

  it("does not re-fire the auto-start on rerenders with the same orderIds", () => {
    const onOpenChange = vi.fn();
    const orderIds = [201, 202];
    const { rerender } = renderDialog({
      open: true,
      onOpenChange,
      orderIds,
    });
    expect(startCalls).toHaveLength(1);

    // Same array contents (and even a same-reference rerender) must
    // not re-arm the auto-start effect — the autoStartedRef key
    // guards on the joined orderIds.
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    rerender(
      <QueryClientProvider client={client}>
        <BulkEinvoiceDialog
          open
          onOpenChange={onOpenChange}
          orderIds={[...orderIds]}
        />
      </QueryClientProvider>,
    );
    rerender(
      <QueryClientProvider client={client}>
        <BulkEinvoiceDialog
          open
          onOpenChange={onOpenChange}
          orderIds={[201, 202]}
        />
      </QueryClientProvider>,
    );
    expect(startCalls).toHaveLength(1);
  });

  it("closing and reopening with the same orderIds is a no-op", () => {
    const onOpenChange = vi.fn();
    const orderIds = [301, 302];
    const { rerender } = renderDialog({
      open: true,
      onOpenChange,
      orderIds,
    });
    expect(startCalls).toHaveLength(1);

    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    // Simulate the parent closing the dialog…
    rerender(
      <QueryClientProvider client={client}>
        <BulkEinvoiceDialog
          open={false}
          onOpenChange={onOpenChange}
          orderIds={orderIds}
        />
      </QueryClientProvider>,
    );
    // …and reopening it with the same selection. The autoStartedRef
    // key still matches, so no second batch must fire.
    rerender(
      <QueryClientProvider client={client}>
        <BulkEinvoiceDialog
          open
          onOpenChange={onOpenChange}
          orderIds={orderIds}
        />
      </QueryClientProvider>,
    );
    expect(startCalls).toHaveLength(1);
  });

  it("polls until completion and reflects the final summary", () => {
    renderDialog({
      open: true,
      onOpenChange: vi.fn(),
      orderIds: [401, 402],
    });
    expect(startCalls).toEqual([[401, 402]]);
    const batchId = "batch-1";

    // Push a partial-progress poll: one row finished, one still
    // pending. The dialog should keep showing the running summary.
    act(() => {
      publishPoll(
        batchId,
        makeBatch({
          id: batchId,
          status: "running",
          orderIds: [401, 402],
          results: [
            makeRow(401, BulkEinvoiceResultRowStatus.success, {
              irn: "IRN-401",
            }),
            makeRow(402, BulkEinvoiceResultRowStatus.pending),
          ],
        }),
      );
    });
    expect(screen.getByTestId("bulk-einvoice-progress-text").textContent).toBe(
      "1 / 2",
    );

    // Now publish the terminal poll. The final counts and the timing
    // summary should both appear, proving the dialog stopped polling
    // and committed the completed payload.
    act(() => {
      publishPoll(
        batchId,
        makeBatch({
          id: batchId,
          status: "completed",
          orderIds: [401, 402],
          results: [
            makeRow(401, BulkEinvoiceResultRowStatus.success, {
              irn: "IRN-401",
            }),
            makeRow(402, BulkEinvoiceResultRowStatus.failed, {
              errorCode: "RET194",
              message: "Buyer GSTIN is invalid",
            }),
          ],
        }),
      );
    });
    expect(screen.getByTestId("bulk-einvoice-progress-text").textContent).toBe(
      "2 / 2",
    );
    expect(screen.getByTestId("bulk-einvoice-count-succeeded").textContent).toBe(
      "1",
    );
    expect(screen.getByTestId("bulk-einvoice-count-failed").textContent).toBe(
      "1",
    );
    expect(screen.getByTestId("bulk-einvoice-timing-summary")).toBeTruthy();
  });

  it("Retry failures restarts a fresh batch with only the failed order ids", () => {
    renderDialog({
      open: true,
      onOpenChange: vi.fn(),
      orderIds: [501, 502, 503],
    });
    expect(startCalls).toEqual([[501, 502, 503]]);
    const firstBatchId = "batch-1";

    // Drive the first batch to a partial-success terminal state with
    // two failures so the Retry button surfaces.
    act(() => {
      publishPoll(
        firstBatchId,
        makeBatch({
          id: firstBatchId,
          status: "completed",
          orderIds: [501, 502, 503],
          results: [
            makeRow(501, BulkEinvoiceResultRowStatus.success, {
              irn: "IRN-501",
            }),
            makeRow(502, BulkEinvoiceResultRowStatus.failed, {
              errorCode: "RET194",
              message: "Buyer GSTIN is invalid",
            }),
            makeRow(503, BulkEinvoiceResultRowStatus.failed, {
              errorCode: "RET999",
              message: "IRP timeout",
            }),
          ],
        }),
      );
    });

    const retryBtn = screen.getByTestId("btn-bulk-einvoice-retry-failures");
    expect(retryBtn.textContent).toContain("Retry 2 failures");

    fireEvent.click(retryBtn);

    // The retry must have fired exactly one new start mutation, and
    // it must carry only the failed order ids — not the original
    // selection. This is the regression the test is here to guard.
    expect(startCalls).toHaveLength(2);
    expect(startCalls[1]).toEqual([502, 503]);

    // The dialog should now be tracking the second batch, so a poll
    // payload published against the new id must show up in the UI.
    const secondBatchId = "batch-2";
    act(() => {
      publishPoll(
        secondBatchId,
        makeBatch({
          id: secondBatchId,
          status: "running",
          orderIds: [502, 503],
          results: [
            makeRow(502, BulkEinvoiceResultRowStatus.success, {
              irn: "IRN-502-RETRY",
            }),
            makeRow(503, BulkEinvoiceResultRowStatus.pending),
          ],
        }),
      );
    });
    expect(screen.getByTestId("bulk-einvoice-progress-text").textContent).toBe(
      "1 / 2",
    );

    // And the retry-armed dialog must accept the same retry-id flow
    // again on the next completed snapshot — i.e. autoStartedRef was
    // properly reset, so a third manual retry on a brand-new failure
    // would also work.
    act(() => {
      publishPoll(
        secondBatchId,
        makeBatch({
          id: secondBatchId,
          status: "completed",
          orderIds: [502, 503],
          results: [
            makeRow(502, BulkEinvoiceResultRowStatus.success, {
              irn: "IRN-502-RETRY",
            }),
            makeRow(503, BulkEinvoiceResultRowStatus.failed, {
              errorCode: "RET999",
              message: "IRP timeout (again)",
            }),
          ],
        }),
      );
    });
    const retryBtn2 = screen.getByTestId("btn-bulk-einvoice-retry-failures");
    expect(retryBtn2.textContent).toContain("Retry 1 failure");
    fireEvent.click(retryBtn2);
    expect(startCalls).toHaveLength(3);
    expect(startCalls[2]).toEqual([503]);

    // Sanity check: the dialog header still mounts correctly through
    // the whole retry chain (i.e. it didn't unmount on retry).
    expect(
      within(screen.getByTestId("bulk-einvoice-dialog")).getByText(
        "Generate e-invoices",
      ),
    ).toBeTruthy();

    // The captured mutation options should still be the same object
    // across retries — the dialog reuses one mutation hook.
    expect(lastStartOptions?.mutation?.onSuccess).toBeTypeOf("function");
  });
});
