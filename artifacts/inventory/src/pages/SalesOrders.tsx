import { useState } from "react";
import { Link } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import { useListSalesOrders } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency, formatDate } from "@/lib/format";
import { Plus } from "lucide-react";
import { StatusBadge } from "@/components/StatusBadge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";

export default function SalesOrders() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  
  const { data: orders, isLoading } = useListSalesOrders({
    status: statusFilter === "all" ? undefined : statusFilter
  });

  return (
    <div className="space-y-6">
      <PageHeader 
        title="Sales Orders" 
        description="Manage customer orders and fulfillments."
        actions={
          <Button asChild data-testid="btn-create-so">
            <Link href="/sales-orders/new">
              <Plus className="mr-2 h-4 w-4" />
              New Order
            </Link>
          </Button>
        }
      />

      <div className="flex items-center gap-4 bg-card border rounded-lg p-4 w-full sm:w-auto sm:max-w-xs">
        <div className="w-full space-y-1">
          <Label>Status</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger data-testid="filter-so-status">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="confirmed">Confirmed</SelectItem>
              <SelectItem value="shipped">Shipped</SelectItem>
              <SelectItem value="delivered">Delivered</SelectItem>
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
              <TableHead>Customer</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center">Loading...</TableCell>
              </TableRow>
            ) : orders?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center">No orders found.</TableCell>
              </TableRow>
            ) : (
              orders?.map((order) => (
                <TableRow key={order.id} data-testid={`row-so-${order.id}`}>
                  <TableCell className="font-mono">
                    <Link href={`/sales-orders/${order.id}`} className="font-medium text-primary hover:underline">
                      {order.orderNumber}
                    </Link>
                  </TableCell>
                  <TableCell>{formatDate(order.orderDate)}</TableCell>
                  <TableCell>{order.customerName}</TableCell>
                  <TableCell><StatusBadge status={order.status} /></TableCell>
                  <TableCell className="text-right font-medium">{formatCurrency(order.total)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
