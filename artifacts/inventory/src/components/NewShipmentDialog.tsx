import { useEffect, useMemo, useState } from "react";
import {
  useCreateSalesOrderShipment,
  useListItemBatches,
  getGetSalesOrderQueryKey,
  getListSalesOrderShipmentsQueryKey,
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
import { ScanLine } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/format";

interface OrderLine {
  id: number;
  itemId: number;
  itemName: string;
  sku: string;
  quantity: number;
  quantityShipped: number;
  trackBatches: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  salesOrderId: number;
  warehouseId: number;
  lines: OrderLine[];
}

type Pick = {
  itemBatchId: number;
  quantity: string;
};

type Row = {
  salesOrderLineId: number;
  itemId: number;
  itemName: string;
  sku: string;
  ordered: number;
  alreadyShipped: number;
  remaining: number;
  selected: boolean;
  quantity: string;
  trackBatches: boolean;
  picks: Record<number, string>;
};

export function NewShipmentDialog({
  open,
  onOpenChange,
  salesOrderId,
  warehouseId,
  lines,
}: Props) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [shipDate, setShipDate] = useState(today);
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [scannerOpen, setScannerOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setShipDate(today);
    setNotes("");
    setRows(
      lines.map((l) => {
        const remaining = Math.max(0, l.quantity - l.quantityShipped);
        return {
          salesOrderLineId: l.id,
          itemId: l.itemId,
          itemName: l.itemName,
          sku: l.sku,
          ordered: l.quantity,
          alreadyShipped: l.quantityShipped,
          remaining,
          selected: remaining > 0,
          quantity: remaining > 0 ? String(remaining) : "0",
          trackBatches: l.trackBatches,
          picks: {},
        };
      }),
    );
  }, [open, lines, today]);

  const createMutation = useCreateSalesOrderShipment({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getGetSalesOrderQueryKey(salesOrderId),
        });
        queryClient.invalidateQueries({
          queryKey: getListSalesOrderShipmentsQueryKey(salesOrderId),
        });
        queryClient.invalidateQueries({
          queryKey: getListStockMovementsQueryKey(),
        });
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        toast({ title: "Shipment recorded" });
        onOpenChange(false);
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        toast({
          title: "Could not record shipment",
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
   * lookup endpoint and bumps the matching line's ship quantity by
   * one (or selects a batch-tracked line so the user can pick batches).
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
          description: `${lookedUp.name} (${lookedUp.sku}) isn't a line on this sales order.`,
          variant: "destructive",
        });
        return prev;
      }
      const target = prev[idx];
      if (target.remaining <= 0) {
        toast({
          title: "Already fully shipped",
          description: `${target.itemName} has no remaining units to ship.`,
        });
        return prev;
      }
      if (target.trackBatches) {
        toast({
          title: `${target.itemName} selected`,
          description: "Pick a batch below to ship.",
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

  const updatePick = (rowIdx: number, batchId: number, qty: string) => {
    setRows((prev) =>
      prev.map((r, i) =>
        i === rowIdx ? { ...r, picks: { ...r.picks, [batchId]: qty } } : r,
      ),
    );
  };

  const anySelectable = rows.some((r) => r.remaining > 0);
  const selectedRows = rows.filter((r) => r.selected);
  const totalUnits = selectedRows.reduce((s, r) => {
    if (r.trackBatches) {
      return (
        s +
        Object.values(r.picks).reduce(
          (bs, q) => bs + (Number(q) || 0),
          0,
        )
      );
    }
    return s + (Number(r.quantity) || 0);
  }, 0);

  const handleSubmit = () => {
    const activeRows = selectedRows.filter((r) =>
      r.trackBatches
        ? Object.values(r.picks).some((q) => Number(q) > 0)
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
        const sum = Object.values(r.picks).reduce(
          (s, q) => s + (Number(q) || 0),
          0,
        );
        if (sum <= 0) {
          toast({
            title: `Pick at least one batch for ${r.itemName}`,
            variant: "destructive",
          });
          return;
        }
        if (sum - r.remaining > 1e-6) {
          toast({
            title: `Cannot ship more than remaining (${r.remaining}) for ${r.itemName}`,
            variant: "destructive",
          });
          return;
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
            title: `Cannot ship more than remaining (${r.remaining}) for ${r.itemName}`,
            variant: "destructive",
          });
          return;
        }
      }
    }
    createMutation.mutate({
      id: salesOrderId,
      data: {
        shipDate,
        notes: notes.trim() || null,
        lines: activeRows.map((r) => {
          if (r.trackBatches) {
            const usable = Object.entries(r.picks)
              .filter(([, q]) => Number(q) > 0)
              .map(([id, q]) => ({
                itemBatchId: Number(id),
                quantity: Number(q),
              }));
            const sum = usable.reduce((s, p) => s + p.quantity, 0);
            return {
              salesOrderLineId: r.salesOrderLineId,
              quantity: sum,
              batches: usable,
            };
          }
          return {
            salesOrderLineId: r.salesOrderLineId,
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
          <DialogTitle>New shipment</DialogTitle>
          <DialogDescription>
            Pick the line quantities you are shipping now. Leave a line
            unchecked or set its quantity to zero to ship it later.
            Batch-tracked items pick from existing batches at the source
            warehouse, with earliest expiry suggested first.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="ship-date">Ship date</Label>
            <Input
              id="ship-date"
              type="date"
              value={shipDate}
              onChange={(e) => setShipDate(e.target.value)}
              data-testid="input-ship-date"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ship-notes">Notes</Label>
            <Textarea
              id="ship-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Tracking number, courier, etc."
              data-testid="input-ship-notes"
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
              data-testid="btn-shipment-scan"
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
            Every line on this order has already been fully shipped.
          </p>
        ) : (
          <div className="border rounded-md overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12"></TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Ordered</TableHead>
                  <TableHead className="text-right">Shipped</TableHead>
                  <TableHead className="text-right">Remaining</TableHead>
                  <TableHead className="text-right w-32">Ship now</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, idx) => {
                  const disabled = r.remaining <= 0;
                  const pickSum = Object.values(r.picks).reduce(
                    (s, q) => s + (Number(q) || 0),
                    0,
                  );
                  return (
                    <>
                      <TableRow
                        key={r.salesOrderLineId}
                        data-testid={`row-line-${r.salesOrderLineId}`}
                      >
                        <TableCell>
                          <Checkbox
                            checked={r.selected}
                            disabled={disabled}
                            onCheckedChange={(v) =>
                              updateRow(idx, { selected: !!v })
                            }
                            data-testid={`checkbox-line-${r.salesOrderLineId}`}
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
                        <TableCell className="text-right">{r.alreadyShipped}</TableCell>
                        <TableCell className="text-right">{r.remaining}</TableCell>
                        <TableCell className="text-right">
                          {r.trackBatches ? (
                            <span
                              className={
                                pickSum > 0
                                  ? "font-medium"
                                  : "text-muted-foreground"
                              }
                              data-testid={`text-pick-sum-${r.salesOrderLineId}`}
                            >
                              {pickSum}
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
                              data-testid={`input-qty-${r.salesOrderLineId}`}
                            />
                          )}
                        </TableCell>
                      </TableRow>
                      {r.trackBatches && r.selected && !disabled && (
                        <TableRow className="bg-muted/30">
                          <TableCell colSpan={6} className="p-3">
                            <BatchPickerForLine
                              itemId={r.itemId}
                              warehouseId={warehouseId}
                              picks={r.picks}
                              remaining={r.remaining}
                              testIdPrefix={`row-line-${r.salesOrderLineId}`}
                              onPickChange={(batchId, qty) =>
                                updatePick(idx, batchId, qty)
                              }
                              onAutoFillFefo={(suggested) =>
                                updateRow(idx, { picks: suggested })
                              }
                            />
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
            data-testid="btn-cancel-shipment"
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
            data-testid="btn-submit-shipment"
          >
            {createMutation.isPending ? "Recording..." : "Record shipment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface BatchPickerForLineProps {
  itemId: number;
  warehouseId: number;
  picks: Record<number, string>;
  remaining: number;
  testIdPrefix: string;
  onPickChange: (batchId: number, qty: string) => void;
  onAutoFillFefo: (picks: Record<number, string>) => void;
}

export function BatchPickerForLine({
  itemId,
  warehouseId,
  picks,
  remaining,
  testIdPrefix,
  onPickChange,
  onAutoFillFefo,
}: BatchPickerForLineProps) {
  const { data, isLoading } = useListItemBatches(itemId, { warehouseId });
  const onHand = data?.onHand ?? [];

  const fefoFill = () => {
    let need = remaining;
    const next: Record<number, string> = {};
    for (const row of onHand) {
      if (need <= 0) break;
      const take = Math.min(need, row.quantity);
      if (take > 0) {
        next[row.itemBatchId] = String(take);
        need -= take;
      }
    }
    onAutoFillFefo(next);
  };

  if (isLoading) {
    return (
      <p className="text-xs text-muted-foreground">Loading batches…</p>
    );
  }

  if (onHand.length === 0) {
    return (
      <p className="text-xs text-destructive">
        No on-hand batches for this item at the source warehouse. Receive
        stock with a batch first.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-muted-foreground">
          Batches at source (earliest expiry first)
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={fefoFill}
          data-testid={`${testIdPrefix}-btn-fefo`}
        >
          Auto-fill FEFO
        </Button>
      </div>
      <div className="rounded-md border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Batch #</TableHead>
              <TableHead>Mfg</TableHead>
              <TableHead>Expiry</TableHead>
              <TableHead className="text-right">On hand</TableHead>
              <TableHead className="text-right w-32">Pick qty</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {onHand.map((row) => (
              <TableRow
                key={row.itemBatchId}
                data-testid={`${testIdPrefix}-batch-${row.itemBatchId}`}
              >
                <TableCell className="font-mono text-xs">
                  {row.batchNumber}
                </TableCell>
                <TableCell>
                  {row.mfgDate ? formatDate(row.mfgDate) : "-"}
                </TableCell>
                <TableCell>
                  {row.expiryDate ? formatDate(row.expiryDate) : "-"}
                </TableCell>
                <TableCell className="text-right">{row.quantity}</TableCell>
                <TableCell className="text-right">
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    max={row.quantity}
                    value={picks[row.itemBatchId] ?? ""}
                    onChange={(e) =>
                      onPickChange(row.itemBatchId, e.target.value)
                    }
                    className="text-right"
                    data-testid={`${testIdPrefix}-pick-qty-${row.itemBatchId}`}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
