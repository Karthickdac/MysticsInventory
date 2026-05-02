import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { format } from "date-fns";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Info,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { getEinvoiceFixSummary } from "@/lib/einvoiceFixes";
import {
  STATUS_LABEL,
  buildBatchCsv,
  extractIrnForRow,
  hasIrpAck,
} from "@/lib/bulkEinvoiceCsv";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import {
  useStartBulkEinvoice,
  useGetBulkEinvoiceBatch,
  getGetBulkEinvoiceBatchQueryKey,
  getListSalesOrdersQueryKey,
  type BulkEinvoiceBatch,
  type BulkEinvoiceResultRow,
  BulkEinvoiceResultRowStatus,
} from "@/lib/queryKeys";

type RowStatus = BulkEinvoiceResultRow["status"];

interface BulkEinvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Order ids the user selected on the SalesOrders page. The dialog
  // owns the lifecycle of the in-flight batch and can swap this set
  // out for "just the failures" when the operator clicks Retry.
  orderIds: number[];
}

// Render the IRP ack date for inline display next to the IRN.
// Returns null when there's nothing useful to show, so the caller
// can omit the line entirely instead of printing a placeholder.
function formatAckDateForDisplay(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return format(parsed, "MMM d, h:mm a");
}

// Render a duration in the most natural unit for the operator —
// sub-second runs in ms, short runs in seconds with one decimal,
// and longer runs in `Mm Ss` so a multi-minute batch doesn't
// degrade into an unreadable "247.4s".
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  // Round to whole seconds first, then derive minutes/seconds — that
  // way a value like 119.7s renders as `2m` instead of `1m 60s` when
  // the seconds component would otherwise round up to 60.
  const roundedTotalSeconds = Math.round(totalSeconds);
  const minutes = Math.floor(roundedTotalSeconds / 60);
  const seconds = roundedTotalSeconds - minutes * 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function downloadBatchCsv(batch: BulkEinvoiceBatch) {
  const csv = buildBatchCsv(batch);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  // Timestamp the file so an operator who runs several batches in a
  // sitting doesn't end up with collisions in their Downloads folder.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  a.download = `einvoice-batch-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function StatusPill({ status }: { status: RowStatus }) {
  const Icon =
    status === BulkEinvoiceResultRowStatus.success
      ? CheckCircle2
      : status === BulkEinvoiceResultRowStatus.already_issued
        ? CheckCircle2
        : status === BulkEinvoiceResultRowStatus.failed
          ? AlertTriangle
          : status === BulkEinvoiceResultRowStatus.ineligible
            ? Info
            : status === BulkEinvoiceResultRowStatus.skipped
              ? Info
              : status === BulkEinvoiceResultRowStatus.running
                ? Loader2
                : XCircle;

  const tone =
    status === BulkEinvoiceResultRowStatus.success ||
    status === BulkEinvoiceResultRowStatus.already_issued
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
      : status === BulkEinvoiceResultRowStatus.failed
        ? "bg-destructive text-destructive-foreground"
        : status === BulkEinvoiceResultRowStatus.running
          ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
          : "bg-muted text-muted-foreground";

  return (
    <Badge
      variant="outline"
      className={`${tone} border-transparent`}
      data-testid={`bulk-einvoice-row-status-${status}`}
    >
      <Icon
        className={`mr-1 h-3 w-3 ${status === BulkEinvoiceResultRowStatus.running ? "animate-spin" : ""}`}
      />
      {STATUS_LABEL[status]}
    </Badge>
  );
}

export function BulkEinvoiceDialog({
  open,
  onOpenChange,
  orderIds,
}: BulkEinvoiceDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [batchId, setBatchId] = useState<string | null>(null);
  // We hold the most recent batch payload locally (in addition to the
  // query cache) so that closing the dialog mid-batch and reopening
  // wouldn't accidentally lose the last summary. The polling query
  // is the source of truth while the dialog is open.
  const [latest, setLatest] = useState<BulkEinvoiceBatch | null>(null);
  const lastInvalidatedSnapshot = useRef<string>("");

  const startMutation = useStartBulkEinvoice({
    mutation: {
      onSuccess: (data) => {
        setBatchId(data.id);
        setLatest(data);
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        toast({
          title: "Could not start bulk e-invoice",
          description:
            e.response?.data?.error ??
            "Please try again. If the issue persists, check your IRP integration.",
          variant: "destructive",
        });
      },
    },
  });

  // Auto-kick the batch the first time the dialog opens with a fresh
  // set of orderIds. The user clicked "Generate e-invoices" already;
  // they shouldn't have to confirm twice.
  const autoStartedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const key = orderIds.join(",");
    if (autoStartedRef.current === key) return;
    autoStartedRef.current = key;
    setBatchId(null);
    setLatest(null);
    startMutation.mutate({ data: { orderIds } });
    // We deliberately omit startMutation from deps — it's stable for
    // our purposes and including it would cause re-entry on each
    // mutation state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, orderIds]);

  const pollQuery = useGetBulkEinvoiceBatch(batchId ?? "", {
    query: {
      enabled: !!batchId,
      queryKey: getGetBulkEinvoiceBatchQueryKey(batchId ?? ""),
      // Stop polling as soon as the worker reports it is done.
      refetchInterval: (query) => {
        const data = query.state.data as BulkEinvoiceBatch | undefined;
        return data?.status === "completed" ? false : 1500;
      },
      refetchIntervalInBackground: true,
    },
  });

  // Keep the local snapshot in sync with the polled data. We also
  // invalidate the SalesOrders list cache once the batch finishes —
  // that's when the e-invoice badges on each row need to refresh.
  useEffect(() => {
    if (pollQuery.data) {
      setLatest(pollQuery.data);
      const snap = `${pollQuery.data.id}:${pollQuery.data.processed}`;
      if (
        pollQuery.data.status === "completed" &&
        lastInvalidatedSnapshot.current !== snap
      ) {
        lastInvalidatedSnapshot.current = snap;
        queryClient.invalidateQueries({
          queryKey: getListSalesOrdersQueryKey(),
        });
      }
    }
  }, [pollQuery.data, queryClient]);

  const batch = latest;
  const isRunning = batch?.status === "running" || startMutation.isPending;
  const progressPct =
    batch && batch.total > 0
      ? Math.round((batch.processed / batch.total) * 100)
      : 0;

  const failedRows = useMemo(
    () =>
      (batch?.results ?? []).filter(
        (r) => r.status === BulkEinvoiceResultRowStatus.failed,
      ),
    [batch],
  );

  const handleRetryFailures = () => {
    if (failedRows.length === 0) return;
    autoStartedRef.current = null; // force a fresh auto-start
    setBatchId(null);
    setLatest(null);
    startMutation.mutate({
      data: { orderIds: failedRows.map((r) => r.orderId) },
    });
  };

  const handleClose = () => {
    onOpenChange(false);
    // Reset on next open. We do *not* abort an in-flight batch on
    // close — the worker keeps running on the server, and reopening
    // with the same orderIds will see the previous attempt's per-
    // order state via the regular sales-order list refresh.
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleClose();
        else onOpenChange(true);
      }}
    >
      <DialogContent
        className="max-w-2xl"
        data-testid="bulk-einvoice-dialog"
      >
        <DialogHeader>
          <DialogTitle>Generate e-invoices</DialogTitle>
          <DialogDescription>
            We'll register an IRN with the IRP for each selected order.
            Re-running on a partial-success batch only retries the
            failures — orders that already carry an active IRN are
            skipped automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <Progress value={progressPct} className="h-2" />
            </div>
            <p
              className="text-sm tabular-nums text-muted-foreground"
              data-testid="bulk-einvoice-progress-text"
            >
              {batch ? `${batch.processed} / ${batch.total}` : "—"}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded border p-2">
              <p className="text-muted-foreground">Succeeded</p>
              <p
                className="text-lg font-semibold text-emerald-600"
                data-testid="bulk-einvoice-count-succeeded"
              >
                {batch?.succeeded ?? 0}
              </p>
            </div>
            <div className="rounded border p-2">
              <p className="text-muted-foreground">Failed</p>
              <p
                className="text-lg font-semibold text-destructive"
                data-testid="bulk-einvoice-count-failed"
              >
                {batch?.failed ?? 0}
              </p>
            </div>
            <div className="rounded border p-2">
              <p className="text-muted-foreground">Skipped</p>
              <p
                className="text-lg font-semibold text-muted-foreground"
                data-testid="bulk-einvoice-count-skipped"
              >
                {batch?.skipped ?? 0}
              </p>
            </div>
          </div>

          {batch?.status === "completed" && batch.durationMs != null && (
            // Tiny per-batch performance summary so an operator can
            // see at a glance whether a slow IRP day is dragging
            // their bulk run out — and whether bumping the
            // BULK_CONCURRENCY env knob actually moved the number.
            // The matching structured log line is emitted server-side
            // for offline analysis.
            <p
              className="text-center text-xs text-muted-foreground"
              data-testid="bulk-einvoice-timing-summary"
            >
              Took {formatDuration(batch.durationMs)}
              {batch.ordersPerSecond != null && (
                <> · {batch.ordersPerSecond} orders/s</>
              )}
              {" · concurrency "}
              {batch.concurrency}
            </p>
          )}

          <ScrollArea className="h-[300px] rounded-md border">
            <ul className="divide-y">
              {(batch?.results ?? []).map((r) => {
                // For genuine IRP failures we surface the same friendly
                // "what to fix" guidance as the SalesOrderDetail panel
                // so the operator sees a one-click action instead of a
                // raw error string. Fixes that need a customer name
                // aren't computable from the bulk batch row (we only
                // carry order id/number), so the title falls back to
                // the generic phrasing — that's still much friendlier
                // than the raw IRP message.
                const fix =
                  r.status === BulkEinvoiceResultRowStatus.failed
                    ? getEinvoiceFixSummary({
                        errorCode: r.errorCode,
                      })
                    : null;
                // Surface the IRN inline for any row that has one
                // attached — both freshly-issued (`success`) and
                // pre-existing (`already_issued`). Showing it here
                // (not just in the CSV) means an operator can read
                // the IRN straight off the dialog without opening
                // each order's detail page.
                const inlineIrn = extractIrnForRow(r);
                // Gate the inline ack date through the same helper
                // the CSV uses, so the dialog and the download stay
                // exactly in sync — an unexpected row carrying an
                // IRN with a non-`success`/`already_issued` status
                // shouldn't sneak an ack date onto the screen
                // either.
                const inlineAckDate =
                  inlineIrn && hasIrpAck(r.status)
                    ? formatAckDateForDisplay(r.ackDate)
                    : null;
                return (
                  <li
                    key={r.orderId}
                    className="flex items-start justify-between gap-3 p-3"
                    data-testid={`bulk-einvoice-row-${r.orderId}`}
                  >
                    <div className="min-w-0">
                      <p className="font-mono text-sm font-medium">
                        {r.orderNumber ?? `#${r.orderId}`}
                      </p>
                      {fix ? (
                        <div className="mt-0.5 space-y-1">
                          <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                            {fix.title}
                          </p>
                          <Link
                            href={fix.href}
                            className="inline-flex text-xs text-primary hover:underline"
                            data-testid={`bulk-einvoice-fix-cta-${r.orderId}`}
                          >
                            {fix.cta}
                          </Link>
                        </div>
                      ) : inlineIrn ? (
                        <>
                          <p
                            className="mt-0.5 font-mono text-xs text-muted-foreground break-all"
                            data-testid={`bulk-einvoice-row-irn-${r.orderId}`}
                          >
                            IRN {inlineIrn}
                          </p>
                          {inlineAckDate && (
                            <p
                              className="text-xs text-muted-foreground"
                              data-testid={`bulk-einvoice-row-ack-date-${r.orderId}`}
                            >
                              Acknowledged {inlineAckDate}
                            </p>
                          )}
                        </>
                      ) : (
                        r.message && (
                          <p className="mt-0.5 text-xs text-muted-foreground break-words">
                            {r.message}
                          </p>
                        )
                      )}
                    </div>
                    <StatusPill status={r.status} />
                  </li>
                );
              })}
              {!batch && (
                <li className="p-6 text-center text-sm text-muted-foreground">
                  Starting bulk registration…
                </li>
              )}
            </ul>
          </ScrollArea>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          {batch && batch.results.length > 0 && (
            <Button
              variant="outline"
              onClick={() => downloadBatchCsv(batch)}
              data-testid="btn-bulk-einvoice-download-csv"
            >
              <Download className="mr-2 h-4 w-4" />
              Download CSV
            </Button>
          )}
          {!isRunning && failedRows.length > 0 && (
            <Button
              variant="outline"
              onClick={handleRetryFailures}
              disabled={startMutation.isPending}
              data-testid="btn-bulk-einvoice-retry-failures"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry {failedRows.length}{" "}
              {failedRows.length === 1 ? "failure" : "failures"}
            </Button>
          )}
          <Button
            variant={isRunning ? "outline" : "default"}
            onClick={handleClose}
            data-testid="btn-bulk-einvoice-close"
          >
            {isRunning ? "Run in background" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
