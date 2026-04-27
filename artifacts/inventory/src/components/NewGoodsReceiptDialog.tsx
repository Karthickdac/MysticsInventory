import { useEffect, useMemo, useState } from "react";
import {
  useCreatePurchaseOrderGoodsReceipt,
  getGetPurchaseOrderQueryKey,
  getListPurchaseOrderGoodsReceiptsQueryKey,
  getListStockMovementsQueryKey,
  getListItemsQueryKey,
  lookupItemByCode,
} from "@/lib/queryKeys";
import { BarcodeScannerDialog } from "@/components/BarcodeScannerDialog";
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
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, ScanLine } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

interface OrderLine {
  id: number;
  itemId: number;
  itemName: string;
  sku: string;
  quantity: number;
  quantityReceived: number;
  trackBatches: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  purchaseOrderId: number;
  lines: OrderLine[];
}

type BatchCapture = {
  uid: string;
  batchNumber: string;
  mfgDate: string;
  expiryDate: string;
  costPrice: string;
  quantity: string;
};

type Row = {
  purchaseOrderLineId: number;
  itemId: number;
  itemName: string;
  sku: string;
  ordered: number;
  alreadyReceived: number;
  remaining: number;
  selected: boolean;
  quantity: string;
  trackBatches: boolean;
  batches: BatchCapture[];
};

let uidCounter = 0;
function nextUid() {
  uidCounter += 1;
  return `b-${Date.now()}-${uidCounter}`;
}

function emptyBatch(qty: number): BatchCapture {
  return {
    uid: nextUid(),
    batchNumber: "",
    mfgDate: "",
    expiryDate: "",
    costPrice: "",
    quantity: qty > 0 ? String(qty) : "",
  };
}

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
  const [scannerOpen, setScannerOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setReceivedDate(today);
    setNotes("");
    setRows(
      lines.map((l) => {
        const remaining = Math.max(0, l.quantity - l.quantityReceived);
        return {
          purchaseOrderLineId: l.id,
          itemId: l.itemId,
          itemName: l.itemName,
          sku: l.sku,
          ordered: l.quantity,
          alreadyReceived: l.quantityReceived,
          remaining,
          selected: remaining > 0,
          quantity: remaining > 0 ? String(remaining) : "0",
          trackBatches: l.trackBatches,
          batches: l.trackBatches && remaining > 0 ? [emptyBatch(remaining)] : [],
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

  /**
   * Scanned-barcode handler. Resolves the code to an item via the
   * lookup endpoint and bumps the matching line's quantity by one
   * (or selects a batch-tracked line so the user can fill in the
   * batch details). Toasts when the item isn't on this order.
   */
  const handleScan = async (code: string) => {
    setScannerOpen(false);
    let lookedUp;
    try {
      lookedUp = await lookupItemByCode({ code });
    } catch {
      toast({
        title: "No item found for that code",
        description: `Tried "${code}". Check the barcode is registered on an item.`,
        variant: "destructive",
      });
      return;
    }
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.itemId === lookedUp.id);
      if (idx === -1) {
        toast({
          title: "Item not on this order",
          description: `${lookedUp.name} (${lookedUp.sku}) isn't a line on this purchase order.`,
          variant: "destructive",
        });
        return prev;
      }
      const target = prev[idx];
      if (target.remaining <= 0) {
        toast({
          title: "Already fully received",
          description: `${target.itemName} has no remaining units to receive.`,
        });
        return prev;
      }
      if (target.trackBatches) {
        // Tracked rows need batch numbers — just select so the user
        // sees the batch editor.
        toast({
          title: `${target.itemName} selected`,
          description: "Fill in the batch number and quantity below.",
        });
        return prev.map((r, i) =>
          i === idx ? { ...r, selected: true } : r,
        );
      }
      const current = Number(target.quantity) || 0;
      const next = Math.min(current + 1, target.remaining);
      return prev.map((r, i) =>
        i === idx
          ? { ...r, selected: true, quantity: String(next) }
          : r,
      );
    });
  };

  const updateBatch = (
    rowIdx: number,
    batchIdx: number,
    patch: Partial<BatchCapture>,
  ) => {
    setRows((prev) =>
      prev.map((r, i) =>
        i === rowIdx
          ? {
              ...r,
              batches: r.batches.map((b, bi) =>
                bi === batchIdx ? { ...b, ...patch } : b,
              ),
            }
          : r,
      ),
    );
  };

  const addBatch = (rowIdx: number) => {
    setRows((prev) =>
      prev.map((r, i) =>
        i === rowIdx ? { ...r, batches: [...r.batches, emptyBatch(0)] } : r,
      ),
    );
  };

  const removeBatch = (rowIdx: number, batchIdx: number) => {
    setRows((prev) =>
      prev.map((r, i) =>
        i === rowIdx
          ? {
              ...r,
              batches: r.batches.filter((_, bi) => bi !== batchIdx),
            }
          : r,
      ),
    );
  };

  const anySelectable = rows.some((r) => r.remaining > 0);
  const selectedRows = rows.filter((r) => r.selected);
  const totalUnits = selectedRows.reduce(
    (s, r) =>
      s +
      (r.trackBatches
        ? r.batches.reduce((bs, b) => bs + (Number(b.quantity) || 0), 0)
        : Number(r.quantity || 0)),
    0,
  );

  const handleSubmit = () => {
    const activeRows = selectedRows.filter((r) =>
      r.trackBatches
        ? r.batches.some((b) => Number(b.quantity) > 0)
        : Number(r.quantity) > 0,
    );
    if (activeRows.length === 0) {
      toast({
        title: "Select at least one line",
        variant: "destructive",
      });
      return;
    }
    for (const r of activeRows) {
      if (r.trackBatches) {
        const sum = r.batches.reduce(
          (s, b) => s + (Number(b.quantity) || 0),
          0,
        );
        if (sum <= 0) {
          toast({
            title: `Add at least one batch for ${r.itemName}`,
            variant: "destructive",
          });
          return;
        }
        if (sum - r.remaining > 1e-6) {
          toast({
            title: `Cannot receive more than remaining (${r.remaining}) for ${r.itemName}`,
            variant: "destructive",
          });
          return;
        }
        for (const b of r.batches) {
          const qty = Number(b.quantity);
          if (!Number.isFinite(qty) || qty < 0) {
            toast({
              title: `Invalid batch quantity for ${r.itemName}`,
              variant: "destructive",
            });
            return;
          }
          if (qty > 0 && !b.batchNumber.trim()) {
            toast({
              title: `Batch number is required for ${r.itemName}`,
              variant: "destructive",
            });
            return;
          }
          if (
            b.mfgDate &&
            b.expiryDate &&
            new Date(b.mfgDate).getTime() > new Date(b.expiryDate).getTime()
          ) {
            toast({
              title: `Mfg date must be on or before expiry for ${r.itemName} batch ${b.batchNumber || "(new)"}`,
              variant: "destructive",
            });
            return;
          }
        }
      } else {
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
    }
    createMutation.mutate({
      id: purchaseOrderId,
      data: {
        receivedDate,
        notes: notes.trim() || null,
        lines: activeRows.map((r) => {
          if (r.trackBatches) {
            const usable = r.batches.filter((b) => Number(b.quantity) > 0);
            const sum = usable.reduce(
              (s, b) => s + Number(b.quantity),
              0,
            );
            return {
              purchaseOrderLineId: r.purchaseOrderLineId,
              quantity: sum,
              batches: usable.map((b) => ({
                batchNumber: b.batchNumber.trim(),
                mfgDate: b.mfgDate || null,
                expiryDate: b.expiryDate || null,
                costPrice:
                  b.costPrice.trim() === ""
                    ? null
                    : Number(b.costPrice),
                quantity: Number(b.quantity),
              })),
            };
          }
          return {
            purchaseOrderLineId: r.purchaseOrderLineId,
            quantity: Number(r.quantity),
          };
        }),
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New receipt</DialogTitle>
          <DialogDescription>
            Pick the line quantities the supplier delivered now. Leave a line
            unchecked or set its quantity to zero to record it later.
            Batch-tracked items capture each production batch separately.
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

        {anySelectable && (
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setScannerOpen(true)}
              data-testid="btn-receipt-scan"
            >
              <ScanLine className="mr-2 h-4 w-4" />
              Scan to add
            </Button>
          </div>
        )}

        <BarcodeScannerDialog
          open={scannerOpen}
          onOpenChange={setScannerOpen}
          onDetected={handleScan}
          title="Scan item barcode"
          description="The matching line on this order gets one more unit."
        />

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
                  const batchSum = r.batches.reduce(
                    (s, b) => s + (Number(b.quantity) || 0),
                    0,
                  );
                  return (
                    <>
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
                          <div className="font-medium flex items-center gap-2">
                            {r.itemName}
                            {r.trackBatches && (
                              <Badge variant="secondary">Tracked</Badge>
                            )}
                          </div>
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
                          {r.trackBatches ? (
                            <span
                              className={
                                batchSum > 0
                                  ? "font-medium"
                                  : "text-muted-foreground"
                              }
                              data-testid={`text-batch-sum-${r.purchaseOrderLineId}`}
                            >
                              {batchSum}
                            </span>
                          ) : (
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
                          )}
                        </TableCell>
                      </TableRow>
                      {r.trackBatches && r.selected && !disabled && (
                        <TableRow className="bg-muted/30">
                          <TableCell colSpan={6} className="p-3">
                            <div className="space-y-2">
                              <div className="text-xs font-medium text-muted-foreground">
                                Batches (sum must equal receive quantity)
                              </div>
                              {r.batches.map((b, bi) => (
                                <div
                                  key={b.uid}
                                  className="grid grid-cols-12 gap-2 items-end"
                                  data-testid={`row-batch-${r.purchaseOrderLineId}-${bi}`}
                                >
                                  <div className="col-span-3">
                                    <Label className="text-xs">Batch #</Label>
                                    <Input
                                      value={b.batchNumber}
                                      onChange={(e) =>
                                        updateBatch(idx, bi, {
                                          batchNumber: e.target.value,
                                        })
                                      }
                                      placeholder="e.g. LOT-2026-04"
                                      data-testid={`input-batch-number-${r.purchaseOrderLineId}-${bi}`}
                                    />
                                  </div>
                                  <div className="col-span-2">
                                    <Label className="text-xs">Mfg</Label>
                                    <Input
                                      type="date"
                                      value={b.mfgDate}
                                      onChange={(e) =>
                                        updateBatch(idx, bi, {
                                          mfgDate: e.target.value,
                                        })
                                      }
                                      data-testid={`input-batch-mfg-${r.purchaseOrderLineId}-${bi}`}
                                    />
                                  </div>
                                  <div className="col-span-2">
                                    <Label className="text-xs">Expiry</Label>
                                    <Input
                                      type="date"
                                      value={b.expiryDate}
                                      onChange={(e) =>
                                        updateBatch(idx, bi, {
                                          expiryDate: e.target.value,
                                        })
                                      }
                                      data-testid={`input-batch-exp-${r.purchaseOrderLineId}-${bi}`}
                                    />
                                  </div>
                                  <div className="col-span-2">
                                    <Label className="text-xs">
                                      Unit cost
                                    </Label>
                                    <Input
                                      type="number"
                                      step="0.01"
                                      min="0"
                                      value={b.costPrice}
                                      onChange={(e) =>
                                        updateBatch(idx, bi, {
                                          costPrice: e.target.value,
                                        })
                                      }
                                      placeholder="optional"
                                      data-testid={`input-batch-cost-${r.purchaseOrderLineId}-${bi}`}
                                    />
                                  </div>
                                  <div className="col-span-2">
                                    <Label className="text-xs">Qty</Label>
                                    <Input
                                      type="number"
                                      step="0.01"
                                      min="0"
                                      value={b.quantity}
                                      onChange={(e) =>
                                        updateBatch(idx, bi, {
                                          quantity: e.target.value,
                                        })
                                      }
                                      className="text-right"
                                      data-testid={`input-batch-qty-${r.purchaseOrderLineId}-${bi}`}
                                    />
                                  </div>
                                  <div className="col-span-1 flex justify-end">
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      onClick={() => removeBatch(idx, bi)}
                                      disabled={r.batches.length <= 1}
                                      data-testid={`btn-remove-batch-${r.purchaseOrderLineId}-${bi}`}
                                      aria-label="Remove batch"
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </Button>
                                  </div>
                                </div>
                              ))}
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => addBatch(idx)}
                                data-testid={`btn-add-batch-${r.purchaseOrderLineId}`}
                              >
                                <Plus className="mr-1 h-3 w-3" />
                                Add batch
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </>
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
