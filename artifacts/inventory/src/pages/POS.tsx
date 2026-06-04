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
import { Trash2, ShoppingCart, Search, Receipt, Printer, ScanLine, ShoppingBag, Plus, Minus } from "lucide-react";
import {
  lookupPosItems,
  posCheckout,
  downloadCustomerPaymentReceipt,
  useGetCurrentOrganization,
  useGetMe,
  type PosLookupItem,
  type PosCheckoutResult,
} from "@/lib/queryKeys";
import { useListWarehouses } from "@workspace/api-client-react";
import { BarcodeScannerDialog } from "@/components/BarcodeScannerDialog";
import { useImageSrc } from "@/hooks/use-image-src";
import { formatCurrency } from "@/lib/format";

type CartLine = {
  itemId: number;
  sku: string;
  name: string;
  // Item's listed sale price at the time it was added — kept so we
  // can flag manual price-overrides ("already discounted" badge).
  listPrice: number;
  unitPrice: number;
  taxRate: number;
  quantity: number;
  isBundle: boolean;
  // Per-line manual discount the cashier applied. Operator enters
  // EITHER a percent (0-100) or a flat amount — `discountMode` tracks
  // which input is active so the other is rendered disabled.
  discountMode: "percent" | "amount";
  discountPercent: number;
  discountAmount: number;
};

function effectiveDiscount(l: CartLine): number {
  const gross = l.quantity * l.unitPrice;
  if (l.discountMode === "percent") {
    const pct = Math.max(0, Math.min(100, l.discountPercent));
    return Math.min(gross, Math.round((gross * pct) / 100 * 100) / 100);
  }
  return Math.max(0, Math.min(gross, l.discountAmount));
}

type PaymentMode = "cash" | "upi" | "card" | "bank" | "other";
type SaleChannel =
  | "walkin"
  | "website"
  | "store"
  | "whatsapp"
  | "phone"
  | "instagram"
  | "other";
const SALE_CHANNEL_LABELS: Record<SaleChannel, string> = {
  walkin: "Walk-in",
  website: "Website",
  store: "Store",
  whatsapp: "WhatsApp",
  phone: "Phone",
  instagram: "Instagram",
  other: "Other",
};
// Insertion order matters — this is what the UI iterates over to render
// the payment-mode buttons. Cash / UPI / Card lead because they cover
// the vast majority of Indian retail tender.
const PAYMENT_LABELS: Record<PaymentMode, string> = {
  cash: "Cash",
  upi: "UPI",
  card: "Card",
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
  const [walkinName, setWalkinName] = useState("");
  const [walkinPhone, setWalkinPhone] = useState("");
  const [saleChannel, setSaleChannel] = useState<SaleChannel>("walkin");
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("cash");
  const [tendered, setTendered] = useState<string>("");
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const { data: warehouses } = useListWarehouses();
  // Pick the org's default warehouse on first load. Falls back to the
  // first non-virtual warehouse if no row is flagged default.
  useEffect(() => {
    if (warehouseId != null || !warehouses || warehouses.length === 0) return;
    const visible = warehouses.filter((w) => !w.isVirtual);
    const def = visible.find((w) => w.isDefault) ?? visible[0];
    if (def) setWarehouseId(def.id);
  }, [warehouses, warehouseId]);
  const [paymentRef, setPaymentRef] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<PosCheckoutResult | null>(null);
  const [downloadingReceipt, setDownloadingReceipt] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [bagsDialogOpen, setBagsDialogOpen] = useState(false);
  const [bagsList, setBagsList] = useState<PosLookupItem[]>([]);
  const [bagsLoading, setBagsLoading] = useState(false);
  const [bagQtys, setBagQtys] = useState<Record<number, number>>({});

  async function openBagsDialog() {
    setBagsDialogOpen(true);
    setBagsLoading(true);
    try {
      const res = await lookupPosItems({
        bags: 1,
        limit: 50,
        ...(warehouseId != null ? { warehouseId } : {}),
      } as unknown as Parameters<typeof lookupPosItems>[0]);
      setBagsList(res.items.filter((i) => (i as { isBag?: boolean }).isBag));
      setBagQtys({});
    } catch {
      setBagsList([]);
    } finally {
      setBagsLoading(false);
    }
  }

  function addBagsToCart() {
    const toAdd = Object.entries(bagQtys).filter(([, q]) => q > 0);
    if (toAdd.length === 0) {
      setBagsDialogOpen(false);
      return;
    }
    for (const [idStr, qty] of toAdd) {
      const id = Number(idStr);
      const item = bagsList.find((b) => b.id === id);
      if (!item) continue;
      const list = Number(item.salePrice) || 0;
      setCart((prev) => {
        const idx = prev.findIndex((l) => l.itemId === id);
        if (idx >= 0) {
          const next = prev.slice();
          next[idx] = {
            ...next[idx]!,
            quantity: next[idx]!.quantity + qty,
          };
          return next;
        }
        return [
          ...prev,
          {
            itemId: item.id,
            sku: item.sku,
            name: item.name,
            listPrice: list,
            unitPrice: list,
            taxRate: Number(item.taxRate) || 0,
            quantity: qty,
            isBundle: item.isBundle,
            discountMode: "percent",
            discountPercent: 0,
            discountAmount: 0,
          },
        ];
      });
    }
    setBagsDialogOpen(false);
  }

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
        const res = await lookupPosItems({
          q,
          limit: 10,
          ...(warehouseId != null ? { warehouseId } : {}),
        });
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
    let discount = 0;
    for (const l of cart) {
      const gross = l.quantity * l.unitPrice;
      const d = effectiveDiscount(l);
      const lineSub = gross - d;
      sub += lineSub;
      tax += lineSub * (l.taxRate / 100);
      discount += d;
    }
    return { subtotal: sub, taxTotal: tax, total: sub + tax, discountTotal: discount };
  }, [cart]);

  function addToCart(item: PosLookupItem) {
    setCart((prev) => {
      const idx = prev.findIndex((l) => l.itemId === item.id);
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = { ...next[idx]!, quantity: next[idx]!.quantity + 1 };
        return next;
      }
      const list = Number(item.salePrice) || 0;
      return [
        ...prev,
        {
          itemId: item.id,
          sku: item.sku,
          name: item.name,
          listPrice: list,
          unitPrice: list,
          taxRate: Number(item.taxRate) || 0,
          quantity: 1,
          isBundle: item.isBundle,
          discountMode: "percent",
          discountPercent: 0,
          discountAmount: 0,
        },
      ];
    });
    setSearchValue("");
    setSearchResults([]);
    setScanValue("");
  }

  async function lookupAndAdd(code: string) {
    try {
      const res = await lookupPosItems({
        q: code,
        limit: 5,
        ...(warehouseId != null ? { warehouseId } : {}),
      });
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
      toast({
        title: "Lookup failed",
        description: extractApiErrorMessage(err),
        variant: "destructive",
      });
    }
  }

  async function handleScan(e: React.FormEvent) {
    e.preventDefault();
    const code = scanValue.trim();
    if (!code) return;
    await lookupAndAdd(code);
  }

  function handleCameraScanned(code: string) {
    setScannerOpen(false);
    void lookupAndAdd(code);
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
  function updateDiscount(
    itemId: number,
    patch: Partial<Pick<CartLine, "discountMode" | "discountPercent" | "discountAmount">>,
  ) {
    setCart((prev) =>
      prev.map((l) => (l.itemId === itemId ? { ...l, ...patch } : l)),
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
    if (!walkinName.trim()) {
      toast({ title: "Customer name is required", variant: "destructive" });
      return;
    }
    if (!walkinPhone.trim()) {
      toast({ title: "Phone is required", variant: "destructive" });
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
          ...(l.discountMode === "percent" && l.discountPercent > 0
            ? { discountPercent: l.discountPercent }
            : {}),
          ...(l.discountMode === "amount" && l.discountAmount > 0
            ? { discountAmount: l.discountAmount }
            : {}),
        })),
        customerId: null,
        customerName: walkinName.trim(),
        customerPhone: walkinPhone.trim(),
        saleChannel,
        warehouseId: warehouseId ?? undefined,
        payment: {
          mode: paymentMode,
          amount,
          referenceNumber: paymentRef || null,
        },
      });
      setReceipt({
        ...result,
        // Snapshot the cart on the receipt so the thermal print
        // dialog has line-level data even after the cart is cleared.
        _lines: cart.map((l) => ({ ...l })),
        _payment: { mode: paymentMode, amount, tendered: Number(tendered) || amount },
        _walkin: { name: walkinName.trim(), phone: walkinPhone.trim() },
        _channel: saleChannel,
      } as PosCheckoutResult & {
        _lines: CartLine[];
        _payment: { mode: PaymentMode; amount: number; tendered: number };
        _walkin: { name: string; phone: string } | null;
        _channel: SaleChannel;
      });
      setCart([]);
      setTendered("");
      setPaymentRef("");
      setWalkinName("");
      setWalkinPhone("");
      setSaleChannel("walkin");
      toast({
        title: `Sale ${result.orderNumber} recorded`,
        description: `Total ${formatCurrency(Number(result.total))}`,
      });
    } catch (err) {
      toast({
        title: "Checkout failed",
        description: extractApiErrorMessage(err),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  // Pull a human-readable error string out of whatever the fetch
  // wrapper threw. The generated client throws an `ApiError` whose
  // parsed JSON body lives at `err.data` (NOT `err.response.data` —
  // that older shape was from axios). We probe a few common keys
  // (`error`, `message`, `detail`) so the user sees the actual
  // backend reason ("Insufficient stock for SKU: need 5, on hand
  // 0") instead of a generic "Try again".
  function extractApiErrorMessage(err: unknown): string {
    const e = err as {
      data?: { error?: string; message?: string; detail?: string } | string | null;
      message?: string;
      response?: { data?: { error?: string } };
    };
    if (e?.data && typeof e.data === "object") {
      return (
        e.data.error ?? e.data.message ?? e.data.detail ?? e.message ?? "Try again"
      );
    }
    if (typeof e?.data === "string" && e.data.trim()) return e.data;
    if (e?.response?.data?.error) return e.response.data.error;
    if (e?.message) return e.message;
    return "Try again";
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
    } catch (err) {
      toast({
        title: "Could not download receipt",
        description: extractApiErrorMessage(err),
        variant: "destructive",
      });
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
              <Button
                type="button"
                variant="outline"
                onClick={() => setScannerOpen(true)}
                data-testid="btn-pos-scan-camera"
                aria-label="Scan with camera"
              >
                <ScanLine className="h-4 w-4" />
              </Button>
              <Button type="submit" data-testid="btn-pos-scan-add">
                Add
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={openBagsDialog}
                data-testid="btn-pos-bags"
                aria-label="Add bags"
                title="Add carry-bags"
              >
                <ShoppingBag className="h-4 w-4" />
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
                    <TableHead className="w-20 text-right">Qty</TableHead>
                    <TableHead className="w-28 text-right">Price</TableHead>
                    <TableHead className="w-36 text-right">Discount</TableHead>
                    <TableHead className="w-24 text-right">Total</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cart.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="text-center text-sm text-muted-foreground py-6"
                      >
                        Cart is empty. Scan or search to add items.
                      </TableCell>
                    </TableRow>
                  )}
                  {cart.map((l) => {
                    const gross = l.quantity * l.unitPrice;
                    const disc = effectiveDiscount(l);
                    const lineTotal = gross - disc;
                    const priceReduced = l.unitPrice + 1e-9 < l.listPrice;
                    return (
                    <TableRow key={l.itemId} data-testid={`row-cart-${l.itemId}`}>
                      <TableCell>
                        <div className="font-medium">{l.name}</div>
                        <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-1.5">
                          <span>{l.sku}</span>
                          {l.isBundle && <span>· bundle</span>}
                          {priceReduced && (
                            <span
                              className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                              data-testid={`badge-price-reduced-${l.itemId}`}
                              title={`List price ${formatCurrency(l.listPrice)}`}
                            >
                              Price reduced
                            </span>
                          )}
                          {disc > 0 && (
                            <span
                              className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
                              data-testid={`badge-discounted-${l.itemId}`}
                            >
                              Discount {formatCurrency(disc)}
                            </span>
                          )}
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
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            value={
                              l.discountMode === "percent"
                                ? l.discountPercent || ""
                                : l.discountAmount || ""
                            }
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              if (!Number.isFinite(v) || v < 0) return;
                              if (l.discountMode === "percent") {
                                updateDiscount(l.itemId, {
                                  discountPercent: Math.min(100, v),
                                });
                              } else {
                                updateDiscount(l.itemId, { discountAmount: v });
                              }
                            }}
                            className="h-8 w-20 text-right"
                            placeholder="0"
                            data-testid={`input-cart-discount-${l.itemId}`}
                          />
                          <Select
                            value={l.discountMode}
                            onValueChange={(v) =>
                              updateDiscount(l.itemId, {
                                discountMode: v as "percent" | "amount",
                                ...(v === "percent"
                                  ? { discountAmount: 0 }
                                  : { discountPercent: 0 }),
                              })
                            }
                          >
                            <SelectTrigger
                              className="h-8 w-14 px-2"
                              data-testid={`select-cart-discount-mode-${l.itemId}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="percent">%</SelectItem>
                              <SelectItem value="amount">₹</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {disc > 0 && (
                          <div className="text-[11px] text-muted-foreground line-through">
                            {formatCurrency(gross)}
                          </div>
                        )}
                        <div>{formatCurrency(lineTotal)}</div>
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
                    );
                  })}
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
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="pos-walkin-name">Customer name</Label>
                <Input
                  id="pos-walkin-name"
                  value={walkinName}
                  onChange={(e) => setWalkinName(e.target.value)}
                  placeholder="e.g. Rahul Sharma"
                  maxLength={200}
                  data-testid="input-pos-walkin-name"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pos-walkin-phone">Phone</Label>
                <Input
                  id="pos-walkin-phone"
                  type="tel"
                  value={walkinPhone}
                  onChange={(e) => setWalkinPhone(e.target.value)}
                  placeholder="9876543210"
                  maxLength={50}
                  data-testid="input-pos-walkin-phone"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pos-warehouse">Warehouse</Label>
              <Select
                value={warehouseId != null ? String(warehouseId) : ""}
                onValueChange={(v) => setWarehouseId(Number(v))}
                disabled={!warehouses || warehouses.length === 0}
              >
                <SelectTrigger
                  id="pos-warehouse"
                  data-testid="select-pos-warehouse"
                >
                  <SelectValue placeholder="Select warehouse" />
                </SelectTrigger>
                <SelectContent>
                  {(warehouses ?? [])
                    .filter((w) => !w.isVirtual)
                    .map((w) => (
                      <SelectItem
                        key={w.id}
                        value={String(w.id)}
                        data-testid={`option-pos-warehouse-${w.id}`}
                      >
                        {w.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pos-channel">Mode of sale</Label>
              <Select
                value={saleChannel}
                onValueChange={(v) => setSaleChannel(v as SaleChannel)}
              >
                <SelectTrigger
                  id="pos-channel"
                  data-testid="select-pos-channel"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(SALE_CHANNEL_LABELS) as SaleChannel[]).map((c) => (
                    <SelectItem
                      key={c}
                      value={c}
                      data-testid={`option-pos-channel-${c}`}
                    >
                      {SALE_CHANNEL_LABELS[c]}
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
              onClick={() => window.print()}
              disabled={!receipt}
              data-testid="btn-pos-thermal-print"
            >
              <Printer className="mr-2 h-4 w-4" />
              Thermal Print
            </Button>
            <Button
              variant="outline"
              onClick={handleDownloadReceipt}
              disabled={downloadingReceipt || !receipt}
              data-testid="btn-pos-download-receipt"
            >
              {downloadingReceipt ? "Downloading…" : "Download PDF"}
            </Button>
            <Button onClick={() => setReceipt(null)} data-testid="btn-pos-new-sale">
              New sale
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        Hidden thermal receipt — only revealed by `@media print`.
        Width is 72mm (sized to print cleanly on 80mm rolls; will also
        fit 58mm with a slight scale-down at the printer driver level).
        Plain monospace font, no shadows/gradients/colors so cheap
        receipt printers render it crisply.
      */}
      <ThermalReceipt receipt={receipt} />

      <Dialog open={bagsDialogOpen} onOpenChange={setBagsDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShoppingBag className="h-5 w-5" />
              Add carry-bags
            </DialogTitle>
            <DialogDescription>
              Pick how many of each bag the customer is taking. Stock is
              deducted on checkout like any other item.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-auto space-y-2">
            {bagsLoading && (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
            {!bagsLoading && bagsList.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No items are marked as bags yet. Edit an item and tick
                "This item is a packaging bag" to add one.
              </p>
            )}
            {bagsList.map((b) => {
              const qty = bagQtys[b.id] ?? 0;
              const setQ = (v: number) =>
                setBagQtys((prev) => ({
                  ...prev,
                  [b.id]: Math.max(0, v),
                }));
              return (
                <div
                  key={b.id}
                  className="flex items-center justify-between gap-3 rounded-md border p-2"
                  data-testid={`row-bag-${b.id}`}
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{b.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {b.sku} · {formatCurrency(Number(b.salePrice) || 0)} · on hand {b.onHand}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-8 w-8"
                      onClick={() => setQ(qty - 1)}
                      disabled={qty <= 0}
                      data-testid={`btn-bag-dec-${b.id}`}
                    >
                      <Minus className="h-3 w-3" />
                    </Button>
                    <Input
                      type="number"
                      min={0}
                      value={qty}
                      onChange={(e) => setQ(Number(e.target.value) || 0)}
                      className="h-8 w-14 text-center"
                      data-testid={`input-bag-qty-${b.id}`}
                    />
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-8 w-8"
                      onClick={() => setQ(qty + 1)}
                      data-testid={`btn-bag-inc-${b.id}`}
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBagsDialogOpen(false)}
              data-testid="btn-bags-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={addBagsToCart}
              disabled={bagsLoading}
              data-testid="btn-bags-add"
            >
              Add to cart
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BarcodeScannerDialog
        open={scannerOpen}
        onOpenChange={setScannerOpen}
        onDetected={handleCameraScanned}
        title="Scan item barcode"
        description="Point your camera at the item's barcode."
      />
    </div>
  );
}

type ThermalReceiptData = PosCheckoutResult & {
  _lines?: CartLine[];
  _payment?: { mode: PaymentMode; amount: number; tendered: number };
  _walkin?: { name: string; phone: string } | null;
  _channel?: SaleChannel;
};

// Format a JS Date as "DD.MM.YYYY, hh.mm am/pm" to match the printed
// retail-invoice style (e.g. "04.06.2026, 09.00 pm").
function formatReceiptDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  let h = d.getHours();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${pad(h)}.${pad(d.getMinutes())} ${ampm}`;
}

function ThermalReceipt({ receipt }: { receipt: PosCheckoutResult | null }) {
  const r = receipt as ThermalReceiptData | null;
  const { data: org } = useGetCurrentOrganization();
  const { data: me } = useGetMe();
  const { src: logoSrc } = useImageSrc(org?.logoUrl);

  const lines = r?._lines ?? [];
  const grossSum = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  const totalDisc = lines.reduce((s, l) => s + effectiveDiscount(l), 0);
  const totalQty = lines.reduce((s, l) => s + l.quantity, 0);

  const cityLine = [org?.city, org?.state, org?.postalCode]
    .filter((p) => p && p.trim())
    .join(" ");
  const addressParts = [
    org?.addressLine1,
    org?.addressLine2,
    cityLine,
    org?.country,
  ].filter((p): p is string => !!p && p.trim().length > 0);

  const staffName = me?.user?.name || me?.user?.email || "";
  const tax = r ? Number(r.taxTotal) : 0;
  const total = r ? Number(r.total) : 0;
  const paymentLabel = r?._payment ? PAYMENT_LABELS[r._payment.mode] : "Cash";
  const amountPaid = r?._payment?.amount ?? total;
  const tendered = r?._payment?.tendered ?? amountPaid;
  const change = Math.max(0, tendered - total);
  const balanceDue = Math.max(0, total - amountPaid);

  return (
    <>
      <style>{`
        @media print {
          /* Hide the entire app shell and only show the receipt. */
          body * { visibility: hidden !important; }
          #pos-thermal-receipt, #pos-thermal-receipt * { visibility: visible !important; }
          #pos-thermal-receipt {
            display: block !important;
            position: absolute !important;
            left: 0; top: 0;
            width: 72mm;
            padding: 3mm 4mm;
            font-family: Georgia, 'Times New Roman', serif;
            font-size: 9pt;
            line-height: 1.35;
            color: #000;
            background: #fff;
          }
          @page { size: 72mm auto; margin: 0; }
        }
        #pos-thermal-receipt { display: none; }
        #pos-thermal-receipt .center { text-align: center; }
        #pos-thermal-receipt .bold { font-weight: 700; }
        #pos-thermal-receipt .small { font-size: 8pt; }
        #pos-thermal-receipt .xs { font-size: 7pt; }
        #pos-thermal-receipt .logo {
          max-width: 38mm; max-height: 20mm; object-fit: contain;
          margin: 0 auto 1mm; display: block;
        }
        #pos-thermal-receipt .biz-name {
          font-size: 15pt; font-weight: 700; letter-spacing: 0.3px; margin-top: 1mm;
        }
        #pos-thermal-receipt .title {
          font-size: 11pt; font-weight: 700; margin: 1.5mm 0 0.5mm;
        }
        #pos-thermal-receipt .sep { border-top: 1px dashed #000; margin: 1.5mm 0; }
        #pos-thermal-receipt .kv { display: flex; gap: 2mm; }
        #pos-thermal-receipt .kv > span:first-child { width: 28mm; flex-shrink: 0; }
        #pos-thermal-receipt table { width: 100%; border-collapse: collapse; }
        #pos-thermal-receipt th, #pos-thermal-receipt td {
          text-align: left; padding: 0.6mm 0; vertical-align: top;
        }
        #pos-thermal-receipt th.r, #pos-thermal-receipt td.r { text-align: right; }
        #pos-thermal-receipt thead th { border-bottom: 1px solid #000; }
        #pos-thermal-receipt tfoot td { padding-top: 1mm; }
        #pos-thermal-receipt .total-row td {
          border-top: 1px solid #000; font-size: 11.5pt; font-weight: 700; padding-top: 1mm;
        }
        #pos-thermal-receipt .footer-web {
          font-weight: 700; font-size: 11pt; margin-top: 1mm;
        }
      `}</style>
      <div id="pos-thermal-receipt">
        {r && (
          <>
            {logoSrc && (
              <img src={logoSrc} alt="" className="logo" />
            )}
            {org?.name && <div className="center biz-name">{org.name}</div>}
            {addressParts.map((p, i) => (
              <div className="center small" key={i}>
                {p}
              </div>
            ))}
            {org?.gstNumber && (
              <div className="center small">GSTIN : {org.gstNumber}</div>
            )}
            <div className="center title">Retail Invoice</div>
            <div className="sep" />
            <div className="kv">
              <span>Date</span>
              <span>: {formatReceiptDateTime(new Date())}</span>
            </div>
            <div className="kv">
              <span>Bill No</span>
              <span>: {r.orderNumber}</span>
            </div>
            {staffName && (
              <div className="kv">
                <span>Staff Name</span>
                <span>: {staffName}</span>
              </div>
            )}
            {r._walkin?.name && (
              <div className="kv bold">
                <span>Customer Name</span>
                <span>: {r._walkin.name}</span>
              </div>
            )}
            {r._walkin?.phone && (
              <div className="kv bold">
                <span>Phone Number</span>
                <span>: {r._walkin.phone}</span>
              </div>
            )}
            <div className="sep" />
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="r">Qty</th>
                  <th className="r">Amount</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.itemId}>
                    <td>
                      {l.name}
                      <div className="xs">{l.sku}</div>
                    </td>
                    <td className="r">{l.quantity}</td>
                    <td className="r">{(l.quantity * l.unitPrice).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="bold">Sub Total</td>
                  <td className="r bold">{totalQty}</td>
                  <td className="r bold">{grossSum.toFixed(2)}</td>
                </tr>
                {totalDisc > 0 && (
                  <tr>
                    <td>(-) Discount</td>
                    <td />
                    <td className="r">{totalDisc.toFixed(2)}</td>
                  </tr>
                )}
                {tax > 0 && (
                  <tr>
                    <td>Tax</td>
                    <td />
                    <td className="r">{tax.toFixed(2)}</td>
                  </tr>
                )}
                <tr className="total-row">
                  <td>TOTAL</td>
                  <td />
                  <td className="r">RS {total.toFixed(2)}</td>
                </tr>
              </tfoot>
            </table>
            <div className="sep" />
            <div className="kv">
              <span>{paymentLabel}</span>
              <span>: RS {amountPaid.toFixed(2)}</span>
            </div>
            <div className="kv">
              <span>{paymentLabel} Tendered</span>
              <span>: RS {tendered.toFixed(2)}</span>
            </div>
            {change > 0 && (
              <div className="kv">
                <span>Change</span>
                <span>: RS {change.toFixed(2)}</span>
              </div>
            )}
            {balanceDue > 0.005 && (
              <div className="kv bold">
                <span>Balance Due</span>
                <span>: RS {balanceDue.toFixed(2)}</span>
              </div>
            )}
            <div className="sep" />
            {org?.invoiceFooter && (
              <div className="center footer-web">{org.invoiceFooter}</div>
            )}
            <div className="center small">Thank you for your purchase</div>
            {tax <= 0 && (
              <div className="center xs">
                All prices are inclusive of applicable taxes.
              </div>
            )}
            <div className="center xs">This is a Computer Generated Invoice</div>
          </>
        )}
      </div>
    </>
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
