import { useParams, Link, useLocation } from "wouter";
import {
  useGetSupplierPayment,
  useDeleteSupplierPayment,
  getGetSupplierPaymentQueryKey,
  getListSupplierPaymentsQueryKey,
  getListSuppliersQueryKey,
  getListPurchaseOrdersQueryKey,
  getGetPayablesAgingReportQueryKey,
  getGetPurchaseOrderQueryKey,
} from "@/lib/queryKeys";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDate } from "@/lib/format";
import { ArrowLeft, Trash2, FileDown } from "lucide-react";
import { useState } from "react";
import { downloadSupplierPaymentVoucher } from "@workspace/api-client-react";
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
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

export default function SupplierPaymentDetail() {
  const { id } = useParams();
  const paymentId = parseInt(id || "0", 10);
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading } = useGetSupplierPayment(paymentId, {
    query: {
      enabled: !!paymentId,
      queryKey: getGetSupplierPaymentQueryKey(paymentId),
    },
  });

  const [downloading, setDownloading] = useState(false);

  const handleDownloadVoucher = async () => {
    setDownloading(true);
    try {
      const blob = (await downloadSupplierPaymentVoucher(
        paymentId,
      )) as unknown as Blob;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `voucher-PV-${String(paymentId).padStart(6, "0")}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      toast({
        title: "Could not download voucher",
        description:
          e.response?.data?.error ?? "Please try again in a moment.",
        variant: "destructive",
      });
    } finally {
      setDownloading(false);
    }
  };

  const deleteMutation = useDeleteSupplierPayment({
    mutation: {
      onSuccess: () => {
        toast({ title: "Payment deleted" });
        queryClient.invalidateQueries({
          queryKey: getListSupplierPaymentsQueryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: getListSuppliersQueryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: getListPurchaseOrdersQueryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: getGetPayablesAgingReportQueryKey(),
        });
        for (const a of data?.allocations ?? []) {
          queryClient.invalidateQueries({
            queryKey: getGetPurchaseOrderQueryKey(a.purchaseOrderId),
          });
        }
        navigate("/supplier-payments");
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        toast({
          title: "Could not delete payment",
          description: e.response?.data?.error ?? "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-32" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const { payment, allocations } = data;
  const allocatedTotal = allocations.reduce(
    (s, a) => s + Number(a.amount),
    0,
  );
  const unallocated = Number(payment.amount) - allocatedTotal;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/supplier-payments">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <PageHeader
          title={`Payment #${payment.id}`}
          description={`To ${payment.supplierName}`}
          className="mb-0"
          actions={
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={handleDownloadVoucher}
                disabled={downloading}
                data-testid="btn-download-voucher"
              >
                <FileDown className="mr-2 h-4 w-4" />
                {downloading ? "Preparing..." : "Download voucher"}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" data-testid="btn-delete-payment">
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this payment?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Allocations will be reversed and the supplier's
                      outstanding payable will be restored.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => deleteMutation.mutate({ id: paymentId })}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      data-testid="btn-confirm-delete-payment"
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          }
        />
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Payment details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Date</span>
              <span>{formatDate(payment.paymentDate)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Mode</span>
              <span className="capitalize">{payment.mode}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Reference</span>
              <span>{payment.referenceNumber || "-"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Bank / wallet</span>
              <span>{payment.bankAccountLabel || "-"}</span>
            </div>
            {payment.notes && (
              <div className="pt-2 border-t">
                <p className="text-muted-foreground mb-1">Notes</p>
                <p>{payment.notes}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Amount</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between text-lg font-semibold">
              <span>Paid</span>
              <span>{formatCurrency(payment.amount)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Allocated</span>
              <span>{formatCurrency(allocatedTotal)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Advance / unapplied</span>
              <span
                className={unallocated > 0.005 ? "text-orange-600" : ""}
              >
                {formatCurrency(unallocated)}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Applied to bills</CardTitle>
        </CardHeader>
        <CardContent>
          {allocations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Recorded as a supplier advance — not applied to any bill.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead className="text-right">Order total</TableHead>
                  <TableHead className="text-right">Balance after</TableHead>
                  <TableHead className="text-right">Applied</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allocations.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/purchase-orders/${a.purchaseOrderId}`}
                        className="text-primary hover:underline"
                      >
                        {a.purchaseOrderNumber}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(a.purchaseOrderTotal)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(a.purchaseOrderBalanceDue)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCurrency(a.amount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
