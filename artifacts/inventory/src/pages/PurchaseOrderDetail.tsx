import { useParams, Link } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import {
  useGetPurchaseOrder,
  useGetSupplier,
  getGetSupplierQueryKey,
  useUpdatePurchaseOrderStatus,
  useReturnPurchaseOrder,
  useCancelGoodsReceipt,
  useListStockMovements,
  getGetPurchaseOrderQueryKey,
  getListPurchaseOrderGoodsReceiptsQueryKey,
  getListStockMovementsQueryKey,
  getListItemsQueryKey,
} from "@/lib/queryKeys";
import { downloadPurchaseOrderPdf } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatDate } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, CheckCircle2, PackagePlus, XCircle, Undo2, IndianRupee, FileDown, Building2 } from "lucide-react";
import { useState, type ReactElement } from "react";
import { RecordSupplierPaymentDialog } from "@/components/RecordSupplierPaymentDialog";
import { NewGoodsReceiptDialog } from "@/components/NewGoodsReceiptDialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { StatusBadge } from "@/components/StatusBadge";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import { useMemo } from "react";
import { useRecordVisit } from "@/lib/recentRecords";

const RETURNABLE_PURCHASE_STATUSES = ["received", "billed", "paid"];
const PAYABLE_PURCHASE_STATUSES = ["ordered", "partially_received", "received", "billed"];
const RECEIVABLE_PURCHASE_STATUSES = ["ordered", "partially_received"];
const CANCELLABLE_PURCHASE_STATUSES = ["draft", "ordered"];

export default function PurchaseOrderDetail() {
  const { id } = useParams();
  const orderId = parseInt(id || "0", 10);
  
  const { data: orderDetail, isLoading } = useGetPurchaseOrder(orderId, {
    query: { enabled: !!orderId, queryKey: getGetPurchaseOrderQueryKey(orderId) }
  });

  // Fetch supplier details separately so we can show the info panel.
  // Only enabled once the PO is loaded and we have a supplierId.
  const supplierId = orderDetail?.order.supplierId ?? 0;
  const { data: supplierDetail } = useGetSupplier(supplierId, {
    query: { enabled: !!supplierId, queryKey: getGetSupplierQueryKey(supplierId) },
  });

  useRecordVisit(
    useMemo(
      () =>
        orderDetail?.order
          ? {
              kind: "purchase_order" as const,
              id: orderDetail.order.id,
              title: orderDetail.order.orderNumber,
              subtitle: orderDetail.order.supplierName,
              href: `/purchase-orders/${orderDetail.order.id}`,
            }
          : null,
      [orderDetail?.order],
    ),
  );

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [receiptDialogOpen, setReceiptDialogOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const handleDownloadPdf = async () => {
    if (!orderDetail) return;
    setDownloading(true);
    try {
      const blob = (await downloadPurchaseOrderPdf(
        orderId,
      )) as unknown as Blob;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `purchase-order-${orderDetail.order.orderNumber}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      toast({
        title: "Could not download purchase order",
        description:
          e.response?.data?.error ?? "Please try again in a moment.",
        variant: "destructive",
      });
    } finally {
      setDownloading(false);
    }
  };
  
  const movementsQuery = useListStockMovements(
    { purchaseOrderId: orderId },
    {
      query: {
        enabled: !!orderId,
        queryKey: getListStockMovementsQueryKey({
          purchaseOrderId: orderId,
        }),
      },
    },
  );

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: getGetPurchaseOrderQueryKey(orderId) });
    queryClient.invalidateQueries({
      queryKey: getListPurchaseOrderGoodsReceiptsQueryKey(orderId),
    });
    queryClient.invalidateQueries({
      queryKey: getListStockMovementsQueryKey({ purchaseOrderId: orderId }),
    });
    queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
  };

  const updateStatusMutation = useUpdatePurchaseOrderStatus({
    mutation: {
      onSuccess: () => {
        invalidateAll();
        toast({ title: "Status updated successfully" });
      },
    },
  });

  const returnMutation = useReturnPurchaseOrder({
    mutation: {
      onSuccess: () => {
        invalidateAll();
        toast({ title: "Return processed", description: "Stock has been removed from the warehouse." });
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        toast({
          title: "Could not process return",
          description: e.response?.data?.error ?? "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  const cancelReceiptMutation = useCancelGoodsReceipt({
    mutation: {
      onSuccess: () => {
        invalidateAll();
        toast({ title: "Receipt cancelled", description: "Stock has been reversed." });
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        toast({
          title: "Could not cancel receipt",
          description: e.response?.data?.error ?? "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  const handleUpdateStatus = (status: string) => {
    updateStatusMutation.mutate({
      id: orderId,
      data: { status },
    });
  };

  const handleReturn = () => {
    returnMutation.mutate({ id: orderId, data: { notes: null } });
  };

  if (isLoading || !orderDetail) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-32" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const { order, lines, goodsReceipts } = orderDetail;
  // Auto-bills generated from a job-work receipt are owned by that
  // receipt — manual status changes / returns / new receipts are
  // disabled, and the only way to void the bill is to cancel the
  // originating receipt.
  const isJobWorkBill = order.jobWorkReceiptId != null;
  const jwoLockMessage =
    "Locked because this bill was auto-created from a job-work receipt. Cancel the receipt on the job-work order to void it.";

  const wrapJwoLock = (node: ReactElement) =>
    isJobWorkBill ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex">
            {node}
          </span>
        </TooltipTrigger>
        <TooltipContent>{jwoLockMessage}</TooltipContent>
      </Tooltip>
    ) : (
      node
    );

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/purchase-orders">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <PageHeader 
          title={`Purchase Order ${order.orderNumber}`} 
          className="mb-0"
          actions={<StatusBadge status={order.status} className="ml-4" />}
        />
      </div>

      {isJobWorkBill && order.jobWorkOrderId && (
        <Card data-testid="card-jwo-source">
          <CardContent className="py-4 text-sm">
            Auto-created from job-work receipt for{" "}
            <Link
              href={`/job-work-orders/${order.jobWorkOrderId}`}
              className="text-primary hover:underline"
              data-testid="link-jwo-source"
            >
              {order.jwoNumber}
            </Link>
            . To void this bill, cancel the receipt from the job-work order.
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          onClick={handleDownloadPdf}
          disabled={downloading}
          data-testid="btn-download-po"
        >
          <FileDown className="mr-2 h-4 w-4" />
          {downloading ? "Preparing..." : "Download PDF"}
        </Button>
        {order.status === "draft" && wrapJwoLock(
          <Button 
            onClick={() => handleUpdateStatus("ordered")} 
            disabled={updateStatusMutation.isPending || isJobWorkBill}
            data-testid="btn-status-confirm"
          >
            <CheckCircle2 className="mr-2 h-4 w-4" /> Confirm Order
          </Button>
        )}
        {RECEIVABLE_PURCHASE_STATUSES.includes(order.status) && wrapJwoLock(
          <Button
            onClick={() => setReceiptDialogOpen(true)}
            disabled={isJobWorkBill}
            data-testid="btn-new-receipt"
          >
            <PackagePlus className="mr-2 h-4 w-4" /> New receipt
          </Button>
        )}
        {CANCELLABLE_PURCHASE_STATUSES.includes(order.status) && wrapJwoLock(
          <Button 
            variant="destructive"
            onClick={() => handleUpdateStatus("cancelled")} 
            disabled={updateStatusMutation.isPending || isJobWorkBill}
            data-testid="btn-status-cancel"
          >
            <XCircle className="mr-2 h-4 w-4" /> Cancel Order
          </Button>
        )}
        {PAYABLE_PURCHASE_STATUSES.includes(order.status) && Number(order.balanceDue ?? 0) > 0 && (
          <Button
            variant="outline"
            onClick={() => setPaymentDialogOpen(true)}
            data-testid="btn-record-payment-po"
          >
            <IndianRupee className="mr-2 h-4 w-4" /> Record payment
          </Button>
        )}
        {RETURNABLE_PURCHASE_STATUSES.includes(order.status) && isJobWorkBill && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="inline-flex">
                <Button
                  variant="outline"
                  disabled
                  data-testid="btn-status-return"
                >
                  <Undo2 className="mr-2 h-4 w-4" /> Return / Reverse
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{jwoLockMessage}</TooltipContent>
          </Tooltip>
        )}
        {RETURNABLE_PURCHASE_STATUSES.includes(order.status) && !isJobWorkBill && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                disabled={returnMutation.isPending}
                data-testid="btn-status-return"
              >
                <Undo2 className="mr-2 h-4 w-4" /> Return / Reverse
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Return this delivery?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will remove the order quantities from {order.warehouseName} and mark the order as returned. The original receipt record will be kept for audit.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleReturn}
                  data-testid="btn-confirm-return"
                >
                  Confirm Return
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Order Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-y-4 gap-x-8">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Order Date</p>
                <p>{formatDate(order.orderDate)}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Expected Delivery</p>
                <p>{formatDate(order.expectedDeliveryDate) || "-"}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Warehouse</p>
                <p>{order.warehouseName}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Supplier</p>
                <Link href={`/suppliers/${order.supplierId}`} className="text-primary hover:underline">{order.supplierName}</Link>
              </div>
            </div>
            {order.notes && (
              <div className="pt-4 border-t">
                <p className="text-sm font-medium text-muted-foreground mb-1">Notes</p>
                <p className="text-sm">{order.notes}</p>
              </div>
            )}
            {/* Supplier details panel */}
            {supplierDetail && (
              <div
                className="pt-4 border-t space-y-2"
                data-testid="card-supplier-info"
              >
                <p className="text-sm font-medium flex items-center gap-1.5">
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  Supplier Details
                </p>
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  {supplierDetail.company && (
                    <div>
                      <p className="text-xs text-muted-foreground">Company</p>
                      <p>{supplierDetail.company}</p>
                    </div>
                  )}
                  {supplierDetail.phone && (
                    <div>
                      <p className="text-xs text-muted-foreground">Phone</p>
                      <p>{supplierDetail.phone}</p>
                    </div>
                  )}
                  {supplierDetail.email && (
                    <div>
                      <p className="text-xs text-muted-foreground">Email</p>
                      <p>{supplierDetail.email}</p>
                    </div>
                  )}
                  {supplierDetail.gstNumber && (
                    <div>
                      <p className="text-xs text-muted-foreground">GST Number</p>
                      <p className="font-mono">{supplierDetail.gstNumber}</p>
                    </div>
                  )}
                  {supplierDetail.address && (
                    <div className="col-span-2">
                      <p className="text-xs text-muted-foreground">Address</p>
                      <p className="whitespace-pre-line">{supplierDetail.address}</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span>{formatCurrency(order.subtotal)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Tax</span>
              <span>{formatCurrency(order.taxTotal)}</span>
            </div>
            <Separator />
            <div className="flex justify-between font-bold text-lg">
              <span>Total</span>
              <span>{formatCurrency(order.total)}</span>
            </div>
            <Separator />
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Amount paid</span>
              <span data-testid="text-po-amount-paid">{formatCurrency(Number(order.amountPaid ?? 0))}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Balance due</span>
              <span
                className={Number(order.balanceDue ?? 0) > 0 ? "text-orange-600 font-medium" : ""}
                data-testid="text-po-balance-due"
              >
                {formatCurrency(Number(order.balanceDue ?? 0))}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Line Items</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">Unit Cost</TableHead>
                <TableHead className="text-right">Discount</TableHead>
                <TableHead className="text-right">Tax</TableHead>
                <TableHead className="text-right">Line Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line) => {
                const discAmt = Number(line.discountAmount ?? 0);
                const discPct = Number(line.discountPercent ?? 0);
                return (
                <TableRow key={line.id}>
                  <TableCell>
                    <div className="font-medium">{line.itemName}</div>
                    {line.description && <div className="text-xs text-muted-foreground mt-1">{line.description}</div>}
                  </TableCell>
                  <TableCell className="font-mono text-sm text-muted-foreground">
                    {line.sku}
                  </TableCell>
                  <TableCell className="text-right">{line.quantity}</TableCell>
                  <TableCell className="text-right" data-testid={`text-line-received-${line.id}`}>
                    {line.quantityReceived}
                  </TableCell>
                  <TableCell className="text-right">{formatCurrency(line.unitPrice)}</TableCell>
                  <TableCell className="text-right">
                    {discAmt > 0 ? (
                      <span className="text-green-600 dark:text-green-400">
                        -{formatCurrency(discAmt)}
                        {discPct > 0 && <span className="text-xs text-muted-foreground ml-1">({discPct}%)</span>}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{formatCurrency(line.lineTax)} <span className="text-xs text-muted-foreground">({line.taxRate}%)</span></TableCell>
                  <TableCell className="text-right font-medium">{formatCurrency(line.lineTotal)}</TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {goodsReceipts.length > 0 && (
        <Card data-testid="card-goods-receipts">
          <CardHeader>
            <CardTitle>Receipts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {goodsReceipts.map((receipt) => {
              const isCancelled = receipt.status === "cancelled";
              const totalUnits = receipt.lines.reduce(
                (s, l) => s + Number(l.quantity || 0),
                0,
              );
              return (
                <div
                  key={receipt.id}
                  className="border rounded-md p-4 space-y-3"
                  data-testid={`receipt-${receipt.id}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{receipt.receiptNumber}</span>
                        <StatusBadge status={receipt.status} />
                      </div>
                      <div className="text-sm text-muted-foreground">
                        Received {formatDate(receipt.receivedDate)} · {totalUnits} units
                      </div>
                      {receipt.notes && (
                        <div className="text-sm text-muted-foreground">
                          {receipt.notes}
                        </div>
                      )}
                    </div>
                    {!isCancelled && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={cancelReceiptMutation.isPending}
                            data-testid={`btn-cancel-receipt-${receipt.id}`}
                          >
                            <Undo2 className="mr-2 h-4 w-4" /> Cancel receipt
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Cancel this receipt?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will reverse the stock added to {order.warehouseName} for this receipt. The receipt record will be kept for audit.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Keep receipt</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() =>
                                cancelReceiptMutation.mutate({
                                  goodsReceiptId: receipt.id,
                                })
                              }
                              data-testid={`btn-confirm-cancel-receipt-${receipt.id}`}
                            >
                              Cancel receipt
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item</TableHead>
                        <TableHead className="text-right">Quantity</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {receipt.lines.map((rl) => (
                        <TableRow key={rl.id}>
                          <TableCell>
                            <div className="font-medium">{rl.itemName}</div>
                            <div className="text-xs text-muted-foreground">{rl.sku}</div>
                          </TableCell>
                          <TableCell className="text-right">{rl.quantity}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <Card data-testid="card-stock-history">
        <CardHeader>
          <CardTitle>Stock History</CardTitle>
        </CardHeader>
        <CardContent>
          {movementsQuery.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : movementsQuery.data && movementsQuery.data.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {movementsQuery.data.map((m) => {
                  const qty = Number(m.quantity);
                  const isReturn = m.movementType === "purchase_return";
                  return (
                    <TableRow key={m.id}>
                      <TableCell>{formatDate(m.createdAt)}</TableCell>
                      <TableCell>
                        <span
                          className={
                            isReturn
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-muted-foreground"
                          }
                        >
                          {isReturn ? "Return" : "Receipt"}
                        </span>
                      </TableCell>
                      <TableCell>{m.itemName}</TableCell>
                      <TableCell className="text-right font-medium">
                        {qty > 0 ? `+${qty}` : qty}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {m.notes || "-"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">
              No stock movements yet. They will appear here once the order is received.
            </p>
          )}
        </CardContent>
      </Card>

      <NewGoodsReceiptDialog
        open={receiptDialogOpen}
        onOpenChange={setReceiptDialogOpen}
        purchaseOrderId={order.id}
        lines={lines}
      />

      {paymentDialogOpen && (
        <RecordSupplierPaymentDialog
          open={paymentDialogOpen}
          onOpenChange={setPaymentDialogOpen}
          supplierId={order.supplierId}
          supplierName={order.supplierName}
          presetPurchaseOrderId={order.id}
          presetPurchaseOrderBalance={Number(order.balanceDue ?? 0)}
        />
      )}
    </div>
  );
}
