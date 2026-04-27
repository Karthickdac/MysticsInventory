import { useState } from "react";
import { Link } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import { useListPurchaseOrders } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency, formatDate } from "@/lib/format";
import { Plus, IndianRupee } from "lucide-react";
import { StatusBadge } from "@/components/StatusBadge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { RecordSupplierPaymentDialog } from "@/components/RecordSupplierPaymentDialog";

const PAYABLE_STATUSES = new Set([
  "ordered",
  "partially_received",
  "received",
  "billed",
]);

export default function PurchaseOrders() {
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const { data: orders, isLoading } = useListPurchaseOrders({
    status: statusFilter === "all" ? undefined : statusFilter
  });

  const [paymentTarget, setPaymentTarget] = useState<{
    supplierId: number;
    supplierName: string;
    purchaseOrderId: number;
    balance: number;
  } | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader 
        title="Purchase Orders" 
        description="Manage stock replenishment and vendor orders."
        actions={
          <Button asChild data-testid="btn-create-po">
            <Link href="/purchase-orders/new">
              <Plus className="mr-2 h-4 w-4" />
              New Purchase Order
            </Link>
          </Button>
        }
      />

      <div className="flex items-center gap-4 bg-card border rounded-lg p-4 w-full sm:w-auto sm:max-w-xs">
        <div className="w-full space-y-1">
          <Label>Status</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger data-testid="filter-po-status">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="confirmed">Confirmed</SelectItem>
              <SelectItem value="received">Received</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Order #</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Supplier</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center">Loading...</TableCell>
              </TableRow>
            ) : orders?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center">No orders found.</TableCell>
              </TableRow>
            ) : (
              orders?.map((order) => {
                const balance = Number(order.balanceDue ?? 0);
                const canPay = PAYABLE_STATUSES.has(order.status) && balance > 0;
                return (
                  <TableRow key={order.id} data-testid={`row-po-${order.id}`}>
                    <TableCell className="font-mono">
                      <Link href={`/purchase-orders/${order.id}`} className="font-medium text-primary hover:underline">
                        {order.orderNumber}
                      </Link>
                    </TableCell>
                    <TableCell>{formatDate(order.orderDate)}</TableCell>
                    <TableCell>{order.supplierName}</TableCell>
                    <TableCell><StatusBadge status={order.status} /></TableCell>
                    <TableCell className="text-right font-medium">{formatCurrency(order.total)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(Number(order.amountPaid ?? 0))}</TableCell>
                    <TableCell className="text-right">
                      <span className={balance > 0 ? "text-orange-600 font-medium" : "text-muted-foreground"}>
                        {formatCurrency(balance)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      {canPay && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setPaymentTarget({
                              supplierId: order.supplierId,
                              supplierName: order.supplierName,
                              purchaseOrderId: order.id,
                              balance,
                            })
                          }
                          data-testid={`btn-row-record-payment-${order.id}`}
                        >
                          <IndianRupee className="mr-1 h-3.5 w-3.5" />
                          Record payment
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {paymentTarget && (
        <RecordSupplierPaymentDialog
          open={!!paymentTarget}
          onOpenChange={(o) => !o && setPaymentTarget(null)}
          supplierId={paymentTarget.supplierId}
          supplierName={paymentTarget.supplierName}
          presetPurchaseOrderId={paymentTarget.purchaseOrderId}
          presetPurchaseOrderBalance={paymentTarget.balance}
        />
      )}
    </div>
  );
}
