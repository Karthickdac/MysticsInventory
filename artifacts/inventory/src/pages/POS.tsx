import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Trash2, ShoppingCart, Search, Receipt } from "lucide-react";
import {
  lookupPosItems,
  posCheckout,
  useListCustomers,
  downloadCustomerPaymentReceipt,
  type PosLookupItem,
  type PosCheckoutResult,
} from "@/lib/queryKeys";
import { formatCurrency } from "@/lib/format";

type CartLine = {
  itemId: number;
  sku: string;
  name: string;
  unitPrice: number;
  taxRate: number;
  quantity: number;
  isBundle: boolean;
};

type PaymentMode = "cash" | "card" | "upi" | "bank" | "other";
const PAYMENT_LABELS: Record<PaymentMode, string> = {
  cash: "Cash",
  card: "Card",
  upi: "UPI",
  bank: "Bank",
  other: "Other",
};

export default function POS() {
  const { toast } = useToast();
  const scanRef = useRef<HTMLInputElement | null>(null);
  const [scanValue, setScanValue] = useState("");
  const [searchValue, setSearchValue] = useState("");
  const [searchResults, setSearchResults] = useState<PosLookupItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerId, setCustomerId] = useState<string>("walkin");
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("cash");
  const [tendered, setTendered] = useState<string>("");
  const [paymentRef, setPaymentRef] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<PosCheckoutResult | null>(null);
  const [downloadingReceipt, setDownloadingReceipt] = useState(false);

  const { data: customers } = useListCustomers();

  // Autofocus scan box on mount + after every cart change so a barcode
  // gun keeps firing into the right input.
  useEffect(() => {
    scanRef.current?.focus();
  }, [cart.length]);

  // Debounced text search using the lookup endpoint. Skips while a
  // scan is in progress (single Enter == one POST).
  useEffect(() => {
    const q = searchValue.trim();
    if (q.length < 2) {
      setSearchResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = window.setTimeout(async () => {
      try {
        const res = await lookupPosItems({ q, limit: 10 });
        if (!cancelled) setSearchResults(res.items);
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [searchValue]);

  const totals = useMemo(() => {
    let sub = 0;
    let tax = 0;
    for (const l of cart) {
      const lineSub = l.quantity * l.unitPrice;
      sub += lineSub;
      tax += lineSub * (l.taxRate / 100);
    }
    return { subtotal: sub, taxTotal: tax, total: sub + tax };
  }, [cart]);

  function addToCart(item: PosLookupItem) {
    setCart((prev) => {
      const idx = prev.findIndex((l) => l.itemId === item.id);
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = { ...next[idx]!, quantity: next[idx]!.quantity + 1 };
        return next;
      }
      return [
        ...prev,
        {
          itemId: item.id,
          sku: item.sku,
          name: item.name,
          unitPrice: Number(item.salePrice) || 0,
          taxRate: Number(item.taxRate) || 0,
          quantity: 1,
          isBundle: item.isBundle,
        },
      ];
    });
    setSearchValue("");
    setSearchResults([]);
    setScanValue("");
  }

  async function handleScan(e: React.FormEvent) {
    e.preventDefault();
    const code = scanValue.trim();
    if (!code) return;
    try {
      const res = await lookupPosItems({ q: code, limit: 5 });
      // If exactly one match, treat it as a scan hit and add directly.
      if (res.items.length === 1) {
        addToCart(res.items[0]!);
        return;
      }
      if (res.items.length === 0) {
        toast({
          title: "No item",
          description: `Nothing matches "${code}"`,
          variant: "destructive",
        });
        return;
      }
      // Multiple matches → fall through into the dropdown for the user.
      setSearchValue(code);
      setSearchResults(res.items);
      setScanValue("");
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      toast({
        title: "Lookup failed",
        description: e.response?.data?.error ?? "Try again",
        variant: "destructive",
      });
    }
  }

  function updateQty(itemId: number, qty: number) {
    if (!Number.isFinite(qty) || qty <= 0) return;
    setCart((prev) =>
      prev.map((l) => (l.itemId === itemId ? { ...l, quantity: qty } : l)),
    );
  }
  function updatePrice(itemId: number, price: number) {
    if (!Number.isFinite(price) || price < 0) return;
    setCart((prev) =>
      prev.map((l) => (l.itemId === itemId ? { ...l, unitPrice: price } : l)),
    );
  }
  function removeLine(itemId: number) {
    setCart((prev) => prev.filter((l) => l.itemId !== itemId));
  }

  async function handleCheckout() {
    // Re-entry guard: setSubmitting only applies after the next render
    // tick, so a fast double-click can fire two POSTs before the button
    // is disabled. This also guards against Enter held on the keyboard.
    if (submitting) return;
    if (cart.length === 0) {
      toast({ title: "Cart is empty", variant: "destructive" });
      return;
    }
    const tenderedNum = Number(tendered);
    const amount =
      Number.isFinite(tenderedNum) && tenderedNum > 0
        ? tenderedNum
        : totals.total;
    if (!Number.isFinite(amount) || amount <= 0) {
      toast({ title: "Enter a payment amount", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const result = await posCheckout({
        lines: cart.map((l) => ({
          itemId: l.itemId,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxRate: l.taxRate,
        })),
        customerId: customerId === "walkin" ? null : Number(customerId),
        payment: {
          mode: paymentMode,
          amount,
          referenceNumber: paymentRef || null,
        },
      });
      setReceipt(result);
      setCart([]);
      setTendered("");
      setPaymentRef("");
      toast({
        title: `Sale ${result.orderNumber} recorded`,
        description: `Total ${formatCurrency(Number(result.total))}`,
      });
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      toast({
        title: "Checkout failed",
        description: e.response?.data?.error ?? "Try again",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDownloadReceipt() {
    if (!receipt) return;
    setDownloadingReceipt(true);
    try {
      const blob = (await downloadCustomerPaymentReceipt(
        receipt.customerPaymentId,
      )) as unknown as Blob;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `receipt-${receipt.orderNumber}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      toast({ title: "Could not download receipt", variant: "destructive" });
    } finally {
      setDownloadingReceipt(false);
    }
  }

  const change = (() => {
    const t = Number(tendered);
    if (!Number.isFinite(t) || t <= 0) return 0;
    return Math.max(0, t - totals.total);
  })();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Point of Sale"
        description="Scan or search items, take payment, and record the sale."
      />
      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShoppingCart className="h-4 w-4" />
              Cart
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <form onSubmit={handleScan} className="flex gap-2">
              <Input
                ref={scanRef}
                value={scanValue}
                onChange={(e) => setScanValue(e.target.value)}
                placeholder="Scan barcode or type code, then Enter"
                data-testid="input-pos-scan"
                autoComplete="off"
              />
              <Button type="submit" data-testid="btn-pos-scan-add">
                Add
              </Button>
            </form>
            <div className="relative">
              <div className="relative">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  value={searchValue}
                  onChange={(e) => setSearchValue(e.target.value)}
                  placeholder="Search by name or SKU"
                  className="pl-9"
                  data-testid="input-pos-search"
                />
              </div>
              {searchResults.length > 0 && (
                <div className="absolute z-10 mt-1 w-full rounded-md border bg-popover shadow-md max-h-72 overflow-auto">
                  {searchResults.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => addToCart(r)}
                      className="block w-full px-3 py-2 text-left hover:bg-accent text-sm"
                      data-testid={`btn-pos-add-${r.id}`}
                    >
                      <div className="flex justify-between gap-3">
                        <span className="truncate font-medium">{r.name}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {formatCurrency(Number(r.salePrice) || 0)}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {r.sku} · on hand {r.onHand}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {searching && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Searching…
                </p>
              )}
            </div>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead className="w-24 text-right">Qty</TableHead>
                    <TableHead className="w-32 text-right">Price</TableHead>
                    <TableHead className="w-24 text-right">Total</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cart.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center text-sm text-muted-foreground py-6"
                      >
                        Cart is empty. Scan or search to add items.
                      </TableCell>
                    </TableRow>
                  )}
                  {cart.map((l) => (
                    <TableRow key={l.itemId} data-testid={`row-cart-${l.itemId}`}>
                      <TableCell>
                        <div className="font-medium">{l.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {l.sku}
                          {l.isBundle ? " · bundle" : ""}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Input
                          type="number"
                          min={0.001}
                          step={1}
                          value={l.quantity}
                          onChange={(e) =>
                            updateQty(l.itemId, Number(e.target.value))
                          }
                          className="h-8 w-20 text-right"
                          data-testid={`input-cart-qty-${l.itemId}`}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          value={l.unitPrice}
                          onChange={(e) =>
                            updatePrice(l.itemId, Number(e.target.value))
                          }
                          className="h-8 w-28 text-right"
                          data-testid={`input-cart-price-${l.itemId}`}
                        />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(l.quantity * l.unitPrice)}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeLine(l.itemId)}
                          aria-label="Remove"
                          data-testid={`btn-cart-remove-${l.itemId}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tender</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Customer</Label>
              <Select value={customerId} onValueChange={setCustomerId}>
                <SelectTrigger data-testid="select-pos-customer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="walkin">Walk-in customer</SelectItem>
                  {(customers ?? []).map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Payment mode</Label>
              <div className="grid grid-cols-3 gap-2">
                {(Object.keys(PAYMENT_LABELS) as PaymentMode[]).map((m) => (
                  <Button
                    key={m}
                    type="button"
                    variant={paymentMode === m ? "default" : "outline"}
                    onClick={() => setPaymentMode(m)}
                    data-testid={`btn-pos-mode-${m}`}
                  >
                    {PAYMENT_LABELS[m]}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pos-tendered">Tendered</Label>
              <Input
                id="pos-tendered"
                type="number"
                step="0.01"
                min={0}
                value={tendered}
                onChange={(e) => setTendered(e.target.value)}
                placeholder={`Default ${formatCurrency(totals.total)}`}
                data-testid="input-pos-tendered"
              />
            </div>
            {paymentMode !== "cash" && (
              <div className="space-y-1.5">
                <Label htmlFor="pos-ref">Reference</Label>
                <Input
                  id="pos-ref"
                  value={paymentRef}
                  onChange={(e) => setPaymentRef(e.target.value)}
                  placeholder="Txn / UTR / last 4 digits"
                  data-testid="input-pos-reference"
                />
              </div>
            )}
            <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-1.5 tabular-nums">
              <Row label="Subtotal" value={totals.subtotal} />
              <Row label="Tax" value={totals.taxTotal} />
              <div className="border-t pt-1.5">
                <Row label="Total" value={totals.total} bold />
              </div>
              {change > 0 && (
                <Row label="Change due" value={change} muted />
              )}
            </div>
            <Button
              className="w-full"
              size="lg"
              disabled={submitting || cart.length === 0}
              onClick={handleCheckout}
              data-testid="btn-pos-checkout"
            >
              {submitting ? "Recording…" : `Charge ${formatCurrency(totals.total)}`}
            </Button>
          </CardContent>
        </Card>
      </div>

      <Dialog open={!!receipt} onOpenChange={(o) => !o && setReceipt(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Receipt className="h-5 w-5" />
              Sale recorded
            </DialogTitle>
            <DialogDescription>
              {receipt &&
                `${receipt.orderNumber} · ${formatCurrency(Number(receipt.total))}`}
            </DialogDescription>
          </DialogHeader>
          {receipt && (
            <div className="text-sm space-y-1">
              <p>Stock for the sold items has been reduced.</p>
              <p>
                <Link
                  href={`/sales-orders/${receipt.salesOrderId}`}
                  className="text-primary hover:underline"
                >
                  Open sales order #{receipt.salesOrderId}
                </Link>
              </p>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={handleDownloadReceipt}
              disabled={downloadingReceipt || !receipt}
              data-testid="btn-pos-download-receipt"
            >
              {downloadingReceipt ? "Downloading…" : "Download receipt PDF"}
            </Button>
            <Button onClick={() => setReceipt(null)} data-testid="btn-pos-new-sale">
              New sale
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row({
  label,
  value,
  bold,
  muted,
}: {
  label: string;
  value: number;
  bold?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={`flex justify-between ${bold ? "font-semibold text-base" : ""} ${muted ? "text-muted-foreground" : ""}`}
    >
      <span>{label}</span>
      <span>{formatCurrency(value)}</span>
    </div>
  );
}
