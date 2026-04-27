import { useParams, Link } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import {
  useGetPurchaseOrder,
  useUpdatePurchaseOrderStatus,
  useReturnPurchaseOrder,
  useListStockMovements,
  getGetPurchaseOrderQueryKey,
  getListStockMovementsQueryKey,
} from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatDate } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, CheckCircle2, PackagePlus, XCircle, Undo2 } from "lucide-react";
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

const RETURNABLE_PURCHASE_STATUSES = ["received", "billed", "paid"];

export default function PurchaseOrderDetail() {
  const { id } = useParams();
  const orderId = parseInt(id || "0", 10);
  
  const { data: orderDetail, isLoading } = useGetPurchaseOrder(orderId, {
    query: { enabled: !!orderId, queryKey: getGetPurchaseOrderQueryKey(orderId) }
  });
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const movementsQuery = useListStockMovements(
    { referenceType: "purchase_order", referenceId: orderId },
    {
      query: {
        enabled: !!orderId,
        queryKey: getListStockMovementsQueryKey({
          referenceType: "purchase_order",
          referenceId: orderId,
        }),
      },
    },
  );

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: getGetPurchaseOrderQueryKey(orderId) });
    queryClient.invalidateQueries({
      queryKey: getListStockMovementsQueryKey({
        referenceType: "purchase_order",
        referenceId: orderId,
      }),
    });
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
            onClick={() => handleUpdateStatus("received")} 
            disabled={updateStatusMutation.isPending}
            data-testid="btn-status-receive"
          >
            <PackagePlus className="mr-2 h-4 w-4" /> Mark as Received
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
        {RETURNABLE_PURCHASE_STATUSES.includes(order.status) && (
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
                <Link href="/suppliers" className="text-primary hover:underline">{order.supplierName}</Link>
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
                <TableHead className="text-right">Unit Cost</TableHead>
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
    </div>
  );
}
