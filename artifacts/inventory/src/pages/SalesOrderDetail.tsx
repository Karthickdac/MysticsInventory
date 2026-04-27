import { useParams, Link } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import {
  useGetSalesOrder,
  useUpdateSalesOrderStatus,
  useReturnSalesOrder,
  useCancelShipment,
  useListStockMovements,
  getGetSalesOrderQueryKey,
  getListStockMovementsQueryKey,
  getListSalesOrderShipmentsQueryKey,
  getListItemsQueryKey,
} from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatDate } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, CheckCircle2, Truck, Package, XCircle, Undo2, IndianRupee } from "lucide-react";
import { useState } from "react";
import { RecordPaymentDialog } from "@/components/RecordPaymentDialog";
import { NewShipmentDialog } from "@/components/NewShipmentDialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { StatusBadge } from "@/components/StatusBadge";
import { Separator } from "@/components/ui/separator";
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

const PAYABLE_SALES_STATUSES = ["confirmed", "shipped", "delivered", "invoiced"];

const RETURNABLE_SALES_STATUSES = ["shipped", "delivered", "invoiced", "paid"];

export default function SalesOrderDetail() {
  const { id } = useParams();
  const orderId = parseInt(id || "0", 10);
  
  const { data: orderDetail, isLoading } = useGetSalesOrder(orderId, {
    query: { enabled: !!orderId, queryKey: getGetSalesOrderQueryKey(orderId) }
  });

  useRecordVisit(
    useMemo(
      () =>
        orderDetail?.order
          ? {
              kind: "sales_order" as const,
              id: orderDetail.order.id,
              title: orderDetail.order.orderNumber,
              subtitle: orderDetail.order.customerName,
              href: `/sales-orders/${orderDetail.order.id}`,
            }
          : null,
      [orderDetail?.order],
    ),
  );

  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const movementsQuery = useListStockMovements(
    { salesOrderId: orderId },
    {
      query: {
        enabled: !!orderId,
        queryKey: getListStockMovementsQueryKey({
          salesOrderId: orderId,
        }),
      },
    },
  );

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: getGetSalesOrderQueryKey(orderId) });
    queryClient.invalidateQueries({
      queryKey: getListStockMovementsQueryKey({ salesOrderId: orderId }),
    });
    queryClient.invalidateQueries({ queryKey: getListStockMovementsQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getListSalesOrderShipmentsQueryKey(orderId),
    });
    queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
  };

  const updateStatusMutation = useUpdateSalesOrderStatus({
    mutation: {
      onSuccess: () => {
        invalidateAll();
        toast({ title: "Status updated successfully" });
      },
    },
  });

  const returnMutation = useReturnSalesOrder({
    mutation: {
      onSuccess: () => {
        invalidateAll();
        toast({ title: "Return processed", description: "Stock has been added back to the warehouse." });
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

  const cancelShipmentMutation = useCancelShipment({
    mutation: {
      onSuccess: () => {
        invalidateAll();
        toast({ title: "Shipment cancelled", description: "Stock has been added back to the warehouse." });
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        toast({
          title: "Could not cancel shipment",
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

  const [paymentOpen, setPaymentOpen] = useState(false);
  const [shipmentOpen, setShipmentOpen] = useState(false);

  if (isLoading || !orderDetail) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-32" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const { order, lines, shipments } = orderDetail;
  const canShip = order.status === "confirmed" || order.status === "partially_shipped";
  const canCancelShipments = order.status === "shipped" || order.status === "partially_shipped";
  const allFullyShipped = lines.every(
    (l) => Number(l.quantity) - Number(l.quantityShipped) <= 1e-6,
  );

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/sales-orders">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <PageHeader 
          title={`Order ${order.orderNumber}`} 
          className="mb-0"
          actions={<StatusBadge status={order.status} className="ml-4" />}
        />
      </div>

      <div className="flex flex-wrap gap-3">
        {order.status === "draft" && (
          <Button 
            onClick={() => handleUpdateStatus("confirmed")} 
            disabled={updateStatusMutation.isPending}
            data-testid="btn-status-confirm"
          >
            <CheckCircle2 className="mr-2 h-4 w-4" /> Confirm Order
          </Button>
        )}
        {canShip && !allFullyShipped && (
          <Button
            onClick={() => setShipmentOpen(true)}
            data-testid="btn-new-shipment"
          >
            <Truck className="mr-2 h-4 w-4" /> New shipment
          </Button>
        )}
        {order.status === "shipped" && (
          <Button 
            onClick={() => handleUpdateStatus("delivered")} 
            disabled={updateStatusMutation.isPending}
            data-testid="btn-status-deliver"
          >
            <Package className="mr-2 h-4 w-4" /> Mark as Delivered
          </Button>
        )}
        {["draft", "confirmed"].includes(order.status) && (
          <Button 
            variant="destructive"
            onClick={() => handleUpdateStatus("cancelled")} 
            disabled={updateStatusMutation.isPending}
            data-testid="btn-status-cancel"
          >
            <XCircle className="mr-2 h-4 w-4" /> Cancel Order
          </Button>
        )}
        {Number(order.balanceDue) > 0 &&
          PAYABLE_SALES_STATUSES.includes(order.status) && (
            <Button
              variant="outline"
              onClick={() => setPaymentOpen(true)}
              data-testid="btn-record-payment"
            >
              <IndianRupee className="mr-2 h-4 w-4" /> Record payment
            </Button>
          )}
        {RETURNABLE_SALES_STATUSES.includes(order.status) && (
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
                <AlertDialogTitle>Return this shipment?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will add the order quantities back to {order.warehouseName} and mark the order as returned. The original shipment record will be kept for audit.
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
                <p className="text-sm font-medium text-muted-foreground">Expected Ship Date</p>
                <p>{formatDate(order.expectedShipDate) || "-"}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Warehouse</p>
                <p>{order.warehouseName}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Customer</p>
                <Link href="/customers" className="text-primary hover:underline">{order.customerName}</Link>
              </div>
            </div>
            {order.notes && (
              <div className="pt-4 border-t">
                <p className="text-sm font-medium text-muted-foreground mb-1">Notes</p>
                <p className="text-sm">{order.notes}</p>
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
              <span data-testid="text-amount-paid">
                {formatCurrency(order.amountPaid)}
              </span>
            </div>
            <div className="flex justify-between text-sm font-medium">
              <span>Balance due</span>
              <span
                className={
                  Number(order.balanceDue) > 0 ? "text-orange-600" : ""
                }
                data-testid="text-balance-due"
              >
                {formatCurrency(order.balanceDue)}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      <RecordPaymentDialog
        open={paymentOpen}
        onOpenChange={setPaymentOpen}
        customerId={order.customerId}
        customerName={order.customerName}
        presetSalesOrderId={order.id}
        presetSalesOrderBalance={Number(order.balanceDue)}
      />

      <NewShipmentDialog
        open={shipmentOpen}
        onOpenChange={setShipmentOpen}
        salesOrderId={order.id}
        warehouseId={order.warehouseId}
        lines={lines.map((l) => ({
          id: l.id,
          itemId: l.itemId,
          itemName: l.itemName,
          sku: l.sku,
          quantity: Number(l.quantity),
          quantityShipped: Number(l.quantityShipped),
          trackBatches: !!l.trackBatches,
        }))}
      />

      <Card>
        <CardHeader>
          <CardTitle>Line Items</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Shipped</TableHead>
                <TableHead className="text-right">Unit Price</TableHead>
                <TableHead className="text-right">Tax</TableHead>
                <TableHead className="text-right">Line Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line) => {
                const ordered = Number(line.quantity);
                const shipped = Number(line.quantityShipped);
                const remaining = Math.max(0, ordered - shipped);
                return (
                  <TableRow key={line.id}>
                    <TableCell>
                      <div className="font-medium">{line.itemName}</div>
                      <div className="text-xs text-muted-foreground">{line.sku}</div>
                      {line.description && <div className="text-xs text-muted-foreground mt-1">{line.description}</div>}
                    </TableCell>
                    <TableCell className="text-right">{ordered}</TableCell>
                    <TableCell className="text-right">
                      <span
                        className={
                          shipped > 0 && shipped < ordered
                            ? "text-blue-600 dark:text-blue-400"
                            : ""
                        }
                        data-testid={`text-shipped-${line.id}`}
                      >
                        {shipped}
                      </span>
                      {remaining > 0 && shipped > 0 && (
                        <span className="text-xs text-muted-foreground ml-1">
                          ({remaining} pending)
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{formatCurrency(line.unitPrice)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(line.lineTax)} <span className="text-xs text-muted-foreground">({line.taxRate}%)</span></TableCell>
                    <TableCell className="text-right font-medium">{formatCurrency(line.lineTotal)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card data-testid="card-shipments">
        <CardHeader>
          <CardTitle>Shipments</CardTitle>
        </CardHeader>
        <CardContent>
          {shipments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No shipments yet. Use "New shipment" to record what you've sent out.
            </p>
          ) : (
            <div className="space-y-4">
              {shipments.map((s) => (
                <div
                  key={s.id}
                  className="border rounded-md p-4 space-y-3"
                  data-testid={`shipment-${s.id}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-medium">{s.shipmentNumber}</div>
                      <div className="text-xs text-muted-foreground">
                        Shipped {formatDate(s.shipDate)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={s.status} />
                      {s.status !== "cancelled" && canCancelShipments && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={cancelShipmentMutation.isPending}
                              data-testid={`btn-cancel-shipment-${s.id}`}
                            >
                              Cancel shipment
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Cancel this shipment?</AlertDialogTitle>
                              <AlertDialogDescription>
                                Stock will be added back to {order.warehouseName} and the line quantities will be available to ship again.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Keep shipment</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() =>
                                  cancelShipmentMutation.mutate({
                                    shipmentId: s.id,
                                  })
                                }
                                data-testid={`btn-confirm-cancel-shipment-${s.id}`}
                              >
                                Cancel shipment
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </div>
                  </div>
                  {s.notes && (
                    <p className="text-sm text-muted-foreground">{s.notes}</p>
                  )}
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item</TableHead>
                        <TableHead className="text-right">Quantity</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {s.lines.map((sl) => (
                        <TableRow key={sl.id}>
                          <TableCell>
                            <div className="font-medium">{sl.itemName}</div>
                            <div className="text-xs text-muted-foreground">{sl.sku}</div>
                          </TableCell>
                          <TableCell className="text-right">{sl.quantity}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

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
                  const isReturn = m.movementType === "sales_return";
                  return (
                    <TableRow key={m.id}>
                      <TableCell>{formatDate(m.createdAt)}</TableCell>
                      <TableCell>
                        <span
                          className={
                            isReturn
                              ? "text-green-600 dark:text-green-400"
                              : "text-muted-foreground"
                          }
                        >
                          {isReturn ? "Return" : "Sale"}
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
              No stock movements yet. They will appear here once the order ships.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
