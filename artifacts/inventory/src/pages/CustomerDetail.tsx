import { useMemo, useState } from "react";
import { Link, useRoute, useLocation } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import {
  useGetCustomer,
  useListSalesOrders,
  useListCustomerPayments,
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
import { RecordPaymentDialog } from "@/components/RecordPaymentDialog";

export default function CustomerDetail() {
  const [, params] = useRoute("/customers/:id");
  const [location] = useLocation();
  const customerId = Number(params?.id ?? 0);

  const initialTab = useMemo(() => {
    const search = location.includes("?")
      ? location.split("?")[1]
      : window.location.search.replace(/^\?/, "");
    const sp = new URLSearchParams(search);
    return sp.get("tab") === "payments" ? "payments" : "profile";
  }, [location]);

  const [tab, setTab] = useState<string>(initialTab);
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);

  const { data: customer, isLoading } = useGetCustomer(customerId);
  const { data: orders } = useListSalesOrders({ customerId });
  const { data: payments } = useListCustomerPayments({ customerId });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Customer" description="Loading…" />
      </div>
    );
  }

  if (!customer) {
    return (
      <div className="space-y-6">
        <PageHeader title="Customer not found" description="" />
        <Button asChild variant="outline">
          <Link href="/customers">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to customers
          </Link>
        </Button>
      </div>
    );
  }

  const outstanding = Number(customer.outstandingBalance ?? 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title={customer.name}
        description={customer.company ?? customer.email ?? ""}
        actions={
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href="/customers">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Link>
            </Button>
            <Button
              onClick={() => setPaymentDialogOpen(true)}
              data-testid="btn-record-payment-customer"
            >
              <IndianRupee className="mr-2 h-4 w-4" />
              Record payment
            </Button>
          </div>
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="profile" data-testid="tab-profile">Profile</TabsTrigger>
          <TabsTrigger value="orders" data-testid="tab-orders">Sales orders</TabsTrigger>
          <TabsTrigger value="payments" data-testid="tab-payments">Payments</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Contact details</CardTitle>
              <CardDescription>
                Outstanding balance:{" "}
                <span
                  className={
                    outstanding > 0 ? "text-orange-600 font-medium" : ""
                  }
                  data-testid="text-customer-outstanding"
                >
                  {formatCurrency(outstanding)}
                </span>
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Field label="Email" value={customer.email} />
              <Field label="Phone" value={customer.phone} />
              <Field label="Company" value={customer.company} />
              <Field label="GST number" value={customer.gstNumber} />
              <Field label="Billing address" value={customer.billingAddress} />
              <Field label="Shipping address" value={customer.shippingAddress} />
              <Field label="Notes" value={customer.notes} />
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
                      No sales orders for this customer.
                    </TableCell>
                  </TableRow>
                ) : (
                  orders?.map((o) => (
                    <TableRow key={o.id} data-testid={`row-customer-so-${o.id}`}>
                      <TableCell className="font-mono">
                        <Link
                          href={`/sales-orders/${o.id}`}
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
                      No payments recorded for this customer yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  payments?.map((p) => (
                    <TableRow key={p.id} data-testid={`row-customer-payment-${p.id}`}>
                      <TableCell>{formatDate(p.paymentDate)}</TableCell>
                      <TableCell className="capitalize">{p.mode}</TableCell>
                      <TableCell>{p.referenceNumber || "-"}</TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCurrency(Number(p.amount))}
                      </TableCell>
                      <TableCell className="text-right">
                        <Link
                          href={`/payments/${p.id}`}
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
      </Tabs>

      {paymentDialogOpen && (
        <RecordPaymentDialog
          open={paymentDialogOpen}
          onOpenChange={setPaymentDialogOpen}
          customerId={customerId}
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
