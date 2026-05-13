import { useParams, Link } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import {
  useGetItem,
  useAdjustItemStock,
  useListWarehouses,
  useListStockTransfers,
  useCreateItemVariants,
  useDeleteItemVariant,
  useListItemBatches,
  getGetItemQueryKey,
  getListItemsQueryKey,
  getListStockTransfersQueryKey,
  downloadItemBarcodeLabelsPdf,
} from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { formatCurrency, formatDate } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Plus, ArrowRight, Trash2, Printer } from "lucide-react";
import { StatusBadge } from "@/components/StatusBadge";
import { useImageSrc } from "@/hooks/use-image-src";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useState, useMemo } from "react";
import { useRecordVisit } from "@/lib/recentRecords";

const adjustStockSchema = z.object({
  warehouseId: z.coerce.number().min(1, "Warehouse is required"),
  quantity: z.coerce
    .number()
    .refine((val) => val !== 0, "Quantity cannot be zero"),
  reason: z.enum(["manual_adjustment", "damaged", "lost", "found"]),
  notes: z.string().optional(),
});

type AdjustStockFormValues = z.infer<typeof adjustStockSchema>;

/** Build the cartesian product of axis-value lists. */
/**
 * Renders the large item-detail image. Wraps the `useImageSrc` hook
 * so it can be conditionally placed inside JSX without violating
 * the rules of hooks.
 */
function ItemDetailImage({
  url,
  alt,
}: {
  url: string | null | undefined;
  alt: string;
}) {
  const { src } = useImageSrc(url);
  if (!src) return null;
  return (
    <div className="pb-2">
      <img
        src={src}
        alt={alt}
        className="h-48 w-48 rounded-md border object-cover"
        data-testid="img-item-detail"
      />
    </div>
  );
}

function cartesian(values: string[][]): string[][] {
  if (values.length === 0) return [[]];
  const [head, ...rest] = values;
  const tail = cartesian(rest);
  const out: string[][] = [];
  for (const h of head) for (const t of tail) out.push([h, ...t]);
  return out;
}

function variantLabel(opts: unknown): string {
  if (!opts || typeof opts !== "object") return "";
  return Object.entries(opts as Record<string, unknown>)
    .filter(([k]) => k !== "axes")
    .map(([, v]) => (typeof v === "string" ? v : ""))
    .filter(Boolean)
    .join(" / ");
}

export default function ItemDetail() {
  const { id } = useParams();
  const itemId = parseInt(id || "0", 10);

  const { data: itemDetail, isLoading } = useGetItem(itemId, {
    query: { enabled: !!itemId, queryKey: getGetItemQueryKey(itemId) },
  });

  useRecordVisit(
    useMemo(
      () =>
        itemDetail?.item
          ? {
              kind: "item" as const,
              id: itemDetail.item.id,
              title: itemDetail.item.name,
              subtitle: `SKU ${itemDetail.item.sku}`,
              href: `/items/${itemDetail.item.id}`,
            }
          : null,
      [itemDetail?.item],
    ),
  );

  const { data: warehouses } = useListWarehouses();
  const { data: recentTransfers } = useListStockTransfers(
    { itemId },
    {
      query: {
        enabled: !!itemId && !itemDetail?.item.hasVariants,
        queryKey: getListStockTransfersQueryKey({ itemId }),
      },
    },
  );

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [variantsDialogOpen, setVariantsDialogOpen] = useState(false);

  const adjustMutation = useAdjustItemStock({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getGetItemQueryKey(itemId),
        });
        setDialogOpen(false);
        form.reset();
        toast({ title: "Stock adjusted successfully" });
      },
    },
  });

  const createVariantsMutation = useCreateItemVariants({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getGetItemQueryKey(itemId),
        });
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        setVariantsDialogOpen(false);
        toast({ title: "Variants created" });
      },
      onError: (err: unknown) => {
        const e = err as { message?: string };
        toast({
          variant: "destructive",
          title: "Could not create variants",
          description: e.message ?? "Unknown error",
        });
      },
    },
  });

  const deleteVariantMutation = useDeleteItemVariant({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getGetItemQueryKey(itemId),
        });
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        toast({ title: "Variant deleted" });
      },
      onError: (err: unknown) => {
        const e = err as { message?: string };
        toast({
          variant: "destructive",
          title: "Could not delete variant",
          description: e.message ?? "Unknown error",
        });
      },
    },
  });

  const form = useForm<AdjustStockFormValues>({
    resolver: zodResolver(adjustStockSchema),
    defaultValues: {
      quantity: 0,
      reason: "manual_adjustment",
      notes: "",
    },
  });

  const onSubmit = (data: AdjustStockFormValues) => {
    adjustMutation.mutate({
      id: itemId,
      data: {
        warehouseId: data.warehouseId,
        quantity: data.quantity,
        reason: data.reason,
        notes: data.notes || null,
      },
    });
  };

  if (isLoading || !itemDetail) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-32" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const { item, stockByWarehouse, variants, components } = itemDetail;
  const isParent = !!item.hasVariants;
  const isBundle = !!item.isBundle;
  const axes: string[] = (() => {
    const opts = item.variantOptions as unknown;
    if (opts && typeof opts === "object") {
      const a = (opts as { axes?: unknown }).axes;
      if (Array.isArray(a)) return a.filter((x) => typeof x === "string");
    }
    return [];
  })();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/items">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <PageHeader
          title={item.name}
          description={`SKU: ${item.sku}`}
          className="mb-0"
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  const blob = (await downloadItemBarcodeLabelsPdf({
                    ids: String(item.id),
                    copies: 24,
                  })) as unknown as Blob;
                  const url = URL.createObjectURL(blob);
                  window.open(url, "_blank", "noopener");
                  setTimeout(() => URL.revokeObjectURL(url), 60_000);
                } catch (err) {
                  const e = err as { response?: { data?: { error?: string } } };
                  toast({
                    title: "Could not generate labels",
                    description:
                      e.response?.data?.error ?? "Please try again.",
                    variant: "destructive",
                  });
                }
              }}
              data-testid="btn-print-barcode"
            >
              <Printer className="h-4 w-4 mr-2" />
              Print barcode
            </Button>
          }
        />
      </div>

      {item.parentItemId && (
        <Card>
          <CardContent className="py-4 flex items-center gap-2">
            <Badge variant="outline">Variant</Badge>
            <span className="text-sm text-muted-foreground">
              This is a variant of{" "}
              <Link
                href={`/items/${item.parentItemId}`}
                className="text-primary hover:underline"
              >
                item #{item.parentItemId}
              </Link>
              {variantLabel(item.variantOptions) && (
                <> — {variantLabel(item.variantOptions)}</>
              )}
            </span>
          </CardContent>
        </Card>
      )}

      <div className="grid md:grid-cols-3 gap-6">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Item Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ItemDetailImage url={item.imageUrl} alt={item.name} />
            <div className="grid grid-cols-2 gap-y-4 gap-x-8">
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  Category
                </p>
                <p>{item.category || "-"}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  Unit
                </p>
                <p>{item.unit}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  Sale Price
                </p>
                <p>
                  {isParent ? (
                    <span className="text-muted-foreground">
                      Per-variant
                    </span>
                  ) : (
                    formatCurrency(item.salePrice)
                  )}
                </p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  Purchase Price
                </p>
                <p>
                  {isParent ? (
                    <span className="text-muted-foreground">
                      Per-variant
                    </span>
                  ) : (
                    formatCurrency(item.purchasePrice)
                  )}
                </p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  Tax Rate
                </p>
                <p>{item.taxRate}%</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  HSN Code
                </p>
                <p>{item.hsnCode || "-"}</p>
              </div>
            </div>
            {item.description && (
              <div className="pt-4 border-t">
                <p className="text-sm font-medium text-muted-foreground mb-1">
                  Description
                </p>
                <p className="text-sm">{item.description}</p>
              </div>
            )}
            {isParent && axes.length > 0 && (
              <div className="pt-4 border-t">
                <p className="text-sm font-medium text-muted-foreground mb-1">
                  Variant axes
                </p>
                <div className="flex flex-wrap gap-2">
                  {axes.map((a) => (
                    <Badge key={a} variant="outline">
                      {a}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">
                {isParent
                  ? "Variants"
                  : isBundle
                  ? "Bundle Stock"
                  : "Total Stock"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isParent ? (
                <>
                  <div className="text-3xl font-bold">
                    {item.variantCount}
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    Variant rows
                  </p>
                </>
              ) : (
                <>
                  <div className="text-3xl font-bold">
                    {item.totalStock} {item.unit}
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    {isBundle
                      ? "Derived from current component stock."
                      : `Reorder level: ${item.reorderLevel}`}
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {isBundle && (
        <Card>
          <CardHeader>
            <CardTitle>Components</CardTitle>
            <CardDescription>
              Items consumed when one bundle ships. Stock is derived
              from these components and changes whenever they do.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {components.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This bundle has no components configured.
              </p>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead className="text-right">
                        Quantity per bundle
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {components.map((c) => (
                      <TableRow
                        key={c.id}
                        data-testid={`row-bundle-component-${c.id}`}
                      >
                        <TableCell className="font-mono text-xs">
                          <Link
                            href={`/items/${c.componentItemId}`}
                            className="text-primary hover:underline"
                            data-testid={`link-bundle-component-${c.id}`}
                          >
                            {c.componentSku}
                          </Link>
                        </TableCell>
                        <TableCell>{c.componentName}</TableCell>
                        <TableCell className="text-right">
                          {c.quantityPerBundle}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {stockByWarehouse.length > 0 && (
              <>
                <h3 className="text-sm font-medium mt-6 mb-2">
                  Assemblable per warehouse
                </h3>
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Warehouse</TableHead>
                        <TableHead className="text-right">
                          Bundles available
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {stockByWarehouse.map((row) => (
                        <TableRow key={row.warehouseId}>
                          <TableCell>{row.warehouseName}</TableCell>
                          <TableCell className="text-right">
                            {row.quantity} {item.unit}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {isParent ? (
        <VariantsCard
          parentName={item.name}
          axes={axes}
          variants={variants}
          warehouses={warehouses ?? []}
          onAddClick={() => setVariantsDialogOpen(true)}
          onDelete={(variantId) =>
            deleteVariantMutation.mutate({
              parentId: itemId,
              variantId,
            })
          }
          dialogOpen={variantsDialogOpen}
          setDialogOpen={setVariantsDialogOpen}
          isCreating={createVariantsMutation.isPending}
          onCreate={(payload) =>
            createVariantsMutation.mutate({ id: itemId, data: payload })
          }
          existingOptionKeys={new Set(
            variants.map((v) =>
              axes
                .map(
                  (a) =>
                    ((v.item.variantOptions as Record<string, unknown> | null)?.[
                      a
                    ] as string) ?? "",
                )
                .join("\u0000"),
            ),
          )}
          existingSkus={new Set(variants.map((v) => v.item.sku))}
        />
      ) : (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Stock by Warehouse</CardTitle>
              <CardDescription>
                Current inventory levels across all locations.
              </CardDescription>
            </div>
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button data-testid="btn-adjust-stock">Adjust Stock</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Adjust Stock</DialogTitle>
                  <DialogDescription>
                    Manually increase or decrease inventory for this item.
                  </DialogDescription>
                </DialogHeader>
                <Form {...form}>
                  <form
                    onSubmit={form.handleSubmit(onSubmit)}
                    className="space-y-4"
                  >
                    <FormField
                      control={form.control}
                      name="warehouseId"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Warehouse</FormLabel>
                          <Select
                            onValueChange={(val) =>
                              field.onChange(parseInt(val))
                            }
                            value={field.value?.toString() || ""}
                          >
                            <FormControl>
                              <SelectTrigger data-testid="select-warehouse">
                                <SelectValue placeholder="Select a warehouse" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {warehouses?.map((w) => (
                                <SelectItem
                                  key={w.id}
                                  value={w.id.toString()}
                                >
                                  {w.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="quantity"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            Adjustment Quantity (use negative for removal)
                          </FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              {...field}
                              data-testid="input-adjust-qty"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="reason"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Reason</FormLabel>
                          <Select
                            onValueChange={field.onChange}
                            value={field.value}
                          >
                            <FormControl>
                              <SelectTrigger data-testid="select-reason">
                                <SelectValue placeholder="Select a reason" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="manual_adjustment">
                                Manual Adjustment
                              </SelectItem>
                              <SelectItem value="damaged">Damaged</SelectItem>
                              <SelectItem value="lost">Lost</SelectItem>
                              <SelectItem value="found">Found</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="notes"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Notes (Optional)</FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              data-testid="input-adjust-notes"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <div className="flex justify-end pt-4">
                      <Button
                        type="submit"
                        disabled={adjustMutation.isPending}
                        data-testid="btn-submit-adjust"
                      >
                        {adjustMutation.isPending
                          ? "Adjusting..."
                          : "Apply Adjustment"}
                      </Button>
                    </div>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Warehouse</TableHead>
                  <TableHead className="text-right">Sale Price</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stockByWarehouse.map((stock) => (
                  <TableRow
                    key={stock.warehouseId}
                    data-testid={`row-stock-wh-${stock.warehouseId}`}
                  >
                    <TableCell className="font-medium">
                      {stock.warehouseName}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {formatCurrency(item.salePrice)}
                    </TableCell>
                    <TableCell className="text-right">
                      {stock.quantity}
                    </TableCell>
                  </TableRow>
                ))}
                {stockByWarehouse.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      className="text-center py-4 text-muted-foreground"
                    >
                      No stock available in any warehouse.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {!isParent && !isBundle && item.trackBatches && (
        <BatchesCard itemId={itemId} unit={item.unit} />
      )}

      {!isParent && (
        <Card>
          <CardHeader>
            <CardTitle>Recent Transfers</CardTitle>
            <CardDescription>
              Warehouse-to-warehouse transfers that include this item.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Transfer #</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead></TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(recentTransfers ?? []).slice(0, 10).map((tr) => (
                  <TableRow
                    key={tr.id}
                    data-testid={`row-item-transfer-${tr.id}`}
                  >
                    <TableCell className="font-mono">
                      <Link
                        href={`/transfers/${tr.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {tr.transferNumber}
                      </Link>
                    </TableCell>
                    <TableCell>{formatDate(tr.transferDate)}</TableCell>
                    <TableCell>{tr.fromWarehouseName}</TableCell>
                    <TableCell className="text-muted-foreground">
                      <ArrowRight className="h-4 w-4" />
                    </TableCell>
                    <TableCell>{tr.toWarehouseName}</TableCell>
                    <TableCell>
                      <StatusBadge status={tr.status} />
                    </TableCell>
                  </TableRow>
                ))}
                {(!recentTransfers || recentTransfers.length === 0) && (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="text-center py-4 text-muted-foreground"
                    >
                      No transfers involve this item yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

type Warehouse = { id: number; name: string };
type VariantStockEntry = {
  item: {
    id: number;
    sku: string;
    name: string;
    barcode: string | null;
    salePrice: number;
    totalStock: number;
    unit: string;
    variantOptions: unknown;
  };
  stockByWarehouse: Array<{
    warehouseId: number;
    warehouseName: string;
    quantity: number;
  }>;
};

interface VariantsCardProps {
  parentName: string;
  axes: string[];
  variants: VariantStockEntry[];
  warehouses: Warehouse[];
  onAddClick: () => void;
  onDelete: (variantId: number) => void;
  dialogOpen: boolean;
  setDialogOpen: (b: boolean) => void;
  isCreating: boolean;
  onCreate: (payload: {
    variants: Array<{
      sku: string;
      options: Record<string, string>;
      salePrice: number;
      purchasePrice: number;
    }>;
  }) => void;
  existingOptionKeys: Set<string>;
  existingSkus: Set<string>;
}

function VariantsCard({
  parentName,
  axes,
  variants,
  warehouses,
  onDelete,
  dialogOpen,
  setDialogOpen,
  isCreating,
  onCreate,
  existingOptionKeys,
  existingSkus,
}: VariantsCardProps) {
  const { toast } = useToast();
  // The "Add variants" dialog is a small wizard: the user provides one
  // comma-separated list of values per axis, plus default prices, and
  // we generate the cartesian product of combinations as the preview
  // table. Combinations that already exist are filtered out.
  const [axisValues, setAxisValues] = useState<Record<string, string>>(
    () => Object.fromEntries(axes.map((a) => [a, ""])),
  );
  const [defaultSalePrice, setDefaultSalePrice] = useState<string>("0");
  const [defaultPurchasePrice, setDefaultPurchasePrice] =
    useState<string>("0");
  const [skuPrefix, setSkuPrefix] = useState<string>("");

  // Build the preview: cartesian product of axis values, filtered to
  // remove combinations that already exist on this parent.
  const valuesByAxis = axes.map((a) =>
    (axisValues[a] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const preview = useMemo(() => {
    if (valuesByAxis.some((v) => v.length === 0)) return [];
    const combos = cartesian(valuesByAxis);
    return combos
      .map((combo, i) => {
        const opts: Record<string, string> = {};
        axes.forEach((a, idx) => (opts[a] = combo[idx]!));
        const key = combo.join("\u0000");
        const sku = (skuPrefix.trim() || `V`) + "-" + (i + 1);
        return {
          options: opts,
          combo,
          key,
          sku,
        };
      })
      .filter((c) => !existingOptionKeys.has(c.key))
      .filter((c) => !existingSkus.has(c.sku));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valuesByAxis.join("|"), skuPrefix]);

  const handleSubmit = () => {
    if (preview.length === 0) return;
    const sale = Number(defaultSalePrice) || 0;
    const purchase = Number(defaultPurchasePrice) || 0;
    onCreate({
      variants: preview.map((p) => ({
        sku: p.sku,
        options: p.options,
        salePrice: sale,
        purchasePrice: purchase,
      })),
    });
  };

  const allWarehouseIds = warehouses.map((w) => w.id);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Variants</CardTitle>
          <CardDescription>
            Each row is its own stockable item. Stock and price live on
            the variant, not the parent.
          </CardDescription>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button data-testid="btn-add-variants">
              <Plus className="mr-2 h-4 w-4" />
              Add Variants
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Add Variants to {parentName}</DialogTitle>
              <DialogDescription>
                Enter one or more values per axis (comma separated). We'll
                create one variant per combination. Existing combinations
                are skipped.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              {axes.map((a) => (
                <div key={a}>
                  <label className="text-sm font-medium">{a} values</label>
                  <Input
                    value={axisValues[a] ?? ""}
                    onChange={(e) =>
                      setAxisValues((m) => ({ ...m, [a]: e.target.value }))
                    }
                    placeholder="e.g. S, M, L"
                    data-testid={`input-axis-${a}`}
                  />
                </div>
              ))}
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-sm font-medium">SKU prefix</label>
                  <Input
                    value={skuPrefix}
                    onChange={(e) => setSkuPrefix(e.target.value)}
                    placeholder={`${parentName.slice(0, 3).toUpperCase()}`}
                    data-testid="input-sku-prefix"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Sale Price</label>
                  <Input
                    type="number"
                    step="0.01"
                    value={defaultSalePrice}
                    onChange={(e) => setDefaultSalePrice(e.target.value)}
                    data-testid="input-default-sale-price"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">
                    Purchase Price
                  </label>
                  <Input
                    type="number"
                    step="0.01"
                    value={defaultPurchasePrice}
                    onChange={(e) =>
                      setDefaultPurchasePrice(e.target.value)
                    }
                    data-testid="input-default-purchase-price"
                  />
                </div>
              </div>
              {preview.length > 0 && (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>SKU</TableHead>
                        {axes.map((a) => (
                          <TableHead key={a}>{a}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.map((p) => (
                        <TableRow key={p.key}>
                          <TableCell className="font-mono text-xs">
                            {p.sku}
                          </TableCell>
                          {axes.map((a) => (
                            <TableCell key={a}>{p.options[a]}</TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={preview.length === 0 || isCreating}
                data-testid="btn-create-variants"
              >
                {isCreating
                  ? "Creating..."
                  : `Create ${preview.length} variant${preview.length === 1 ? "" : "s"}`}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>SKU</TableHead>
              {axes.map((a) => (
                <TableHead key={a}>{a}</TableHead>
              ))}
              <TableHead>Barcode</TableHead>
              <TableHead className="text-right">Sale Price</TableHead>
              <TableHead className="text-right">Total Stock</TableHead>
              {allWarehouseIds.length > 0 && (
                <>
                  {warehouses.map((w) => (
                    <TableHead key={w.id} className="text-right">
                      {w.name}
                    </TableHead>
                  ))}
                </>
              )}
              <TableHead className="w-[100px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {variants.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={4 + axes.length + warehouses.length}
                  className="text-center py-6 text-muted-foreground"
                >
                  No variants yet. Click "Add Variants" to create the
                  first combinations.
                </TableCell>
              </TableRow>
            )}
            {variants.map((v) => {
              const opts =
                (v.item.variantOptions as Record<string, unknown> | null) ??
                {};
              const stockByWh = new Map<number, number>();
              for (const s of v.stockByWarehouse) {
                stockByWh.set(s.warehouseId, s.quantity);
              }
              return (
                <TableRow
                  key={v.item.id}
                  data-testid={`row-variant-${v.item.id}`}
                >
                  <TableCell className="font-mono text-xs">
                    <Link
                      href={`/items/${v.item.id}`}
                      className="text-primary hover:underline"
                    >
                      {v.item.sku}
                    </Link>
                  </TableCell>
                  {axes.map((a) => (
                    <TableCell key={a}>
                      {(opts[a] as string) ?? ""}
                    </TableCell>
                  ))}
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {v.item.barcode || "-"}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatCurrency(v.item.salePrice)}
                  </TableCell>
                  <TableCell className="text-right">
                    {v.item.totalStock} {v.item.unit}
                  </TableCell>
                  {warehouses.map((w) => (
                    <TableCell key={w.id} className="text-right">
                      {stockByWh.get(w.id) ?? 0}
                    </TableCell>
                  ))}
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="Print barcode label"
                        data-testid={`btn-print-variant-barcode-${v.item.id}`}
                        onClick={async () => {
                          try {
                            const blob = (await downloadItemBarcodeLabelsPdf({
                              ids: String(v.item.id),
                              copies: 24,
                            })) as unknown as Blob;
                            const url = URL.createObjectURL(blob);
                            window.open(url, "_blank", "noopener");
                            setTimeout(() => URL.revokeObjectURL(url), 60_000);
                          } catch (err) {
                            const e = err as { response?: { data?: { error?: string } } };
                            toast({
                              title: "Could not generate labels",
                              description: e.response?.data?.error ?? "Please try again.",
                              variant: "destructive",
                            });
                          }
                        }}
                      >
                        <Printer className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete variant ${v.item.sku}? This cannot be undone.`,
                            )
                          ) {
                            onDelete(v.item.id);
                          }
                        }}
                        data-testid={`btn-delete-variant-${v.item.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function BatchesCard({ itemId, unit }: { itemId: number; unit: string }) {
  const { data, isLoading } = useListItemBatches(itemId);
  const onHand = data?.onHand ?? [];
  const batches = data?.batches ?? [];
  const today = useMemo(() => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }, []);

  const expiryStatus = (expiry: string | null) => {
    if (!expiry) return null;
    const exp = new Date(expiry);
    if (Number.isNaN(exp.getTime())) return null;
    const days = Math.floor(
      (exp.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
    );
    if (days < 0)
      return { label: `Expired (${-days}d ago)`, variant: "destructive" as const };
    if (days <= 30)
      return { label: `Expires in ${days}d`, variant: "secondary" as const };
    return null;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Batches</CardTitle>
        <CardDescription>
          Per-batch on-hand quantities, sorted earliest expiry first.
          Receipts capture new batches; shipments and transfers pick from
          this list.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <h3 className="text-sm font-medium mb-2">On hand</h3>
          {isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : onHand.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No batches with stock on hand.
            </p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Batch #</TableHead>
                    <TableHead>Mfg date</TableHead>
                    <TableHead>Expiry</TableHead>
                    <TableHead>Warehouse</TableHead>
                    <TableHead className="text-right">Quantity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {onHand.map((row) => {
                    const status = expiryStatus(row.expiryDate);
                    return (
                      <TableRow
                        key={`${row.itemBatchId}-${row.warehouseId}`}
                        data-testid={`row-batch-onhand-${row.itemBatchId}-${row.warehouseId}`}
                      >
                        <TableCell className="font-mono text-xs">
                          {row.batchNumber}
                        </TableCell>
                        <TableCell>
                          {row.mfgDate ? formatDate(row.mfgDate) : "-"}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {row.expiryDate
                              ? formatDate(row.expiryDate)
                              : "-"}
                            {status && (
                              <Badge variant={status.variant}>
                                {status.label}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>Warehouse #{row.warehouseId}</TableCell>
                        <TableCell className="text-right">
                          {row.quantity} {unit}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <div>
          <h3 className="text-sm font-medium mb-2">All batches</h3>
          {isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : batches.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No batches recorded yet. New batches are created when this
              item is received.
            </p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Batch #</TableHead>
                    <TableHead>Mfg date</TableHead>
                    <TableHead>Expiry</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {batches.map((b) => (
                    <TableRow
                      key={b.id}
                      data-testid={`row-batch-${b.id}`}
                    >
                      <TableCell className="font-mono text-xs">
                        {b.batchNumber}
                      </TableCell>
                      <TableCell>
                        {b.mfgDate ? formatDate(b.mfgDate) : "-"}
                      </TableCell>
                      <TableCell>
                        {b.expiryDate ? formatDate(b.expiryDate) : "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        {b.costPrice != null
                          ? formatCurrency(b.costPrice)
                          : "-"}
                      </TableCell>
                      <TableCell>{formatDate(b.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
