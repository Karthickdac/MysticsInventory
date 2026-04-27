import { useParams, Link } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import {
  useGetSalesOrder,
  useUpdateSalesOrderStatus,
  useReturnSalesOrder,
  useListStockMovements,
  getGetSalesOrderQueryKey,
  getListStockMovementsQueryKey,
} from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatDate } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, CheckCircle2, Truck, Package, XCircle, Undo2 } from "lucide-react";
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
    { referenceType: "sales_order", referenceId: orderId },
    {
      query: {
        enabled: !!orderId,
        queryKey: getListStockMovementsQueryKey({
          referenceType: "sales_order",
          referenceId: orderId,
        }),
      },
    },
  );

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: getGetSalesOrderQueryKey(orderId) });
    queryClient.invalidateQueries({
      queryKey: getListStockMovementsQueryKey({
        referenceType: "sales_order",
        referenceId: orderId,
      }),
    });
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

  const { order, lines } = orderDetail;

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
        {order.status === "confirmed" && (
          <Button 
            onClick={() => handleUpdateStatus("shipped")} 
            disabled={updateStatusMutation.isPending}
            data-testid="btn-status-ship"
          >
            <Truck className="mr-2 h-4 w-4" /> Mark as Shipped
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
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit Price</TableHead>
                <TableHead className="text-right">Tax</TableHead>
                <TableHead className="text-right">Line Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell>
                    <div className="font-medium">{line.itemName}</div>
                    <div className="text-xs text-muted-foreground">{line.sku}</div>
                    {line.description && <div className="text-xs text-muted-foreground mt-1">{line.description}</div>}
                  </TableCell>
                  <TableCell className="text-right">{line.quantity}</TableCell>
                  <TableCell className="text-right">{formatCurrency(line.unitPrice)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(line.lineTax)} <span className="text-xs text-muted-foreground">({line.taxRate}%)</span></TableCell>
                  <TableCell className="text-right font-medium">{formatCurrency(line.lineTotal)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
