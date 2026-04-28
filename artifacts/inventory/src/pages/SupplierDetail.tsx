import { useMemo, useState } from "react";
import { Link, useRoute, useLocation } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import {
  useGetSupplier,
  useListPurchaseOrders,
  useListSupplierPayments,
  useListJobWorkOrders,
  useReportStockWithJobWorkers,
  getListJobWorkOrdersQueryKey,
  getReportStockWithJobWorkersQueryKey,
} from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { formatCurrency, formatDate } from "@/lib/format";
import { ArrowLeft, IndianRupee } from "lucide-react";
import { StatusBadge } from "@/components/StatusBadge";
import { RecordSupplierPaymentDialog } from "@/components/RecordSupplierPaymentDialog";

export default function SupplierDetail() {
  const [, params] = useRoute("/suppliers/:id");
  const [location] = useLocation();
  const supplierId = Number(params?.id ?? 0);

  const initialTab = useMemo(() => {
    const search = location.includes("?")
      ? location.split("?")[1]
      : window.location.search.replace(/^\?/, "");
    const sp = new URLSearchParams(search);
    return sp.get("tab") === "payments" ? "payments" : "profile";
  }, [location]);

  const [tab, setTab] = useState<string>(initialTab);
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);

  const { data: supplier, isLoading } = useGetSupplier(supplierId);
  const { data: orders } = useListPurchaseOrders({ supplierId });
  const { data: payments } = useListSupplierPayments({ supplierId });
  const { data: jobWorkOrders } = useListJobWorkOrders(
    { supplierId },
    {
      query: {
        enabled: !!supplier?.isJobWorker,
        queryKey: getListJobWorkOrdersQueryKey({ supplierId }),
      },
    },
  );
  const { data: stockReport } = useReportStockWithJobWorkers({
    query: {
      enabled: !!supplier?.isJobWorker,
      queryKey: getReportStockWithJobWorkersQueryKey(),
    },
  });
  const stockWithThisWorker = useMemo(
    () =>
      (stockReport?.rows ?? []).filter((r) => r.supplierId === supplierId),
    [stockReport, supplierId],
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Supplier" description="Loading…" />
      </div>
    );
  }

  if (!supplier) {
    return (
      <div className="space-y-6">
        <PageHeader title="Supplier not found" description="" />
        <Button asChild variant="outline">
          <Link href="/suppliers">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to suppliers
          </Link>
        </Button>
      </div>
    );
  }

  const outstanding = Number(supplier.outstandingPayable ?? 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title={supplier.name}
        description={supplier.company ?? supplier.email ?? ""}
        actions={
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href="/suppliers">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Link>
            </Button>
            <Button
              onClick={() => setPaymentDialogOpen(true)}
              data-testid="btn-record-payment-supplier"
            >
              <IndianRupee className="mr-2 h-4 w-4" />
              Record payment
            </Button>
          </div>
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="profile" data-testid="tab-profile">
            Profile
          </TabsTrigger>
          <TabsTrigger value="orders" data-testid="tab-orders">
            Purchase orders
          </TabsTrigger>
          <TabsTrigger value="payments" data-testid="tab-payments">
            Payments
          </TabsTrigger>
          {supplier.isJobWorker && (
            <TabsTrigger value="job-work" data-testid="tab-job-work">
              Job work
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="profile" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Contact details</CardTitle>
              <CardDescription>
                Outstanding payable:{" "}
                <span
                  className={
                    outstanding > 0 ? "text-orange-600 font-medium" : ""
                  }
                  data-testid="text-supplier-outstanding"
                >
                  {formatCurrency(outstanding)}
                </span>
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Field label="Email" value={supplier.email} />
              <Field label="Phone" value={supplier.phone} />
              <Field label="Company" value={supplier.company} />
              <Field label="GST number" value={supplier.gstNumber} />
              <Field label="Address" value={supplier.address} />
              <Field label="Notes" value={supplier.notes} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="orders" className="mt-4">
          <div className="rounded-md border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order #</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center">
                      No purchase orders for this supplier.
                    </TableCell>
                  </TableRow>
                ) : (
                  orders?.map((o) => (
                    <TableRow
                      key={o.id}
                      data-testid={`row-supplier-po-${o.id}`}
                    >
                      <TableCell className="font-mono">
                        <Link
                          href={`/purchase-orders/${o.id}`}
                          className="font-medium text-primary hover:underline"
                        >
                          {o.orderNumber}
                        </Link>
                      </TableCell>
                      <TableCell>{formatDate(o.orderDate)}</TableCell>
                      <TableCell>
                        <StatusBadge status={o.status} />
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCurrency(o.total)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(Number(o.amountPaid ?? 0))}
                      </TableCell>
                      <TableCell className="text-right">
                        <span
                          className={
                            Number(o.balanceDue ?? 0) > 0
                              ? "text-orange-600 font-medium"
                              : "text-muted-foreground"
                          }
                        >
                          {formatCurrency(Number(o.balanceDue ?? 0))}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="payments" className="mt-4">
          <div className="rounded-md border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center">
                      No payments recorded for this supplier yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  payments?.map((p) => (
                    <TableRow
                      key={p.id}
                      data-testid={`row-supplier-payment-${p.id}`}
                    >
                      <TableCell>{formatDate(p.paymentDate)}</TableCell>
                      <TableCell className="capitalize">{p.mode}</TableCell>
                      <TableCell>{p.referenceNumber || "-"}</TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCurrency(Number(p.amount))}
                      </TableCell>
                      <TableCell className="text-right">
                        <Link
                          href={`/supplier-payments/${p.id}`}
                          className="text-primary hover:underline text-sm"
                        >
                          View
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        {supplier.isJobWorker && (
          <TabsContent value="job-work" className="mt-4 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Job work orders</CardTitle>
                <CardDescription>
                  Open and historical orders sent to this worker.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>JWO #</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Output</TableHead>
                      <TableHead className="text-right">Planned</TableHead>
                      <TableHead className="text-right">Received</TableHead>
                      <TableHead className="text-right">Pending</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {jobWorkOrders?.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="h-24 text-center">
                          No job work orders for this worker yet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      jobWorkOrders?.map((o) => {
                        const planned = Number(o.outputQuantity);
                        const received = Number(o.receivedQuantity ?? 0);
                        const pending = Number(
                          o.remainingQuantity ??
                            Math.max(0, planned - received),
                        );
                        return (
                          <TableRow
                            key={o.id}
                            data-testid={`row-supplier-jwo-${o.id}`}
                          >
                            <TableCell className="font-mono">
                              <Link
                                href={`/job-work/${o.id}`}
                                className="font-medium text-primary hover:underline"
                              >
                                {o.jwoNumber}
                              </Link>
                            </TableCell>
                            <TableCell>{formatDate(o.createdAt)}</TableCell>
                            <TableCell>{o.outputItemName}</TableCell>
                            <TableCell className="text-right font-medium">
                              {planned}
                            </TableCell>
                            <TableCell className="text-right">
                              {received}
                            </TableCell>
                            <TableCell className="text-right">
                              <span
                                className={
                                  pending > 0
                                    ? "text-orange-600 font-medium"
                                    : "text-muted-foreground"
                                }
                              >
                                {pending}
                              </span>
                            </TableCell>
                            <TableCell>
                              <StatusBadge status={o.status} />
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Stock currently with this worker</CardTitle>
                <CardDescription>
                  Materials still lying with the worker across all open
                  orders. Receive them back through a job work order.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead className="text-right">Quantity</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {stockWithThisWorker.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={3} className="h-24 text-center">
                          No materials currently with this worker.
                        </TableCell>
                      </TableRow>
                    ) : (
                      stockWithThisWorker.map((r) => (
                        <TableRow
                          key={`${r.warehouseId}-${r.itemId}`}
                          data-testid={`row-supplier-jw-stock-${r.itemId}`}
                        >
                          <TableCell>{r.itemName}</TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {r.sku}
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {Number(r.quantity)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {paymentDialogOpen && (
        <RecordSupplierPaymentDialog
          open={paymentDialogOpen}
          onOpenChange={setPaymentDialogOpen}
          supplierId={supplierId}
          supplierName={supplier.name}
        />
      )}
    </div>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value?: string | null;
}) {
  return (
    <div>
      <div className="text-xs uppercase text-muted-foreground tracking-wide">
        {label}
      </div>
      <div className="text-sm">{value && value.length > 0 ? value : "-"}</div>
    </div>
  );
}
