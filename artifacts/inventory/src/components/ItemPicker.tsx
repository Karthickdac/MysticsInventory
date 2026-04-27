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
              <SelectValue placeholder="Select item" />
            </SelectTrigger>
          </FormControl>
          <SelectContent>
            {topLevel.map((i) => (
              <SelectItem key={i.id} value={i.id.toString()}>
                {i.sku} - {i.name}
                {i.hasVariants ? " (has variants)" : ""}
              </SelectItem>
            ))}
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
                return (
                  <SelectItem key={v.id} value={v.id.toString()}>
                    {lbl ? `${lbl} — ${v.sku}` : v.sku}
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
