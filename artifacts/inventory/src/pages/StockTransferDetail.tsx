import { Link, useLocation, useParams } from "wouter";
import { useState } from "react";
import {
  useGetStockTransfer,
  useDispatchStockTransfer,
  useCompleteStockTransfer,
  useCancelStockTransfer,
  useDeleteStockTransfer,
  getGetStockTransferQueryKey,
  getListStockTransfersQueryKey,
  getListStockMovementsQueryKey,
  getListItemsQueryKey,
} from "@/lib/queryKeys";
import { BatchPickerForLine } from "@/components/NewShipmentDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/StatusBadge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { formatDate } from "@/lib/format";
import {
  ArrowLeft,
  ArrowRight,
  Truck,
  CheckCircle2,
  XCircle,
  Trash2,
  FileDown,
} from "lucide-react";
import { downloadStockTransferPdf } from "@workspace/api-client-react";

function showError(toast: ReturnType<typeof useToast>["toast"], err: unknown) {
  const e = err as { response?: { data?: { error?: string } } };
  toast({
    title: "Action failed",
    description: e.response?.data?.error ?? "Please try again.",
    variant: "destructive",
  });
}

export default function StockTransferDetail() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirmAction, setConfirmAction] = useState<
    "dispatch" | "complete" | "cancel" | "delete" | null
  >(null);
  const [dispatchDialogOpen, setDispatchDialogOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [batchPicks, setBatchPicks] = useState<
    Record<number, Record<number, string>>
  >({});

  const { data, isLoading, error } = useGetStockTransfer(id);

  const invalidateAll = () => {
    queryClient.invalidateQueries({
      queryKey: getGetStockTransferQueryKey(id),
    });
    queryClient.invalidateQueries({
      queryKey: getListStockTransfersQueryKey(),
    });
    queryClient.invalidateQueries({
      queryKey: getListStockMovementsQueryKey(),
    });
    queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
  };

  const dispatchMutation = useDispatchStockTransfer({
    mutation: {
      onSuccess: () => {
        invalidateAll();
        toast({ title: "Transfer dispatched" });
        setConfirmAction(null);
      },
      onError: (err) => {
        showError(toast, err);
        setConfirmAction(null);
      },
    },
  });
  const completeMutation = useCompleteStockTransfer({
    mutation: {
      onSuccess: () => {
        invalidateAll();
        toast({ title: "Transfer completed" });
        setConfirmAction(null);
      },
      onError: (err) => {
        showError(toast, err);
        setConfirmAction(null);
      },
    },
  });
  const cancelMutation = useCancelStockTransfer({
    mutation: {
      onSuccess: () => {
        invalidateAll();
        toast({ title: "Transfer cancelled" });
        setConfirmAction(null);
      },
      onError: (err) => {
        showError(toast, err);
        setConfirmAction(null);
      },
    },
  });
  const deleteMutation = useDeleteStockTransfer({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getListStockTransfersQueryKey(),
        });
        toast({ title: "Transfer deleted" });
        setLocation("/transfers");
      },
      onError: (err) => {
        showError(toast, err);
        setConfirmAction(null);
      },
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/transfers">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to transfers
          </Link>
        </Button>
        <p className="text-muted-foreground">Transfer not found.</p>
      </div>
    );
  }

  const { transfer, lines } = data;
  const status = transfer.status;
  const canDispatch = status === "draft";
  const canComplete = status === "in_transit";
  const canCancel = status === "draft" || status === "in_transit";
  const canDelete = status === "draft";

  const totalUnits = lines.reduce((sum, l) => sum + Number(l.quantity), 0);
  const trackedLines = lines.filter((l) => l.trackBatches);
  const hasTrackedLines = trackedLines.length > 0;

  const handleDispatchClick = () => {
    if (hasTrackedLines) {
      const init: Record<number, Record<number, string>> = {};
      for (const l of trackedLines) init[l.id] = {};
      setBatchPicks(init);
      setDispatchDialogOpen(true);
    } else {
      setConfirmAction("dispatch");
    }
  };

  const handleDispatchSubmit = () => {
    const dispatchLines: {
      itemId: number;
      batches: { itemBatchId: number; quantity: number }[];
    }[] = [];
    for (const l of trackedLines) {
      const picks = batchPicks[l.id] ?? {};
      const usable = Object.entries(picks)
        .filter(([, q]) => Number(q) > 0)
        .map(([bid, q]) => ({
          itemBatchId: Number(bid),
          quantity: Number(q),
        }));
      const sum = usable.reduce((s, p) => s + p.quantity, 0);
      const need = Number(l.quantity);
      if (Math.abs(sum - need) > 1e-6) {
        toast({
          title: `Pick must total ${need} for ${l.itemName}`,
          description: `You currently have ${sum} selected.`,
          variant: "destructive",
        });
        return;
      }
      dispatchLines.push({ itemId: l.itemId, batches: usable });
    }
    dispatchMutation.mutate(
      { id, data: { lines: dispatchLines } },
      {
        onSuccess: () => {
          setDispatchDialogOpen(false);
          setBatchPicks({});
        },
      },
    );
  };

  const runConfirm = () => {
    if (confirmAction === "dispatch")
      dispatchMutation.mutate({ id, data: { lines: [] } });
    else if (confirmAction === "complete") completeMutation.mutate({ id });
    else if (confirmAction === "cancel") cancelMutation.mutate({ id });
    else if (confirmAction === "delete") deleteMutation.mutate({ id });
  };

  const confirmCopy: Record<
    NonNullable<typeof confirmAction>,
    { title: string; body: string; cta: string }
  > = {
    dispatch: {
      title: "Dispatch this transfer?",
      body: `Stock will be deducted from ${transfer.fromWarehouseName} and the transfer will move to in-transit.`,
      cta: "Dispatch",
    },
    complete: {
      title: "Mark transfer complete?",
      body: `Stock will be added to ${transfer.toWarehouseName}. This cannot be undone.`,
      cta: "Complete",
    },
    cancel: {
      title: "Cancel this transfer?",
      body:
        status === "in_transit"
          ? `In-transit stock will be returned to ${transfer.fromWarehouseName}.`
          : "Draft transfer will be marked cancelled. No stock changes.",
      cta: "Cancel transfer",
    },
    delete: {
      title: "Delete this draft transfer?",
      body: "This permanently removes the transfer record.",
      cta: "Delete",
    },
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/transfers">
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
          <PageHeader
            title={`Transfer ${transfer.transferNumber}`}
            description={formatDate(transfer.transferDate)}
            className="mb-0"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={async () => {
              setDownloading(true);
              try {
                const blob = (await downloadStockTransferPdf(
                  id,
                )) as unknown as Blob;
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `transfer-${transfer.transferNumber}.pdf`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 0);
              } catch (err) {
                showError(toast, err);
              } finally {
                setDownloading(false);
              }
            }}
            disabled={downloading}
            data-testid="btn-download-transfer"
          >
            <FileDown className="mr-2 h-4 w-4" />
            {downloading ? "Preparing..." : "Download PDF"}
          </Button>
          {canDispatch && (
            <Button onClick={handleDispatchClick} data-testid="btn-dispatch">
              <Truck className="mr-2 h-4 w-4" />
              Dispatch
            </Button>
          )}
          {canComplete && (
            <Button
              onClick={() => setConfirmAction("complete")}
              data-testid="btn-complete"
            >
              <CheckCircle2 className="mr-2 h-4 w-4" />
              Mark received
            </Button>
          )}
          {canCancel && (
            <Button
              variant="outline"
              onClick={() => setConfirmAction("cancel")}
              data-testid="btn-cancel"
            >
              <XCircle className="mr-2 h-4 w-4" />
              Cancel
            </Button>
          )}
          {canDelete && (
            <Button
              variant="outline"
              className="text-destructive"
              onClick={() => setConfirmAction("delete")}
              data-testid="btn-delete"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Transfer details</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            <div>
              <p className="text-xs text-muted-foreground">Status</p>
              <div className="mt-1">
                <StatusBadge status={status} />
              </div>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">From</p>
              <p
                className="font-medium mt-1"
                data-testid="text-from-warehouse"
              >
                {transfer.fromWarehouseName}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">To</p>
              <p className="font-medium mt-1" data-testid="text-to-warehouse">
                {transfer.toWarehouseName}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total units</p>
              <p className="font-medium mt-1">{totalUnits}</p>
            </div>
          </div>
          {transfer.notes && (
            <div className="mt-6">
              <p className="text-xs text-muted-foreground">Notes</p>
              <p className="mt-1 whitespace-pre-wrap">{transfer.notes}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Items ({lines.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="w-32">From</TableHead>
                <TableHead className="w-12"></TableHead>
                <TableHead className="w-32">To</TableHead>
                <TableHead className="text-right w-32">Quantity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line) => (
                <TableRow
                  key={line.id}
                  data-testid={`row-transfer-line-${line.id}`}
                >
                  <TableCell className="font-medium">
                    <Link
                      href={`/items/${line.itemId}`}
                      className="hover:underline"
                    >
                      {line.itemName}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {line.sku}
                  </TableCell>
                  <TableCell className="text-sm">
                    {transfer.fromWarehouseName}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <ArrowRight className="h-4 w-4" />
                  </TableCell>
                  <TableCell className="text-sm">
                    {transfer.toWarehouseName}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {Number(line.quantity)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog
        open={dispatchDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setDispatchDialogOpen(false);
            setBatchPicks({});
          }
        }}
      >
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Dispatch transfer</DialogTitle>
            <DialogDescription>
              Pick the exact batches to ship from{" "}
              {transfer.fromWarehouseName}. The picked quantity must match
              each line's transfer quantity.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {trackedLines.map((l) => {
              const picks = batchPicks[l.id] ?? {};
              const pickSum = Object.values(picks).reduce(
                (s, q) => s + (Number(q) || 0),
                0,
              );
              const need = Number(l.quantity);
              return (
                <div
                  key={l.id}
                  className="rounded-md border p-3 space-y-2"
                  data-testid={`dispatch-line-${l.id}`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium flex items-center gap-2">
                        {l.itemName}
                        <Badge variant="secondary">Tracked</Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {l.sku}
                      </div>
                    </div>
                    <div className="text-sm">
                      <span
                        className={
                          Math.abs(pickSum - need) < 1e-6
                            ? "font-medium"
                            : "text-destructive font-medium"
                        }
                        data-testid={`dispatch-pick-sum-${l.id}`}
                      >
                        {pickSum} / {need}
                      </span>
                    </div>
                  </div>
                  <BatchPickerForLine
                    itemId={l.itemId}
                    warehouseId={transfer.fromWarehouseId}
                    picks={picks}
                    remaining={need}
                    testIdPrefix={`dispatch-line-${l.id}`}
                    onPickChange={(batchId, qty) =>
                      setBatchPicks((prev) => ({
                        ...prev,
                        [l.id]: { ...(prev[l.id] ?? {}), [batchId]: qty },
                      }))
                    }
                    onAutoFillFefo={(suggested) =>
                      setBatchPicks((prev) => ({
                        ...prev,
                        [l.id]: suggested,
                      }))
                    }
                  />
                </div>
              );
            })}
            {lines.some((l) => !l.trackBatches) && (
              <p className="text-xs text-muted-foreground">
                Untracked lines will be dispatched automatically with
                their full quantities.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDispatchDialogOpen(false);
                setBatchPicks({});
              }}
              data-testid="btn-dispatch-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={handleDispatchSubmit}
              disabled={dispatchMutation.isPending}
              data-testid="btn-dispatch-submit"
            >
              {dispatchMutation.isPending ? "Dispatching..." : "Dispatch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
      >
        <AlertDialogTrigger asChild>
          <span />
        </AlertDialogTrigger>
        {confirmAction && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirmCopy[confirmAction].title}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirmCopy[confirmAction].body}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="btn-confirm-no">
                Back
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={runConfirm}
                data-testid="btn-confirm-yes"
              >
                {confirmCopy[confirmAction].cta}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </div>
  );
}
