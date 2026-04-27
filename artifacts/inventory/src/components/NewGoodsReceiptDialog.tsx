import { useEffect, useMemo, useState } from "react";
import {
  useCreatePurchaseOrderGoodsReceipt,
  getGetPurchaseOrderQueryKey,
  getListPurchaseOrderGoodsReceiptsQueryKey,
  getListStockMovementsQueryKey,
  getListItemsQueryKey,
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

interface OrderLine {
  id: number;
  itemName: string;
  sku: string;
  quantity: number;
  quantityReceived: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  purchaseOrderId: number;
  lines: OrderLine[];
}

type Row = {
  purchaseOrderLineId: number;
  itemName: string;
  sku: string;
  ordered: number;
  alreadyReceived: number;
  remaining: number;
  selected: boolean;
  quantity: string;
};

export function NewGoodsReceiptDialog({
  open,
  onOpenChange,
  purchaseOrderId,
  lines,
}: Props) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [receivedDate, setReceivedDate] = useState(today);
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    if (!open) return;
    setReceivedDate(today);
    setNotes("");
    setRows(
      lines.map((l) => {
        const remaining = Math.max(0, l.quantity - l.quantityReceived);
        return {
          purchaseOrderLineId: l.id,
          itemName: l.itemName,
          sku: l.sku,
          ordered: l.quantity,
          alreadyReceived: l.quantityReceived,
          remaining,
          selected: remaining > 0,
          quantity: remaining > 0 ? String(remaining) : "0",
        };
      }),
    );
  }, [open, lines, today]);

  const createMutation = useCreatePurchaseOrderGoodsReceipt({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getGetPurchaseOrderQueryKey(purchaseOrderId),
        });
        queryClient.invalidateQueries({
          queryKey:
            getListPurchaseOrderGoodsReceiptsQueryKey(purchaseOrderId),
        });
        queryClient.invalidateQueries({
          queryKey: getListStockMovementsQueryKey(),
        });
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        toast({ title: "Receipt recorded" });
        onOpenChange(false);
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        toast({
          title: "Could not record receipt",
          description: e.response?.data?.error ?? "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  const updateRow = (idx: number, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const anySelectable = rows.some((r) => r.remaining > 0);
  const selectedRows = rows.filter((r) => r.selected && Number(r.quantity) > 0);
  const totalUnits = selectedRows.reduce(
    (s, r) => s + Number(r.quantity || 0),
    0,
  );

  const handleSubmit = () => {
    if (selectedRows.length === 0) {
      toast({
        title: "Select at least one line",
        variant: "destructive",
      });
      return;
    }
    for (const r of selectedRows) {
      const qty = Number(r.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        toast({
          title: `Invalid quantity for ${r.itemName}`,
          variant: "destructive",
        });
        return;
      }
      if (qty - r.remaining > 1e-6) {
        toast({
          title: `Cannot receive more than remaining (${r.remaining}) for ${r.itemName}`,
          variant: "destructive",
        });
        return;
      }
    }
    createMutation.mutate({
      id: purchaseOrderId,
      data: {
        receivedDate,
        notes: notes.trim() || null,
        lines: selectedRows.map((r) => ({
          purchaseOrderLineId: r.purchaseOrderLineId,
          quantity: Number(r.quantity),
        })),
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>New receipt</DialogTitle>
          <DialogDescription>
            Pick the line quantities the supplier delivered now. Leave a line
            unchecked or set its quantity to zero to record it later.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="receipt-date">Received date</Label>
            <Input
              id="receipt-date"
              type="date"
              value={receivedDate}
              onChange={(e) => setReceivedDate(e.target.value)}
              data-testid="input-received-date"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="receipt-notes">Notes</Label>
            <Textarea
              id="receipt-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Delivery note number, courier, etc."
              data-testid="input-receipt-notes"
            />
          </div>
        </div>

        {!anySelectable ? (
          <p className="text-sm text-muted-foreground">
            Every line on this order has already been fully received.
          </p>
        ) : (
          <div className="border rounded-md overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12"></TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Ordered</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Remaining</TableHead>
                  <TableHead className="text-right w-32">Receive now</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, idx) => {
                  const disabled = r.remaining <= 0;
                  return (
                    <TableRow
                      key={r.purchaseOrderLineId}
                      data-testid={`row-line-${r.purchaseOrderLineId}`}
                    >
                      <TableCell>
                        <Checkbox
                          checked={r.selected}
                          disabled={disabled}
                          onCheckedChange={(v) =>
                            updateRow(idx, { selected: !!v })
                          }
                          data-testid={`checkbox-line-${r.purchaseOrderLineId}`}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{r.itemName}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.sku}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">{r.ordered}</TableCell>
                      <TableCell className="text-right">
                        {r.alreadyReceived}
                      </TableCell>
                      <TableCell className="text-right">{r.remaining}</TableCell>
                      <TableCell className="text-right">
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          max={r.remaining}
                          value={r.quantity}
                          disabled={disabled || !r.selected}
                          onChange={(e) =>
                            updateRow(idx, { quantity: e.target.value })
                          }
                          className="text-right"
                          data-testid={`input-qty-${r.purchaseOrderLineId}`}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {selectedRows.length} line{selectedRows.length === 1 ? "" : "s"}{" "}
            selected
          </span>
          <span className="font-medium" data-testid="text-total-units">
            Total units: {totalUnits}
          </span>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="btn-cancel-receipt"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={
              createMutation.isPending ||
              !anySelectable ||
              selectedRows.length === 0
            }
            data-testid="btn-submit-receipt"
          >
            {createMutation.isPending ? "Recording..." : "Record receipt"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
