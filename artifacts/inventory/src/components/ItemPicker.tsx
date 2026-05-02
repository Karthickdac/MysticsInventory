import { useMemo } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FormControl, FormItem, FormLabel, FormMessage } from "@/components/ui/form";

export type ItemForPicker = {
  id: number;
  sku: string;
  name: string;
  hasVariants?: boolean;
  parentItemId?: number | null;
  variantOptions?: Record<string, unknown> | null;
  salePrice?: number;
  purchasePrice?: number;
  taxRate?: number;
  description?: string | null;
  stockAtWarehouse?: number | null;
};

type Props = {
  items: ItemForPicker[];
  selectedItemId: number | null;
  parentSelection: number | null;
  onParentChange: (parentId: number | null) => void;
  onVariantChange: (itemId: number) => void;
  testIdPrefix: string;
  disabled?: boolean;
  errorMessage?: string;
  showStockHint?: boolean;
  /** Placeholder shown when the picker is disabled (e.g. waiting for a
   *  warehouse to be picked first). Overrides the default "Select item". */
  disabledMessage?: string;
  /** Placeholder shown when the picker is enabled but no items are available
   *  (e.g. no items in stock at the chosen warehouse). */
  emptyMessage?: string;
};

function variantLabel(opts: Record<string, unknown> | null | undefined): string {
  if (!opts) return "";
  const parts = Object.entries(opts)
    .filter(([k]) => k !== "axes")
    .map(([, v]) => (typeof v === "string" ? v : ""))
    .filter(Boolean);
  return parts.join(" / ");
}

export function ItemPicker({
  items,
  selectedItemId,
  parentSelection,
  onParentChange,
  onVariantChange,
  testIdPrefix,
  disabled,
  errorMessage,
  showStockHint,
  disabledMessage,
  emptyMessage,
}: Props) {
  const { topLevel, childrenByParent } = useMemo(() => {
    const top: ItemForPicker[] = [];
    const byParent = new Map<number, ItemForPicker[]>();
    for (const i of items) {
      if (i.parentItemId == null) {
        top.push(i);
      } else {
        const arr = byParent.get(i.parentItemId) ?? [];
        arr.push(i);
        byParent.set(i.parentItemId, arr);
      }
    }
    return { topLevel: top, childrenByParent: byParent };
  }, [items]);

  const effectiveParentId = (() => {
    if (parentSelection != null) return parentSelection;
    if (selectedItemId == null) return null;
    const cur = items.find((i) => i.id === selectedItemId);
    if (!cur) return null;
    return cur.parentItemId ?? cur.id;
  })();

  const parentItem =
    effectiveParentId != null
      ? items.find((i) => i.id === effectiveParentId) ?? null
      : null;
  const variants =
    parentItem && parentItem.hasVariants
      ? childrenByParent.get(parentItem.id) ?? []
      : [];

  return (
    <div className="space-y-2">
      <FormItem>
        <FormLabel className="text-xs">Item</FormLabel>
        <Select
          disabled={disabled}
          onValueChange={(val) => {
            const pid = parseInt(val, 10);
            onParentChange(pid);
          }}
          value={effectiveParentId ? effectiveParentId.toString() : ""}
        >
          <FormControl>
            <SelectTrigger data-testid={`${testIdPrefix}-parent`}>
              <SelectValue
                placeholder={
                  disabled && disabledMessage
                    ? disabledMessage
                    : !disabled && topLevel.length === 0 && emptyMessage
                      ? emptyMessage
                      : "Select item"
                }
              />
            </SelectTrigger>
          </FormControl>
          <SelectContent>
            {topLevel.length === 0 ? (
              <div
                className="px-2 py-1.5 text-sm text-muted-foreground"
                data-testid={`${testIdPrefix}-empty`}
              >
                {disabled && disabledMessage
                  ? disabledMessage
                  : emptyMessage ?? "No items available"}
              </div>
            ) : null}
            {topLevel.map((i) => {
              const stockSuffix =
                showStockHint && !i.hasVariants && i.stockAtWarehouse != null
                  ? ` (stock: ${i.stockAtWarehouse})`
                  : "";
              return (
                <SelectItem key={i.id} value={i.id.toString()}>
                  {i.sku} - {i.name}
                  {i.hasVariants ? " (has variants)" : stockSuffix}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        {!parentItem?.hasVariants && errorMessage ? (
          <FormMessage>{errorMessage}</FormMessage>
        ) : null}
      </FormItem>

      {parentItem?.hasVariants ? (
        <FormItem>
          <FormLabel className="text-xs">Variant</FormLabel>
          <Select
            disabled={disabled || variants.length === 0}
            onValueChange={(val) => {
              const vid = parseInt(val, 10);
              onVariantChange(vid);
            }}
            value={selectedItemId ? selectedItemId.toString() : ""}
          >
            <FormControl>
              <SelectTrigger data-testid={`${testIdPrefix}-variant`}>
                <SelectValue
                  placeholder={
                    variants.length === 0
                      ? "No variants yet — add some on the item page"
                      : "Select variant"
                  }
                />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {variants.map((v) => {
                const lbl = variantLabel(v.variantOptions);
                const base = lbl ? `${lbl} — ${v.sku}` : v.sku;
                const stockSuffix =
                  showStockHint && v.stockAtWarehouse != null
                    ? ` (stock: ${v.stockAtWarehouse})`
                    : "";
                return (
                  <SelectItem key={v.id} value={v.id.toString()}>
                    {base}
                    {stockSuffix}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          {errorMessage ? <FormMessage>{errorMessage}</FormMessage> : null}
        </FormItem>
      ) : null}
    </div>
  );
}
