import { useEffect, useMemo, useState } from "react";
import {
  useCreateSupplierPayment,
  useListPurchaseOrders,
  getGetPurchaseOrderQueryKey,
  getListPurchaseOrdersQueryKey,
  getListSupplierPaymentsQueryKey,
  getListSuppliersQueryKey,
  getGetPayablesAgingReportQueryKey,
} from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { Checkbox } from "@/components/ui/checkbox";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/format";

const PAYMENT_MODES = [
  { value: "cash", label: "Cash" },
  { value: "bank", label: "Bank transfer" },
  { value: "upi", label: "UPI" },
  { value: "cheque", label: "Cheque" },
  { value: "razorpay", label: "Razorpay" },
  { value: "other", label: "Other" },
] as const;

type Allocation = { purchaseOrderId: number; amount: string };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplierId: number;
  supplierName?: string;
  presetPurchaseOrderId?: number;
  presetPurchaseOrderBalance?: number;
}

export function RecordSupplierPaymentDialog({
  open,
  onOpenChange,
  supplierId,
  supplierName,
  presetPurchaseOrderId,
  presetPurchaseOrderBalance,
}: Props) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [paymentDate, setPaymentDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<string>("upi");
  const [reference, setReference] = useState("");
  const [bankAccount, setBankAccount] = useState("");
  const [notes, setNotes] = useState("");
  const [allocations, setAllocations] = useState<Allocation[]>([]);

  const { data: openOrders, isLoading: ordersLoading } = useListPurchaseOrders(
    { supplierId },
    {
      query: {
        enabled: open && !!supplierId,
        queryKey: getListPurchaseOrdersQueryKey({ supplierId }),
      },
    },
  );

  const eligibleOrders = useMemo(
    () =>
      (openOrders ?? []).filter(
        (o) =>
          Number(o.balanceDue) > 0 &&
          ["ordered", "partially_received", "received", "billed"].includes(
            o.status,
          ),
      ),
    [openOrders],
  );

  useEffect(() => {
    if (!open) return;
    setPaymentDate(new Date().toISOString().slice(0, 10));
    setAmount(
      presetPurchaseOrderBalance
        ? presetPurchaseOrderBalance.toFixed(2)
        : "",
    );
    setMode("upi");
    setReference("");
    setBankAccount("");
    setNotes("");
    if (presetPurchaseOrderId && presetPurchaseOrderBalance) {
      setAllocations([
        {
          purchaseOrderId: presetPurchaseOrderId,
          amount: presetPurchaseOrderBalance.toFixed(2),
        },
      ]);
    } else {
      setAllocations([]);
    }
  }, [open, presetPurchaseOrderId, presetPurchaseOrderBalance]);

  const totalAllocated = allocations.reduce(
    (s, a) => s + (Number(a.amount) || 0),
    0,
  );
  const amountNum = Number(amount) || 0;
  const overAllocated = totalAllocated - amountNum > 0.005;

  const toggleAllocation = (orderId: number, balance: number) => {
    setAllocations((prev) => {
      const exists = prev.find((a) => a.purchaseOrderId === orderId);
      if (exists) return prev.filter((a) => a.purchaseOrderId !== orderId);
      return [
        ...prev,
        { purchaseOrderId: orderId, amount: balance.toFixed(2) },
      ];
    });
  };

  const updateAllocationAmount = (orderId: number, value: string) => {
    setAllocations((prev) =>
      prev.map((a) =>
        a.purchaseOrderId === orderId ? { ...a, amount: value } : a,
      ),
    );
  };

  const createMutation = useCreateSupplierPayment({
    mutation: {
      onSuccess: () => {
        toast({ title: "Payment recorded" });
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
        if (presetPurchaseOrderId) {
          queryClient.invalidateQueries({
            queryKey: getGetPurchaseOrderQueryKey(presetPurchaseOrderId),
          });
        }
        for (const a of allocations) {
          queryClient.invalidateQueries({
            queryKey: getGetPurchaseOrderQueryKey(a.purchaseOrderId),
          });
        }
        onOpenChange(false);
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        toast({
          title: "Could not record payment",
          description: e.response?.data?.error ?? "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  const submit = () => {
    if (!amountNum || amountNum <= 0) {
      toast({ title: "Enter a payment amount", variant: "destructive" });
      return;
    }
    if (overAllocated) {
      toast({
        title: "Allocations exceed payment amount",
        variant: "destructive",
      });
      return;
    }
    const cleanedAllocations = allocations
      .map((a) => ({
        purchaseOrderId: a.purchaseOrderId,
        amount: Number(a.amount),
      }))
      .filter((a) => a.amount > 0);
    createMutation.mutate({
      data: {
        supplierId,
        paymentDate,
        amount: amountNum,
        mode,
        referenceNumber: reference || null,
        bankAccountLabel: bankAccount || null,
        notes: notes || null,
        allocations: cleanedAllocations,
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record supplier payment</DialogTitle>
          <DialogDescription>
            {supplierName
              ? `To ${supplierName}`
              : "Capture a payment to a supplier and apply it to open bills."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="payment-date">Payment date</Label>
              <Input
                id="payment-date"
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
                data-testid="input-payment-date"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="payment-amount">Amount</Label>
              <Input
                id="payment-amount"
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                data-testid="input-payment-amount"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Mode</Label>
              <Select value={mode} onValueChange={setMode}>
                <SelectTrigger data-testid="select-payment-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="payment-reference">Reference / Txn ID</Label>
              <Input
                id="payment-reference"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                data-testid="input-payment-reference"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="payment-bank">Bank / wallet (optional)</Label>
            <Input
              id="payment-bank"
              value={bankAccount}
              onChange={(e) => setBankAccount(e.target.value)}
              placeholder="e.g. HDFC current 1234"
              data-testid="input-payment-bank"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="payment-notes">Notes</Label>
            <Textarea
              id="payment-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              data-testid="input-payment-notes"
            />
          </div>

          <div className="rounded-md border">
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Apply to bills</p>
                <p className="text-xs text-muted-foreground">
                  Optional — leave blank to record as advance.
                </p>
              </div>
              <div className="text-right text-xs">
                <p className="text-muted-foreground">Allocated</p>
                <p
                  className={`font-mono font-medium ${
                    overAllocated ? "text-destructive" : ""
                  }`}
                >
                  {formatCurrency(totalAllocated)}
                </p>
              </div>
            </div>
            {ordersLoading ? (
              <p className="p-4 text-sm text-muted-foreground">Loading…</p>
            ) : eligibleOrders.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                No open bills for this supplier.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10"></TableHead>
                    <TableHead>Order</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Balance due</TableHead>
                    <TableHead className="text-right">Apply</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {eligibleOrders.map((o) => {
                    const alloc = allocations.find(
                      (a) => a.purchaseOrderId === o.id,
                    );
                    const balance = Number(o.balanceDue);
                    return (
                      <TableRow key={o.id}>
                        <TableCell>
                          <Checkbox
                            checked={!!alloc}
                            onCheckedChange={() =>
                              toggleAllocation(o.id, balance)
                            }
                            data-testid={`check-alloc-${o.id}`}
                          />
                        </TableCell>
                        <TableCell className="font-medium">
                          {o.orderNumber}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatCurrency(o.total)}
                        </TableCell>
                        <TableCell className="text-right text-orange-600">
                          {formatCurrency(balance)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            max={balance}
                            disabled={!alloc}
                            value={alloc?.amount ?? ""}
                            onChange={(e) =>
                              updateAllocationAmount(o.id, e.target.value)
                            }
                            className="h-8 w-28 ml-auto text-right"
                            data-testid={`input-alloc-${o.id}`}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={createMutation.isPending || overAllocated}
            data-testid="btn-save-payment"
          >
            {createMutation.isPending ? "Saving…" : "Record payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
