import { Link, useParams } from "wouter";
import { useEffect, useMemo, useState } from "react";
import {
  useGetJobWorkOrder,
  useCancelJobWorkOrder,
  useCancelJobWorkReceipt,
  useIssueJobWorkMaterial,
  useReceiveJobWorkOutput,
  useUpdateJobWorkOrder,
  useGetSupplier,
  getGetJobWorkOrderQueryKey,
  getListJobWorkOrdersQueryKey,
  getReportPendingJobWorkQueryKey,
  getReportStockWithJobWorkersQueryKey,
  getListItemsQueryKey,
  getListPurchaseOrdersQueryKey,
  getListSuppliersQueryKey,
  getGetSupplierQueryKey,
  useGetCurrentOrganization,
} from "@/lib/queryKeys";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/StatusBadge";
import { PageHeader } from "@/components/PageHeader";
import { formatCurrency, formatDate } from "@/lib/format";
import {
  ArrowLeft,
  Send,
  PackageCheck,
  Printer,
  Ban,
  Pencil,
  FileDown,
} from "lucide-react";
import type {
  JobWorkOrderDetail as JobWorkOrderDetailType,
  JobWorkOrderComponent,
} from "@workspace/api-client-react";
import { downloadJobWorkChallan, customFetch } from "@workspace/api-client-react";

async function downloadJobWorkOrderPdf(id: number): Promise<Blob> {
  return customFetch<Blob>(`/api/job-work-orders/${id}/print`, {
    method: "GET",
  });
}

function showError(toast: ReturnType<typeof useToast>["toast"], err: unknown) {
  // The API client (`ApiError`) exposes the parsed JSON body as
  // `err.data`. The older `err.response.data.error` shape never matched
  // ApiError (its `.response` is the raw `Response` object, which has
  // no `.data`), so the real reason was being swallowed and users only
  // ever saw "Please try again." Read both shapes so any future axios-
  // style errors still work.
  const e = err as {
    data?: { error?: string };
    response?: { data?: { error?: string } };
    message?: string;
  };
  toast({
    title: "Action failed",
    description:
      e.data?.error ??
      e.response?.data?.error ??
      e.message ??
      "Please try again.",
    variant: "destructive",
  });
}

export default function JobWorkOrderDetail() {
  const params = useParams<{ id: string }>();
  const orderId = Number(params.id ?? 0);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: detail, isLoading } = useGetJobWorkOrder(orderId);
  const { data: org } = useGetCurrentOrganization();

  const supplierId = detail?.order.supplierId ?? 0;
  const { data: supplierDetail } = useGetSupplier(supplierId, {
    query: {
      enabled: supplierId > 0,
      queryKey: getGetSupplierQueryKey(supplierId),
    },
  });

  const [issueDialogOpen, setIssueDialogOpen] = useState(false);
  const [receiveDialogOpen, setReceiveDialogOpen] = useState(false);
  const [rateDialogOpen, setRateDialogOpen] = useState(false);
  const [infoDialogOpen, setInfoDialogOpen] = useState(false);

  const invalidateAll = () => {
    queryClient.invalidateQueries({
      queryKey: getGetJobWorkOrderQueryKey(orderId),
    });
    queryClient.invalidateQueries({
      queryKey: getListJobWorkOrdersQueryKey(),
    });
    queryClient.invalidateQueries({
      queryKey: getReportPendingJobWorkQueryKey(),
    });
    queryClient.invalidateQueries({
      queryKey: getReportStockWithJobWorkersQueryKey(),
    });
    queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
    // Cancelling a receipt removes its auto-bill and reverses the
    // supplier's outstanding payable, so any open POs / supplier
    // listings need to refresh too.
    queryClient.invalidateQueries({
      queryKey: getListPurchaseOrdersQueryKey(),
    });
    queryClient.invalidateQueries({
      queryKey: getListSuppliersQueryKey(),
    });
  };

  const cancelMutation = useCancelJobWorkOrder({
    mutation: {
      onSuccess: () => {
        invalidateAll();
        toast({ title: "Order cancelled" });
      },
      onError: (err) => showError(toast, err),
    },
  });

  const cancelReceiptMutation = useCancelJobWorkReceipt({
    mutation: {
      onSuccess: () => {
        invalidateAll();
        toast({
          title: "Receipt cancelled",
          description: "Stock and supplier bill have been reversed.",
        });
      },
      onError: (err) => showError(toast, err),
    },
  });

  const issues = detail?.issues ?? [];
  const issuedByComponent = useMemo(() => {
    const m = new Map<number, number>();
    for (const i of issues) {
      for (const l of i.lines) {
        m.set(
          l.componentItemId,
          (m.get(l.componentItemId) ?? 0) + Number(l.quantity),
        );
      }
    }
    return m;
  }, [issues]);

  const [downloadingIssueId, setDownloadingIssueId] = useState<number | null>(
    null,
  );
  const [downloadingOrderPdf, setDownloadingOrderPdf] = useState(false);

  if (isLoading || !detail) {
    return (
      <div className="space-y-6">
        <PageHeader title="Job work order" description="Loading..." />
      </div>
    );
  }

  const { order, components, receipts, totals } = detail;
  const isDraft = order.status === "draft";
  const isCancelled = order.status === "cancelled";
  const isCompleted = order.status === "completed";
  // Cancellation is allowed any time before completion. The backend
  // does NOT auto-reverse already-issued material — the user records
  // any pull-back as a separate stock transfer (this matches how
  // most Indian SMBs handle real-world job-work cancellations).
  const canCancel = !isCancelled && !isCompleted;
  const canIssue = !isCancelled && !isCompleted;
  const canReceive =
    !isCancelled &&
    !isCompleted &&
    (order.status === "issued" || order.status === "partially_received");
  // Rate editing mirrors the backend rule: open orders only. Already-
  // billed receipts keep their per-unit charge; only future receipts
  // pick up the new rate.
  const canEditRate = !isCancelled && !isCompleted;
  // Same rule for editing the expected return date and internal notes:
  // anything not yet completed/cancelled can be tweaked in place so
  // users can log a revised vendor commitment without cancelling.
  const canEditInfo = !isCancelled && !isCompleted;
  const hasMovedStock = order.status !== "draft";

  const downloadOrderPdf = async () => {
    setDownloadingOrderPdf(true);
    try {
      const blob = await downloadJobWorkOrderPdf(orderId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `jwo-${order.jwoNumber}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      showError(toast, err);
    } finally {
      setDownloadingOrderPdf(false);
    }
  };

  const downloadChallan = async (issue: (typeof issues)[number]) => {
    setDownloadingIssueId(issue.id);
    try {
      const blob = (await downloadJobWorkChallan(
        orderId,
        issue.id,
      )) as unknown as Blob;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `challan-${issue.issueNumber}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      showError(toast, err);
    } finally {
      setDownloadingIssueId(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Job Work ${order.jwoNumber}`}
        description={`${order.supplierName} — ${order.outputItemName}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link href="/job-work">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Link>
            </Button>
            <Button
              variant="outline"
              onClick={downloadOrderPdf}
              disabled={downloadingOrderPdf}
              data-testid="btn-print-jwo"
            >
              <Printer className="mr-2 h-4 w-4" />
              {downloadingOrderPdf ? "Preparing..." : "Download order PDF"}
            </Button>
            {canIssue && (
              <Button
                onClick={() => setIssueDialogOpen(true)}
                data-testid="btn-issue-material"
              >
                <Send className="mr-2 h-4 w-4" />
                Issue material
              </Button>
            )}
            {canReceive && (
              <Button
                size="lg"
                onClick={() => setReceiveDialogOpen(true)}
                data-testid="btn-receive-goods"
              >
                <PackageCheck className="mr-2 h-4 w-4" />
                Receive goods
              </Button>
            )}
            {canCancel && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    className="text-destructive"
                    data-testid="btn-cancel-jwo"
                  >
                    <Ban className="mr-2 h-4 w-4" />
                    Cancel
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Cancel this order?</AlertDialogTitle>
                    <AlertDialogDescription>
                      {hasMovedStock
                        ? "This marks the order cancelled. Stock already issued to the job worker stays at their location — record a stock transfer if you need to bring it back."
                        : "This marks the order cancelled. No stock has been moved yet, so nothing else will change."}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep order</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() =>
                        cancelMutation.mutate({ id: orderId })
                      }
                    >
                      Cancel order
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        }
      />

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Status
            </div>
            <div className="mt-2">
              <StatusBadge status={order.status} />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Ordered
            </div>
            <div className="mt-2 text-2xl font-semibold">
              {Number(totals.orderedQuantity)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Received
            </div>
            <div className="mt-2 text-2xl font-semibold">
              {Number(totals.receivedQuantity)}
            </div>
            <div className="text-xs text-muted-foreground">
              {Number(totals.scrappedQuantity)} scrap ·{" "}
              {Number(totals.remainingQuantity)} remaining
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Job charges
            </div>
            <div className="mt-2 text-2xl font-semibold">
              {formatCurrency(totals.totalCharges)}
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span>
                Rate {formatCurrency(order.jobChargeRate)} / unit
              </span>
              {canEditRate && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => setRateDialogOpen(true)}
                  data-testid="btn-edit-rate"
                >
                  <Pencil className="mr-1 h-3 w-3" />
                  Edit
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {supplierDetail && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Job worker details</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
            <Field
              label="Name"
              value={
                <Link
                  href={`/suppliers/${order.supplierId}`}
                  className="text-primary hover:underline"
                >
                  {supplierDetail.name}
                </Link>
              }
            />
            {supplierDetail.company && (
              <Field label="Company" value={supplierDetail.company} />
            )}
            {supplierDetail.phone && (
              <Field label="Phone" value={supplierDetail.phone} />
            )}
            {supplierDetail.email && (
              <Field label="Email" value={supplierDetail.email} />
            )}
            {supplierDetail.gstNumber && (
              <Field label="GST number" value={supplierDetail.gstNumber} />
            )}
            {supplierDetail.address && (
              <div className="sm:col-span-2 lg:col-span-3">
                <div className="text-xs uppercase text-muted-foreground tracking-wide">
                  Address
                </div>
                <div className="text-sm whitespace-pre-wrap">
                  {supplierDetail.address}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Order summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
          <Field
            label="Job worker"
            value={
              <Link
                href={`/suppliers/${order.supplierId}`}
                className="text-primary hover:underline"
              >
                {order.supplierName}
              </Link>
            }
          />
          <Field
            label="Finished item"
            value={
              <Link
                href={`/items/${order.outputItemId}`}
                className="text-primary hover:underline"
              >
                {order.outputItemName}
              </Link>
            }
          />
          <Field
            label="Source warehouse"
            value={order.sourceWarehouseName ?? "—"}
          />
          <Field
            label="Destination warehouse"
            value={order.destWarehouseName ?? "—"}
          />
          <Field
            label="Vendor warehouse"
            value={order.vendorWarehouseName ?? "—"}
          />
          <Field
            label="Expected return"
            value={
              <div className="flex items-center gap-2">
                <span>
                  {order.expectedReturnDate
                    ? formatDate(order.expectedReturnDate)
                    : "—"}
                </span>
                {canEditInfo && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => setInfoDialogOpen(true)}
                    data-testid="btn-edit-expected-return"
                  >
                    <Pencil className="mr-1 h-3 w-3" />
                    Edit
                  </Button>
                )}
              </div>
            }
          />
          <Field label="Created" value={formatDate(order.createdAt)} />
          {order.notes || canEditInfo ? (
            <div className="sm:col-span-2 lg:col-span-4">
              <div className="flex items-center gap-2">
                <div className="text-xs uppercase text-muted-foreground tracking-wide">
                  Notes
                </div>
                {canEditInfo && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => setInfoDialogOpen(true)}
                    data-testid="btn-edit-notes"
                  >
                    <Pencil className="mr-1 h-3 w-3" />
                    Edit
                  </Button>
                )}
              </div>
              <div className="text-sm whitespace-pre-wrap">
                {order.notes ?? (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Tabs defaultValue="components">
        <TabsList>
          <TabsTrigger value="components" data-testid="tab-components">
            Bill of materials
          </TabsTrigger>
          <TabsTrigger value="issues" data-testid="tab-issues">
            Material issues ({issues.length})
          </TabsTrigger>
          <TabsTrigger value="charges" data-testid="tab-charges">
            Charges
          </TabsTrigger>
          <TabsTrigger value="receipts" data-testid="tab-receipts">
            Receipts ({receipts.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="components" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Raw materials</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Component</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead className="text-right">Per unit</TableHead>
                    <TableHead className="text-right">Total needed</TableHead>
                    <TableHead className="text-right">Total issued</TableHead>
                    <TableHead className="text-right">Remaining to issue</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {components.map((c) => {
                    const issued = issuedByComponent.get(c.componentItemId) ?? 0;
                    const remaining = Math.max(0, Number(c.totalQuantity) - issued);
                    return (
                      <TableRow
                        key={c.id}
                        data-testid={`row-component-${c.id}`}
                      >
                        <TableCell>
                          <Link
                            href={`/items/${c.componentItemId}`}
                            className="hover:underline"
                          >
                            {c.componentItemName}
                          </Link>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {c.componentItemSku}
                        </TableCell>
                        <TableCell className="text-right">
                          {Number(c.quantityPerOutput)}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {Number(c.totalQuantity)}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {issued}
                        </TableCell>
                        <TableCell className={`text-right font-medium ${remaining > 0 ? "text-amber-600 dark:text-amber-400" : "text-green-600 dark:text-green-400"}`}>
                          {remaining}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="issues" className="mt-4 space-y-4">
          {issues.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                No materials issued yet.
              </CardContent>
            </Card>
          ) : (
            issues.map((issue) => (
              <Card key={issue.id} data-testid={`card-issue-${issue.id}`}>
                <CardHeader className="flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="text-base font-mono">
                      {issue.issueNumber}
                    </CardTitle>
                    <div className="text-xs text-muted-foreground mt-1">
                      {formatDate(issue.issueDate)}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => downloadChallan(issue)}
                    disabled={downloadingIssueId === issue.id}
                    data-testid={`btn-print-issue-${issue.id}`}
                  >
                    <FileDown className="mr-2 h-4 w-4" />
                    {downloadingIssueId === issue.id
                      ? "Preparing..."
                      : "Download challan"}
                  </Button>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Component</TableHead>
                        <TableHead>SKU</TableHead>
                        <TableHead className="text-right">Quantity</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {issue.lines.map((l) => (
                        <TableRow key={l.id}>
                          <TableCell>{l.componentItemName}</TableCell>
                          <TableCell className="font-mono text-xs">
                            {l.componentItemSku}
                          </TableCell>
                          <TableCell className="text-right">
                            {Number(l.quantity)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {issue.notes && (
                    <div className="mt-3 text-xs text-muted-foreground whitespace-pre-wrap">
                      {issue.notes}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        <TabsContent value="charges" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Job worker charges</CardTitle>
              <p className="text-xs text-muted-foreground">
                Per-receipt charges accrued to {detail.order.supplierName}.
                Each completed receipt at rate{" "}
                {formatCurrency(order.jobChargeRate)} / unit increases the
                supplier's outstanding payable. Use the supplier page to record
                payments.
              </p>
            </CardHeader>
            <CardContent>
              {receipts.length === 0 ? (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  No charges recorded yet.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Receipt #</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">
                        Finished qty
                      </TableHead>
                      <TableHead className="text-right">Rate / unit</TableHead>
                      <TableHead className="text-right">Charge</TableHead>
                      <TableHead>Bill</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {receipts.map((r) => {
                      const cancelled = r.status === "cancelled";
                      return (
                        <TableRow
                          key={r.id}
                          data-testid={`row-charge-${r.id}`}
                          className={cancelled ? "text-muted-foreground line-through" : undefined}
                        >
                          <TableCell className="font-mono text-xs">
                            {r.receiptNumber}
                          </TableCell>
                          <TableCell>{formatDate(r.receivedDate)}</TableCell>
                          <TableCell className="text-right">
                            {Number(r.finishedQuantity)}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">
                            {formatCurrency(order.jobChargeRate)}
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {formatCurrency(r.jobCharge)}
                          </TableCell>
                          <TableCell>
                            {cancelled ? (
                              <span className="text-xs text-muted-foreground">
                                Cancelled
                              </span>
                            ) : r.purchaseOrderId ? (
                              <Link
                                href={`/purchase-orders/${r.purchaseOrderId}`}
                                className="font-mono text-xs text-primary hover:underline"
                                data-testid={`link-bill-${r.id}`}
                              >
                                {r.purchaseOrderNumber}
                              </Link>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                —
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    <TableRow className="border-t-2">
                      <TableCell colSpan={4} className="text-right font-medium">
                        Total accrued
                      </TableCell>
                      <TableCell
                        className="text-right font-semibold"
                        data-testid="cell-total-charges"
                      >
                        {formatCurrency(
                          receipts.reduce(
                            (sum, r) =>
                              r.status === "cancelled"
                                ? sum
                                : sum + Number(r.jobCharge ?? 0),
                            0,
                          ),
                        )}
                      </TableCell>
                      <TableCell />
                    </TableRow>
                  </TableBody>
                </Table>
              )}
              <div className="mt-4 text-xs text-muted-foreground">
                <Link
                  href={`/suppliers/${detail.order.supplierId}`}
                  className="text-primary hover:underline"
                  data-testid="link-supplier-payable"
                >
                  Open {detail.order.supplierName} to view total outstanding payable and record a payment
                </Link>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="receipts" className="mt-4 space-y-4">
          {receipts.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                No goods received yet.
              </CardContent>
            </Card>
          ) : (
            receipts.map((receipt) => {
              const cancelled = receipt.status === "cancelled";
              return (
              <Card
                key={receipt.id}
                data-testid={`card-receipt-${receipt.id}`}
                className={cancelled ? "opacity-60" : undefined}
              >
                <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
                  <div>
                    <CardTitle className="text-base font-mono flex items-center gap-2">
                      {receipt.receiptNumber}
                      {cancelled && (
                        <span className="rounded bg-muted px-2 py-0.5 text-xs font-sans uppercase tracking-wide text-muted-foreground">
                          Cancelled
                        </span>
                      )}
                    </CardTitle>
                    <div className="text-xs text-muted-foreground mt-1">
                      {formatDate(receipt.receivedDate)}
                      {receipt.purchaseOrderId && !cancelled && (
                        <>
                          {" · Bill "}
                          <Link
                            href={`/purchase-orders/${receipt.purchaseOrderId}`}
                            className="text-primary hover:underline"
                            data-testid={`link-receipt-bill-${receipt.id}`}
                          >
                            {receipt.purchaseOrderNumber}
                          </Link>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-6 text-sm">
                    <div>
                      <div className="text-xs uppercase text-muted-foreground">
                        Finished
                      </div>
                      <div className="font-medium">
                        {Number(receipt.finishedQuantity)}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase text-muted-foreground">
                        Scrap
                      </div>
                      <div className="font-medium">
                        {Number(receipt.scrapQuantity)}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase text-muted-foreground">
                        Charge
                      </div>
                      <div className="font-medium">
                        {formatCurrency(receipt.jobCharge)}
                      </div>
                    </div>
                    {!cancelled && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            data-testid={`button-cancel-receipt-${receipt.id}`}
                          >
                            <Ban className="h-3.5 w-3.5 mr-1" />
                            Cancel
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              Cancel receipt {receipt.receiptNumber}?
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              Finished-goods stock will be removed from the
                              destination warehouse, components will be
                              returned to {detail.order.supplierName}'s vendor
                              warehouse, and the auto-created supplier bill
                              {receipt.purchaseOrderNumber
                                ? ` (${receipt.purchaseOrderNumber})`
                                : ""}{" "}
                              will be deleted along with its payable. Cannot
                              be undone if any payments have been allocated to
                              the bill.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Keep</AlertDialogCancel>
                            <AlertDialogAction
                              data-testid={`button-confirm-cancel-receipt-${receipt.id}`}
                              onClick={() =>
                                cancelReceiptMutation.mutate({
                                  id: orderId,
                                  receiptId: receipt.id,
                                })
                              }
                            >
                              Cancel receipt
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Component consumed</TableHead>
                        <TableHead>SKU</TableHead>
                        <TableHead className="text-right">Consumed</TableHead>
                        <TableHead className="text-right">Scrap</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {receipt.components.map((c) => (
                        <TableRow key={c.id}>
                          <TableCell>{c.componentItemName}</TableCell>
                          <TableCell className="font-mono text-xs">
                            {c.componentItemSku}
                          </TableCell>
                          <TableCell className="text-right">
                            {Number(c.quantityConsumed)}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">
                            {Number(c.scrapQuantity)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {receipt.notes && (
                    <div className="mt-3 text-xs text-muted-foreground whitespace-pre-wrap">
                      {receipt.notes}
                    </div>
                  )}
                </CardContent>
              </Card>
              );
            })
          )}
        </TabsContent>
      </Tabs>

      <IssueMaterialDialog
        open={issueDialogOpen}
        onOpenChange={setIssueDialogOpen}
        detail={detail}
        onSuccess={invalidateAll}
      />
      <ReceiveGoodsDialog
        open={receiveDialogOpen}
        onOpenChange={setReceiveDialogOpen}
        detail={detail}
        onSuccess={invalidateAll}
      />
      <EditRateDialog
        open={rateDialogOpen}
        onOpenChange={setRateDialogOpen}
        detail={detail}
        onSuccess={invalidateAll}
      />
      <EditOrderInfoDialog
        open={infoDialogOpen}
        onOpenChange={setInfoDialogOpen}
        detail={detail}
        onSuccess={invalidateAll}
      />
    </div>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs uppercase text-muted-foreground tracking-wide">
        {label}
      </div>
      <div className="text-sm">{value}</div>
    </div>
  );
}

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: JobWorkOrderDetailType;
  onSuccess: () => void;
}

function IssueMaterialDialog({
  open,
  onOpenChange,
  detail,
  onSuccess,
}: DialogProps) {
  const { toast } = useToast();
  const [issueDate, setIssueDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [notes, setNotes] = useState("");
  // Default each component to its remaining-to-issue quantity so a
  // partial issue is the easy path. Sum prior issued lines per
  // component and subtract from the BOM total.
  const issuedByComponent = useMemo(() => {
    const m = new Map<number, number>();
    for (const i of detail.issues) {
      for (const l of i.lines) {
        m.set(
          l.componentItemId,
          (m.get(l.componentItemId) ?? 0) + Number(l.quantity),
        );
      }
    }
    return m;
  }, [detail.issues]);
  const [quantities, setQuantities] = useState<Record<number, string>>({});

  // Reset defaults whenever the dialog opens or the underlying detail
  // refreshes — otherwise the state initialiser caches stale numbers
  // after a successful issue closes and reopens the dialog.
  useEffect(() => {
    if (!open) return;
    setQuantities(
      Object.fromEntries(
        detail.components.map((c) => {
          const remaining = Math.max(
            0,
            Number(c.totalQuantity) -
              (issuedByComponent.get(c.componentItemId) ?? 0),
          );
          return [c.componentItemId, remaining.toString()];
        }),
      ),
    );
    setIssueDate(new Date().toISOString().slice(0, 10));
    setNotes("");
  }, [open, detail.components, issuedByComponent]);

  const issueMutation = useIssueJobWorkMaterial({
    mutation: {
      onSuccess: () => {
        toast({ title: "Materials issued" });
        onSuccess();
        onOpenChange(false);
      },
      onError: (err) => showError(toast, err),
    },
  });

  const submit = () => {
    const lines = detail.components
      .map((c) => ({
        componentItemId: c.componentItemId,
        quantity: Number(quantities[c.componentItemId] ?? 0),
      }))
      .filter((l) => l.quantity > 0);
    if (lines.length === 0) {
      toast({
        title: "Nothing to issue",
        description: "Enter a quantity for at least one component.",
        variant: "destructive",
      });
      return;
    }
    issueMutation.mutate({
      id: detail.order.id,
      data: {
        issueDate,
        notes: notes || null,
        lines,
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Issue material to {detail.order.supplierName}</DialogTitle>
          <DialogDescription>
            Stock will move out of {detail.order.sourceWarehouseName} and into
            the worker's virtual warehouse.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Issue date</Label>
              <Input
                type="date"
                value={issueDate}
                onChange={(e) => setIssueDate(e.target.value)}
                data-testid="input-issue-date"
              />
            </div>
          </div>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Component</TableHead>
                  <TableHead className="text-right w-28">Per unit</TableHead>
                  <TableHead className="text-right w-28">BOM total</TableHead>
                  <TableHead className="text-right w-28">
                    Already issued
                  </TableHead>
                  <TableHead className="text-right w-32">Issue qty</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.components.map((c) => {
                  const issued = issuedByComponent.get(c.componentItemId) ?? 0;
                  return (
                    <TableRow
                      key={c.id}
                      data-testid={`issue-row-${c.componentItemId}`}
                    >
                      <TableCell>
                        <div>{c.componentItemName}</div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {c.componentItemSku}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {Number(c.quantityPerOutput)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {Number(c.totalQuantity)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {issued}
                      </TableCell>
                      <TableCell className="text-right">
                        <Input
                          type="number"
                          step="0.001"
                          min="0"
                          value={quantities[c.componentItemId] ?? ""}
                          onChange={(e) =>
                            setQuantities((prev) => ({
                              ...prev,
                              [c.componentItemId]: e.target.value,
                            }))
                          }
                          className="text-right"
                          data-testid={`input-issue-qty-${c.componentItemId}`}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <div className="space-y-1">
            <Label>Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Challan reference, transport details, etc."
              className="h-20"
              data-testid="input-issue-notes"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={issueMutation.isPending}
            data-testid="btn-confirm-issue"
          >
            {issueMutation.isPending ? "Issuing..." : "Issue materials"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function defaultConsumed(
  c: JobWorkOrderComponent,
  finishedQty: number,
): string {
  return (Number(c.quantityPerOutput) * (Number(finishedQty) || 0)).toString();
}

function EditRateDialog({
  open,
  onOpenChange,
  detail,
  onSuccess,
}: DialogProps) {
  const { toast } = useToast();
  const currentRate = Number(detail.order.jobChargeRate ?? 0);
  const [rate, setRate] = useState<string>(currentRate.toString());

  // Reset the input each time the dialog opens so reopening after a
  // rate change shows the latest committed value, not stale state.
  useEffect(() => {
    if (open) setRate(currentRate.toString());
  }, [open, currentRate]);

  const updateMutation = useUpdateJobWorkOrder({
    mutation: {
      onSuccess: () => {
        toast({
          title: "Rate updated",
          description:
            "Future receipts will use the new rate. Existing receipts and bills are unchanged.",
        });
        onSuccess();
        onOpenChange(false);
      },
      onError: (err) => showError(toast, err),
    },
  });

  const submit = () => {
    const value = Number(rate);
    if (!Number.isFinite(value) || value < 0) {
      toast({
        title: "Invalid rate",
        description: "Enter a non-negative number.",
        variant: "destructive",
      });
      return;
    }
    updateMutation.mutate({
      id: detail.order.id,
      data: { jobChargeRate: value },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit per-unit job charge</DialogTitle>
          <DialogDescription>
            Updates the rate used for new receipts on{" "}
            {detail.order.jwoNumber}. Existing receipts and their bills
            keep the rate they were recorded with.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Rate per unit (₹)</Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              data-testid="input-edit-rate"
            />
            <p className="text-xs text-muted-foreground">
              Current rate: {formatCurrency(currentRate)} / unit
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={updateMutation.isPending}
            data-testid="btn-confirm-edit-rate"
          >
            {updateMutation.isPending ? "Saving..." : "Save rate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditOrderInfoDialog({
  open,
  onOpenChange,
  detail,
  onSuccess,
}: DialogProps) {
  const { toast } = useToast();
  const currentDate = detail.order.expectedReturnDate ?? "";
  const currentNotes = detail.order.notes ?? "";
  const [expectedReturnDate, setExpectedReturnDate] = useState(currentDate);
  const [notes, setNotes] = useState(currentNotes);

  // Refresh defaults each time the dialog opens so the inputs reflect
  // the latest committed values rather than stale local state.
  useEffect(() => {
    if (open) {
      setExpectedReturnDate(currentDate);
      setNotes(currentNotes);
    }
  }, [open, currentDate, currentNotes]);

  const updateMutation = useUpdateJobWorkOrder({
    mutation: {
      onSuccess: () => {
        toast({ title: "Order updated" });
        onSuccess();
        onOpenChange(false);
      },
      onError: (err) => showError(toast, err),
    },
  });

  const submit = () => {
    updateMutation.mutate({
      id: detail.order.id,
      data: {
        expectedReturnDate: expectedReturnDate ? expectedReturnDate : null,
        notes: notes.trim() ? notes : null,
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit order details</DialogTitle>
          <DialogDescription>
            Update the expected return date or internal notes for{" "}
            {detail.order.jwoNumber}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Expected return</Label>
            <Input
              type="date"
              value={expectedReturnDate}
              onChange={(e) => setExpectedReturnDate(e.target.value)}
              data-testid="input-edit-expected-return"
            />
          </div>
          <div className="space-y-1">
            <Label>Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Follow-up reminders, vendor commitments, etc."
              className="h-24"
              data-testid="input-edit-notes"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={updateMutation.isPending}
            data-testid="btn-confirm-edit-info"
          >
            {updateMutation.isPending ? "Saving..." : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReceiveGoodsDialog({
  open,
  onOpenChange,
  detail,
  onSuccess,
}: DialogProps) {
  const { toast } = useToast();
  const remaining = Math.max(0, Number(detail.totals.remainingQuantity));
  const [receivedDate, setReceivedDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [finishedQty, setFinishedQty] = useState<string>(remaining.toString());
  const [scrapQty, setScrapQty] = useState<string>("0");
  const [jobCharge, setJobCharge] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [components, setComponents] = useState<Record<number, string>>({});
  const [componentScrap, setComponentScrap] = useState<Record<number, string>>(
    {},
  );

  useEffect(() => {
    if (!open) return;
    const freshRemaining = Math.max(0, Number(detail.totals.remainingQuantity));
    setFinishedQty(freshRemaining.toString());
    setScrapQty("0");
    setJobCharge("");
    setNotes("");
    setComponents({});
    setComponentScrap({});
    setReceivedDate(new Date().toISOString().slice(0, 10));
  }, [open, detail.totals.remainingQuantity]);

  const finishedNum = Number(finishedQty) || 0;
  const defaultCharge = useMemo(
    () => finishedNum * Number(detail.order.jobChargeRate ?? 0),
    [finishedNum, detail.order.jobChargeRate],
  );

  const receiveMutation = useReceiveJobWorkOutput({
    mutation: {
      onSuccess: () => {
        toast({ title: "Goods received" });
        onSuccess();
        onOpenChange(false);
      },
      onError: (err) => showError(toast, err),
    },
  });

  const submit = () => {
    if (finishedNum <= 0 && Number(scrapQty) <= 0) {
      toast({
        title: "Enter quantities",
        description: "Either finished or scrap quantity must be positive.",
        variant: "destructive",
      });
      return;
    }
    const componentPayload = detail.components.map((c) => ({
      componentItemId: c.componentItemId,
      quantityConsumed: Number(
        components[c.componentItemId] ?? defaultConsumed(c, finishedNum),
      ),
      scrapQuantity: Number(componentScrap[c.componentItemId] ?? 0),
    }));
    receiveMutation.mutate({
      id: detail.order.id,
      data: {
        receivedDate,
        finishedQuantity: finishedNum,
        scrapQuantity: Number(scrapQty) || 0,
        jobCharge: jobCharge === "" ? null : Number(jobCharge),
        notes: notes || null,
        components: componentPayload,
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Receive goods from {detail.order.supplierName}
          </DialogTitle>
          <DialogDescription>
            Finished goods land in {detail.order.destWarehouseName}. Component
            stock at the worker is consumed automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="space-y-1">
              <Label>Received date</Label>
              <Input
                type="date"
                value={receivedDate}
                onChange={(e) => setReceivedDate(e.target.value)}
                data-testid="input-received-date"
              />
            </div>
            <div className="space-y-1">
              <Label>Finished qty</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={finishedQty}
                onChange={(e) => setFinishedQty(e.target.value)}
                data-testid="input-finished-qty"
              />
            </div>
            <div className="space-y-1">
              <Label>Scrap qty</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={scrapQty}
                onChange={(e) => setScrapQty(e.target.value)}
                data-testid="input-scrap-qty"
              />
            </div>
            <div className="space-y-1">
              <Label>Job charge (₹)</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={jobCharge}
                onChange={(e) => setJobCharge(e.target.value)}
                placeholder={defaultCharge.toFixed(2)}
                data-testid="input-job-charge"
              />
            </div>
          </div>

          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Component consumed at worker</TableHead>
                  <TableHead className="text-right w-32">
                    Default (BOM)
                  </TableHead>
                  <TableHead className="text-right w-32">
                    Actual consumed
                  </TableHead>
                  <TableHead className="text-right w-32">Scrap</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.components.map((c) => (
                  <TableRow
                    key={c.id}
                    data-testid={`receive-row-${c.componentItemId}`}
                  >
                    <TableCell>
                      <div>{c.componentItemName}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {c.componentItemSku}
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {defaultConsumed(c, finishedNum)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        type="number"
                        step="0.001"
                        min="0"
                        value={
                          components[c.componentItemId] ??
                          defaultConsumed(c, finishedNum)
                        }
                        onChange={(e) =>
                          setComponents((prev) => ({
                            ...prev,
                            [c.componentItemId]: e.target.value,
                          }))
                        }
                        className="text-right"
                        data-testid={`input-consumed-${c.componentItemId}`}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        type="number"
                        step="0.001"
                        min="0"
                        value={componentScrap[c.componentItemId] ?? "0"}
                        onChange={(e) =>
                          setComponentScrap((prev) => ({
                            ...prev,
                            [c.componentItemId]: e.target.value,
                          }))
                        }
                        className="text-right"
                        data-testid={`input-comp-scrap-${c.componentItemId}`}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="space-y-1">
            <Label>Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Quality notes, batch details, etc."
              className="h-20"
              data-testid="input-receive-notes"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={receiveMutation.isPending}
            data-testid="btn-confirm-receive"
          >
            {receiveMutation.isPending ? "Saving..." : "Receive goods"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
