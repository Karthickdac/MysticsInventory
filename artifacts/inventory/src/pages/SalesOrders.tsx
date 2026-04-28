import { useMemo, useState } from "react";
import { Link } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import {
  useListSalesOrders,
  useGetEinvoiceConnection,
  type SalesOrder,
} from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { formatCurrency, formatDate } from "@/lib/format";
import { IndianRupee, Plus, Receipt } from "lucide-react";
import { StatusBadge } from "@/components/StatusBadge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { RecordPaymentDialog } from "@/components/RecordPaymentDialog";
import { BulkEinvoiceDialog } from "@/components/BulkEinvoiceDialog";

const PAYABLE_STATUSES = new Set([
  "confirmed",
  "shipped",
  "delivered",
  "invoiced",
]);
// Statuses for which the IRP will accept an IRN registration. Mirrors
// the server-side guard in routes/einvoice.ts so the UI never offers
// an action the API would refuse.
const EINVOICE_ELIGIBLE_STATUSES = new Set([
  "shipped",
  "delivered",
  "invoiced",
  "paid",
]);

type SalesOrderRow = SalesOrder;

/**
 * An order is selectable for bulk e-invoice registration when it is
 * a B2B order in a shipped/delivered/invoiced/paid status that has
 * either never been registered or the previous attempt outright
 * failed. We deliberately do NOT offer the action for:
 *   - active IRNs (already registered — operator must cancel within
 *     24h on the detail page if they really want to re-issue)
 *   - pending IRNs (an attempt is mid-flight)
 *   - cancelled IRNs (the IRP requires a credit note instead;
 *     mirroring the server-side guard in routes/einvoice.ts which
 *     rejects with code "irn_cancelled")
 */
function isEinvoiceEligible(order: SalesOrderRow): boolean {
  if (!EINVOICE_ELIGIBLE_STATUSES.has(order.status)) return false;
  if (!order.customerGstNumber) return false;
  const ein = order.einvoice;
  if (ein && ein.status === "active") return false;
  if (ein && ein.status === "pending") return false;
  if (ein && ein.status === "cancelled") return false;
  return true;
}

export default function SalesOrders() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [paymentTarget, setPaymentTarget] = useState<{
    customerId: number;
    salesOrderId: number;
    balanceDue: number;
  } | null>(null);
  // Selection is keyed by order id. We never persist selection across
  // filter changes — when the user changes the status filter, the
  // visible rows change and any "stale" selected ids quietly fall out
  // of view; the bulk button below always shows the count of *visible
  // and still-eligible* selected rows so the count never lies.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkDialogState, setBulkDialogState] = useState<{
    open: boolean;
    orderIds: number[];
  }>({ open: false, orderIds: [] });

  const { data: orders, isLoading } = useListSalesOrders({
    status: statusFilter === "all" ? undefined : statusFilter,
  });

  const einvoiceConnection = useGetEinvoiceConnection();
  const einvoiceAvailable =
    einvoiceConnection.data?.connected === true &&
    einvoiceConnection.data?.enabled === true;

  const eligibleVisible = useMemo(
    () => (orders ?? []).filter(isEinvoiceEligible),
    [orders],
  );
  const selectedEligibleIds = useMemo(
    () => eligibleVisible.filter((o) => selectedIds.has(o.id)).map((o) => o.id),
    [eligibleVisible, selectedIds],
  );

  const allEligibleSelected =
    eligibleVisible.length > 0 &&
    selectedEligibleIds.length === eligibleVisible.length;
  const someEligibleSelected =
    selectedEligibleIds.length > 0 && !allEligibleSelected;

  const toggleAllEligible = () => {
    if (allEligibleSelected) {
      // Drop only the currently-visible eligible ids so we don't
      // forget selections the user already made on a different
      // status filter view (selections fall out of view but stay in
      // memory in case they switch filters back).
      const next = new Set(selectedIds);
      for (const o of eligibleVisible) next.delete(o.id);
      setSelectedIds(next);
    } else {
      const next = new Set(selectedIds);
      for (const o of eligibleVisible) next.add(o.id);
      setSelectedIds(next);
    }
  };

  const toggleOne = (id: number) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const openBulk = () => {
    if (selectedEligibleIds.length === 0) return;
    setBulkDialogState({ open: true, orderIds: selectedEligibleIds });
  };

  // Show the selection column only when bulk e-invoicing is actually
  // usable. There's no point cluttering the table for a tenant that
  // hasn't connected the IRP integration.
  const showSelection = einvoiceAvailable;

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

      <div className="flex flex-wrap items-end gap-4">
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
                <SelectItem value="invoiced">Invoiced</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {showSelection && selectedEligibleIds.length > 0 && (
          <div className="flex items-center gap-2 rounded-lg border bg-card px-4 py-3">
            <p className="text-sm text-muted-foreground">
              {selectedEligibleIds.length} selected
            </p>
            <Button
              size="sm"
              onClick={openBulk}
              data-testid="btn-bulk-generate-einvoices"
            >
              <Receipt className="mr-2 h-4 w-4" />
              Generate e-invoices ({selectedEligibleIds.length})
            </Button>
          </div>
        )}
      </div>

      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              {showSelection && (
                <TableHead className="w-[44px]">
                  <Checkbox
                    checked={
                      allEligibleSelected
                        ? true
                        : someEligibleSelected
                          ? "indeterminate"
                          : false
                    }
                    onCheckedChange={toggleAllEligible}
                    disabled={eligibleVisible.length === 0}
                    aria-label="Select all eligible orders"
                    data-testid="checkbox-bulk-select-all"
                  />
                </TableHead>
              )}
              <TableHead>Order #</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              <TableHead className="w-[140px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={showSelection ? 9 : 8}
                  className="h-24 text-center"
                >
                  Loading...
                </TableCell>
              </TableRow>
            ) : orders?.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={showSelection ? 9 : 8}
                  className="h-24 text-center"
                >
                  No orders found.
                </TableCell>
              </TableRow>
            ) : (
              orders?.map((order) => {
                const balance = Number(order.balanceDue ?? 0);
                const paid = Number(order.amountPaid ?? 0);
                const canPay =
                  PAYABLE_STATUSES.has(order.status) && balance > 0;
                const eligible = isEinvoiceEligible(order);
                return (
                  <TableRow key={order.id} data-testid={`row-so-${order.id}`}>
                    {showSelection && (
                      <TableCell>
                        <Checkbox
                          checked={selectedIds.has(order.id)}
                          onCheckedChange={() => toggleOne(order.id)}
                          disabled={!eligible}
                          aria-label={`Select order ${order.orderNumber}`}
                          data-testid={`checkbox-bulk-select-${order.id}`}
                        />
                      </TableCell>
                    )}
                    <TableCell className="font-mono">
                      <Link
                        href={`/sales-orders/${order.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {order.orderNumber}
                      </Link>
                    </TableCell>
                    <TableCell>{formatDate(order.orderDate)}</TableCell>
                    <TableCell>{order.customerName}</TableCell>
                    <TableCell>
                      <StatusBadge status={order.status} />
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCurrency(order.total)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(paid)}
                    </TableCell>
                    <TableCell className="text-right">
                      <span
                        className={
                          balance > 0
                            ? "text-orange-600 font-medium"
                            : "text-muted-foreground"
                        }
                      >
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
                              customerId: order.customerId,
                              salesOrderId: order.id,
                              balanceDue: balance,
                            })
                          }
                          data-testid={`btn-record-payment-${order.id}`}
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
        <RecordPaymentDialog
          open={!!paymentTarget}
          onOpenChange={(open) => {
            if (!open) setPaymentTarget(null);
          }}
          customerId={paymentTarget.customerId}
          presetSalesOrderId={paymentTarget.salesOrderId}
          presetSalesOrderBalance={paymentTarget.balanceDue}
        />
      )}

      {bulkDialogState.open && (
        <BulkEinvoiceDialog
          open={bulkDialogState.open}
          onOpenChange={(open) => {
            if (!open) {
              setBulkDialogState({ open: false, orderIds: [] });
              // Clear selection once the user has acknowledged the
              // batch by closing the dialog. Anything that failed has
              // already been re-tried (or punted to the operator) and
              // a fresh selection should start from scratch.
              setSelectedIds(new Set());
            }
          }}
          orderIds={bulkDialogState.orderIds}
        />
      )}
    </div>
  );
}
