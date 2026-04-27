import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import {
  useListSupplierPayments,
  useListSuppliers,
  getListSupplierPaymentsQueryKey,
} from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDate } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus } from "lucide-react";
import { RecordSupplierPaymentDialog } from "@/components/RecordSupplierPaymentDialog";

function useQueryString() {
  const [location] = useLocation();
  return useMemo(() => {
    const idx = location.indexOf("?");
    return new URLSearchParams(idx >= 0 ? location.slice(idx + 1) : "");
  }, [location]);
}

export default function SupplierPayments() {
  const qs = useQueryString();
  const initialSupplierId = qs.get("supplierId");

  const [supplierFilter, setSupplierFilter] = useState<string>(
    initialSupplierId ?? "all",
  );
  const [modeFilter, setModeFilter] = useState<string>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [recordOpen, setRecordOpen] = useState(false);

  useEffect(() => {
    if (initialSupplierId) setSupplierFilter(initialSupplierId);
  }, [initialSupplierId]);

  const { data: suppliers } = useListSuppliers({});
  const params: Record<string, string> = {};
  if (supplierFilter !== "all") params.supplierId = supplierFilter;
  if (modeFilter !== "all") params.mode = modeFilter;
  if (from) params.from = from;
  if (to) params.to = to;

  const { data: payments, isLoading } = useListSupplierPayments(
    params as never,
    {
      query: {
        queryKey: getListSupplierPaymentsQueryKey(params as never),
      },
    },
  );

  const supplierIdNum =
    supplierFilter !== "all" ? Number(supplierFilter) : null;
  const selectedSupplier = suppliers?.find((s) => s.id === supplierIdNum);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Supplier Payments"
        description="Record and review money paid to suppliers."
        actions={
          <Button
            onClick={() => setRecordOpen(true)}
            disabled={!supplierIdNum}
            data-testid="btn-record-supplier-payment"
          >
            <Plus className="mr-2 h-4 w-4" />
            Record payment
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-4">
        <div className="space-y-1.5">
          <Label>Supplier</Label>
          <Select value={supplierFilter} onValueChange={setSupplierFilter}>
            <SelectTrigger data-testid="select-payments-supplier">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All suppliers</SelectItem>
              {suppliers?.map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Mode</Label>
          <Select value={modeFilter} onValueChange={setModeFilter}>
            <SelectTrigger data-testid="select-payments-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All modes</SelectItem>
              <SelectItem value="cash">Cash</SelectItem>
              <SelectItem value="bank">Bank</SelectItem>
              <SelectItem value="upi">UPI</SelectItem>
              <SelectItem value="cheque">Cheque</SelectItem>
              <SelectItem value="razorpay">Razorpay</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>From</Label>
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            data-testid="input-payments-from"
          />
        </div>
        <div className="space-y-1.5">
          <Label>To</Label>
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            data-testid="input-payments-to"
          />
        </div>
      </div>

      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Supplier</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <Skeleton className="h-8 w-full" />
                </TableCell>
              </TableRow>
            ) : !payments || payments.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="h-24 text-center text-muted-foreground"
                >
                  No payments yet.
                </TableCell>
              </TableRow>
            ) : (
              payments.map((p) => (
                <TableRow
                  key={p.id}
                  data-testid={`row-supplier-payment-${p.id}`}
                  className="cursor-pointer hover:bg-muted/40"
                >
                  <TableCell>
                    <Link href={`/supplier-payments/${p.id}`} className="block">
                      {formatDate(p.paymentDate)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/supplier-payments/${p.id}`} className="block">
                      {p.supplierName}
                    </Link>
                  </TableCell>
                  <TableCell className="capitalize">
                    <Link href={`/supplier-payments/${p.id}`} className="block">
                      {p.mode}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/supplier-payments/${p.id}`} className="block">
                      {p.referenceNumber || "-"}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    <Link href={`/supplier-payments/${p.id}`} className="block">
                      {formatCurrency(p.amount)}
                    </Link>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {supplierIdNum && (
        <RecordSupplierPaymentDialog
          open={recordOpen}
          onOpenChange={setRecordOpen}
          supplierId={supplierIdNum}
          supplierName={selectedSupplier?.name}
        />
      )}
    </div>
  );
}
