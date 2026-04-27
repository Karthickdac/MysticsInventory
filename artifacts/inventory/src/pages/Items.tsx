import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import { useNewParam } from "@/hooks/use-focus-param";
import {
  useListItems,
  useCreateItem,
  useUpdateItem,
  useDeleteItem,
  getListItemsQueryKey,
  getItem,
} from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency } from "@/lib/format";
import {
  Plus,
  Search,
  MoreHorizontal,
  Edit,
  Trash2,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Checkbox } from "@/components/ui/checkbox";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useDebounce } from "@/hooks/use-debounce";
import { Item } from "@/lib/queryKeys";

const componentRowSchema = z.object({
  componentItemId: z.coerce.number().int().min(1),
  quantityPerBundle: z.coerce.number().positive(),
});

const itemSchema = z
  .object({
    sku: z.string().min(1, "SKU is required"),
    name: z.string().min(1, "Name is required"),
    description: z.string().optional(),
    category: z.string().optional(),
    unit: z.string().min(1, "Unit is required"),
    salePrice: z.coerce.number().min(0),
    purchasePrice: z.coerce.number().min(0),
    hsnCode: z.string().optional(),
    taxRate: z.coerce.number().min(0).max(100),
    reorderLevel: z.coerce.number().min(0),
    openingStock: z.coerce.number().min(0).optional(),
    hasVariants: z.boolean().default(false),
    axes: z.string().optional(),
    isBundle: z.boolean().default(false),
    components: z.array(componentRowSchema).default([]),
  })
  .refine(
    (v) => {
      if (!v.hasVariants) return true;
      const list = (v.axes ?? "")
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
      return list.length >= 1 && list.length <= 3;
    },
    {
      path: ["axes"],
      message:
        "Provide 1-3 comma-separated axis names (e.g. Size, Color)",
    },
  )
  .refine((v) => !(v.isBundle && v.hasVariants), {
    path: ["isBundle"],
    message: "An item cannot be both a bundle and a variant parent",
  })
  .refine(
    (v) => {
      if (!v.isBundle) return true;
      if (v.components.length === 0) return false;
      const ids = v.components.map((c) => c.componentItemId);
      return new Set(ids).size === ids.length;
    },
    {
      path: ["components"],
      message:
        "A bundle needs at least one component and component items cannot repeat",
    },
  );

type ItemFormValues = z.infer<typeof itemSchema>;

/**
 * Read variantOptions for a parent into a "Size, Color" axis string for
 * display in the form.
 */
function axesString(opts: Item["variantOptions"]): string {
  if (!opts || typeof opts !== "object") return "";
  const axes = (opts as { axes?: unknown }).axes;
  if (!Array.isArray(axes)) return "";
  return axes.filter((a) => typeof a === "string").join(", ");
}

/**
 * Render the option values of a variant ({Size: "M", Color: "Red"}) as
 * a compact "M / Red" label.
 */
function variantLabel(opts: Item["variantOptions"]): string {
  if (!opts || typeof opts !== "object") return "";
  const entries = Object.entries(opts as Record<string, unknown>).filter(
    ([k]) => k !== "axes",
  );
  return entries
    .map(([, v]) => (typeof v === "string" ? v : ""))
    .filter(Boolean)
    .join(" / ");
}

export default function Items() {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 500);
  // Fetch every row (parents + variants) in a single query so we can
  // group them client-side without a per-row fetch.
  const { data: items, isLoading } = useListItems({
    search: debouncedSearch || undefined,
  });

  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [deleteDialogItem, setDeleteDialogItem] = useState<Item | null>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Group: parents (no parentItemId) plus their variants. Variants
  // whose parent isn't in the result set (because of a search hit on
  // the variant alone) are rendered as orphan top-level rows so the
  // user can still see/edit them.
  const grouped = useMemo(() => {
    const all = items ?? [];
    const byParent = new Map<number, Item[]>();
    const topLevel: Item[] = [];
    const ids = new Set(all.map((i) => i.id));
    for (const it of all) {
      if (it.parentItemId && ids.has(it.parentItemId)) {
        if (!byParent.has(it.parentItemId)) byParent.set(it.parentItemId, []);
        byParent.get(it.parentItemId)!.push(it);
      } else {
        topLevel.push(it);
      }
    }
    return { topLevel, byParent };
  }, [items]);

  const createMutation = useCreateItem({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        setSheetOpen(false);
        toast({ title: "Item created successfully" });
      },
    },
  });

  const updateMutation = useUpdateItem({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        setSheetOpen(false);
        toast({ title: "Item updated successfully" });
      },
    },
  });

  const deleteMutation = useDeleteItem({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        setDeleteDialogItem(null);
        toast({ title: "Item deleted successfully" });
      },
      onError: (err: unknown) => {
        const e = err as { message?: string };
        toast({
          variant: "destructive",
          title: "Could not delete item",
          description: e.message ?? "Unknown error",
        });
      },
    },
  });

  const form = useForm<ItemFormValues>({
    resolver: zodResolver(itemSchema),
    defaultValues: {
      sku: "",
      name: "",
      description: "",
      category: "",
      unit: "pcs",
      salePrice: 0,
      purchasePrice: 0,
      hsnCode: "",
      taxRate: 0,
      reorderLevel: 0,
      openingStock: 0,
      hasVariants: false,
      axes: "",
      isBundle: false,
      components: [],
    },
  });
  const watchHasVariants = form.watch("hasVariants");
  const watchIsBundle = form.watch("isBundle");
  const watchComponents = form.watch("components");

  // Items eligible to be picked as bundle components: any saved leaf
  // item that is not itself a parent and not itself a bundle.
  const componentCandidates = useMemo(() => {
    return (items ?? []).filter(
      (i) => !i.hasVariants && !i.isBundle,
    );
  }, [items]);

  const handleEdit = async (item: Item) => {
    setEditingItem(item);
    // For bundles, fetch the detail so we can pre-fill the components
    // editor. For everything else the list row already has every field
    // we render in the form.
    let existingComponents: ItemFormValues["components"] = [];
    if (item.isBundle) {
      try {
        const detail = await getItem(item.id);
        existingComponents = (detail.components ?? []).map((c) => ({
          componentItemId: c.componentItemId,
          quantityPerBundle: c.quantityPerBundle,
        }));
      } catch {
        // If the fetch fails, fall back to an empty editor — the user
        // will see the validation error and can re-pick components.
      }
    }
    form.reset({
      sku: item.sku,
      name: item.name,
      description: item.description || "",
      category: item.category || "",
      unit: item.unit,
      salePrice: item.salePrice,
      purchasePrice: item.purchasePrice,
      hsnCode: item.hsnCode || "",
      taxRate: item.taxRate,
      reorderLevel: item.reorderLevel,
      openingStock: 0, // Cannot update opening stock
      hasVariants: !!item.hasVariants,
      axes: axesString(item.variantOptions),
      isBundle: !!item.isBundle,
      components: existingComponents,
    });
    setSheetOpen(true);
  };

  const handleCreate = () => {
    setEditingItem(null);
    form.reset({
      sku: "",
      name: "",
      description: "",
      category: "",
      unit: "pcs",
      salePrice: 0,
      purchasePrice: 0,
      hsnCode: "",
      taxRate: 18,
      reorderLevel: 5,
      openingStock: 0,
      hasVariants: false,
      axes: "",
      isBundle: false,
      components: [],
    });
    setSheetOpen(true);
  };

  // Auto-open the create sheet when arriving via the command palette
  // with ?new=1.
  const { shouldOpenNew, clear: clearNew } = useNewParam();
  const newHandledRef = useRef(false);
  useEffect(() => {
    if (!shouldOpenNew) {
      newHandledRef.current = false;
      return;
    }
    if (newHandledRef.current) return;
    newHandledRef.current = true;
    handleCreate();
    clearNew();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldOpenNew]);

  const onSubmit = (data: ItemFormValues) => {
    const axesList = (data.axes ?? "")
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    const variantOptions = data.hasVariants ? { axes: axesList } : null;
    const componentsPayload = data.isBundle
      ? data.components.map((c) => ({
          componentItemId: c.componentItemId,
          quantityPerBundle: c.quantityPerBundle,
        }))
      : [];
    if (editingItem) {
      const wantsVariants = !!data.hasVariants;
      const hadVariants = !!editingItem.hasVariants;
      const transitioningVariants = wantsVariants !== hadVariants;
      const includeOptions = wantsVariants;
      const wantsBundle = !!data.isBundle;
      const wasBundle = !!editingItem.isBundle;
      const transitioningBundle = wantsBundle !== wasBundle;
      // We always replace the component list when the row is a bundle
      // and we have edited rows; clearing the list happens automatically
      // when the user toggles isBundle off.
      const includeComponents = wantsBundle;
      updateMutation.mutate({
        id: editingItem.id,
        data: {
          sku: data.sku,
          name: data.name,
          description: data.description || null,
          category: data.category || null,
          unit: data.unit,
          salePrice: data.salePrice,
          purchasePrice: data.purchasePrice,
          hsnCode: data.hsnCode || null,
          taxRate: data.taxRate,
          reorderLevel: data.reorderLevel,
          ...(transitioningVariants ? { hasVariants: wantsVariants } : {}),
          ...(includeOptions ? { variantOptions } : {}),
          ...(transitioningBundle ? { isBundle: wantsBundle } : {}),
          ...(includeComponents ? { components: componentsPayload } : {}),
        },
      });
    } else {
      createMutation.mutate({
        data: {
          sku: data.sku,
          name: data.name,
          description: data.description || null,
          category: data.category || null,
          unit: data.unit,
          salePrice: data.salePrice,
          purchasePrice: data.purchasePrice,
          hsnCode: data.hsnCode || null,
          taxRate: data.taxRate,
          reorderLevel: data.reorderLevel,
          openingStock:
            data.hasVariants || data.isBundle ? 0 : data.openingStock || 0,
          hasVariants: data.hasVariants,
          variantOptions,
          ...(data.isBundle
            ? { isBundle: true, components: componentsPayload }
            : {}),
        },
      });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Items"
        description="Manage your product catalog and inventory items."
        actions={
          <Button onClick={handleCreate} data-testid="btn-create-item">
            <Plus className="mr-2 h-4 w-4" />
            Add Item
          </Button>
        }
      />

      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search items by name or SKU..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-search-items"
          />
        </div>
      </div>

      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[180px]">SKU</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Stock</TableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center">
                  Loading...
                </TableCell>
              </TableRow>
            ) : grouped.topLevel.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center">
                  No items found.
                </TableCell>
              </TableRow>
            ) : (
              grouped.topLevel.flatMap((parent) => {
                const isParent = !!parent.hasVariants;
                const isExpanded = !!expanded[parent.id];
                const variants = isParent
                  ? grouped.byParent.get(parent.id) ?? []
                  : [];
                const rows: React.ReactNode[] = [
                  <TableRow
                    key={parent.id}
                    data-testid={`row-item-${parent.id}`}
                  >
                    <TableCell className="font-mono text-xs">
                      <div className="flex items-center gap-1">
                        {isParent ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 -ml-1"
                            onClick={() =>
                              setExpanded((m) => ({
                                ...m,
                                [parent.id]: !m[parent.id],
                              }))
                            }
                            data-testid={`btn-expand-${parent.id}`}
                            aria-label={isExpanded ? "Collapse" : "Expand"}
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </Button>
                        ) : (
                          <span className="inline-block w-5" />
                        )}
                        {parent.sku}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/items/${parent.id}`}
                          className="font-medium text-primary hover:underline"
                          data-testid={`link-item-${parent.id}`}
                        >
                          {parent.name}
                        </Link>
                        {isParent && (
                          <Badge variant="outline">
                            {parent.variantCount} variant
                            {parent.variantCount === 1 ? "" : "s"}
                          </Badge>
                        )}
                        {parent.isBundle && (
                          <Badge variant="outline" data-testid={`badge-bundle-${parent.id}`}>
                            Bundle
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{parent.category || "-"}</TableCell>
                    <TableCell className="text-right">
                      {isParent ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        formatCurrency(parent.salePrice)
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {isParent ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <Badge
                          variant={
                            parent.totalStock <= parent.reorderLevel
                              ? "destructive"
                              : "secondary"
                          }
                          title={
                            parent.isBundle
                              ? "Derived from component stock"
                              : undefined
                          }
                        >
                          {parent.totalStock} {parent.unit}
                          {parent.isBundle ? " (derived)" : ""}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            className="h-8 w-8 p-0"
                            data-testid={`btn-item-menu-${parent.id}`}
                          >
                            <span className="sr-only">Open menu</span>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => handleEdit(parent)}
                            data-testid={`btn-edit-item-${parent.id}`}
                          >
                            <Edit className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-red-600 focus:text-red-600"
                            onClick={() => setDeleteDialogItem(parent)}
                            data-testid={`btn-delete-item-${parent.id}`}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>,
                ];
                if (isParent && isExpanded) {
                  for (const v of variants) {
                    rows.push(
                      <TableRow
                        key={`v-${v.id}`}
                        className="bg-muted/30"
                        data-testid={`row-item-${v.id}`}
                      >
                        <TableCell className="font-mono text-xs">
                          <div className="flex items-center gap-1 pl-6">
                            <span className="inline-block w-5" />
                            {v.sku}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Link
                              href={`/items/${v.id}`}
                              className="font-medium text-primary hover:underline"
                              data-testid={`link-item-${v.id}`}
                            >
                              {v.name}
                            </Link>
                            {variantLabel(v.variantOptions) && (
                              <Badge variant="secondary" className="font-normal">
                                {variantLabel(v.variantOptions)}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>{v.category || "-"}</TableCell>
                        <TableCell className="text-right">
                          {formatCurrency(v.salePrice)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge
                            variant={
                              v.totalStock <= v.reorderLevel
                                ? "destructive"
                                : "secondary"
                            }
                          >
                            {v.totalStock} {v.unit}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                className="h-8 w-8 p-0"
                                data-testid={`btn-item-menu-${v.id}`}
                              >
                                <span className="sr-only">Open menu</span>
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => handleEdit(v)}
                                data-testid={`btn-edit-item-${v.id}`}
                              >
                                <Edit className="mr-2 h-4 w-4" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-red-600 focus:text-red-600"
                                onClick={() => setDeleteDialogItem(v)}
                                data-testid={`btn-delete-item-${v.id}`}
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>,
                    );
                  }
                }
                return rows;
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle>
              {editingItem ? "Edit Item" : "Create Item"}
            </SheetTitle>
            <SheetDescription>
              {editingItem
                ? "Make changes to the item here."
                : "Add a new item to your inventory."}
            </SheetDescription>
          </SheetHeader>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="space-y-4 mt-6"
            >
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="sku"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>SKU *</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-item-sku" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name *</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-item-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        data-testid="input-item-description"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="category"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Category</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          data-testid="input-item-category"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="unit"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Unit *</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          placeholder="pcs, kg, m"
                          data-testid="input-item-unit"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="salePrice"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Sale Price (₹) *</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          step="0.01"
                          {...field}
                          data-testid="input-item-saleprice"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="purchasePrice"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Purchase Price (₹) *</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          step="0.01"
                          {...field}
                          data-testid="input-item-purchaseprice"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="taxRate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>GST Rate (%) *</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          {...field}
                          data-testid="input-item-taxrate"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="hsnCode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>HSN Code</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          data-testid="input-item-hsncode"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="reorderLevel"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Reorder Level *</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          {...field}
                          data-testid="input-item-reorderlevel"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {!editingItem && !watchHasVariants && (
                  <FormField
                    control={form.control}
                    name="openingStock"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Opening Stock</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            {...field}
                            data-testid="input-item-openingstock"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
              </div>

              <div className="border-t pt-4 space-y-3">
                {(() => {
                  const isVariant = !!(editingItem && editingItem.parentItemId);
                  const hasChildren = !!(
                    editingItem && (editingItem.variantCount ?? 0) > 0
                  );
                  const lockHasVariants = !!editingItem && (isVariant || hasChildren);
                  const lockAxes = !!editingItem && hasChildren;
                  return (
                    <>
                      <FormField
                        control={form.control}
                        name="hasVariants"
                        render={({ field }) => (
                          <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                            <FormControl>
                              <Checkbox
                                checked={field.value}
                                onCheckedChange={(v) => field.onChange(!!v)}
                                disabled={lockHasVariants}
                                data-testid="checkbox-has-variants"
                              />
                            </FormControl>
                            <div className="space-y-1 leading-none">
                              <FormLabel>This item has variants</FormLabel>
                              <FormDescription>
                                Variants are size/colour combinations under
                                this item. Each variant gets its own SKU,
                                prices, and stock levels.
                                {isVariant
                                  ? " This item is itself a variant of another item, so it can't have its own variants."
                                  : hasChildren
                                  ? " Delete the existing variants first to disable this."
                                  : ""}
                              </FormDescription>
                            </div>
                          </FormItem>
                        )}
                      />
                      {watchHasVariants && (
                        <FormField
                          control={form.control}
                          name="axes"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Variant axes</FormLabel>
                              <FormControl>
                                <Input
                                  {...field}
                                  placeholder="Size, Color"
                                  disabled={lockAxes}
                                  data-testid="input-item-axes"
                                />
                              </FormControl>
                              <FormDescription>
                                Comma-separated list of 1-3 axis names.
                                Example: "Size, Color".
                                {lockAxes
                                  ? " Axes are locked once variants exist."
                                  : ""}
                              </FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      )}
                    </>
                  );
                })()}
              </div>

              {(() => {
                // Bundle toggle. Disable if the row is a variant child or
                // a variant parent — the API rejects either combination.
                const isVariantChild = !!(
                  editingItem && editingItem.parentItemId
                );
                const isVariantParent = !!(editingItem && editingItem.hasVariants);
                const lockBundle =
                  watchHasVariants || isVariantChild || isVariantParent;
                return (
                  <div className="border-t pt-4 space-y-3">
                    <FormField
                      control={form.control}
                      name="isBundle"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                          <FormControl>
                            <Checkbox
                              checked={field.value}
                              onCheckedChange={(v) => field.onChange(!!v)}
                              disabled={lockBundle}
                              data-testid="checkbox-is-bundle"
                            />
                          </FormControl>
                          <div className="space-y-1 leading-none">
                            <FormLabel>This item is a bundle</FormLabel>
                            <FormDescription>
                              A bundle has its own SKU and price but no
                              physical stock. Selling one ships the
                              configured component items instead.
                              {watchHasVariants
                                ? " A bundle cannot also be a variant parent."
                                : isVariantChild
                                ? " A variant cannot be turned into a bundle."
                                : ""}
                            </FormDescription>
                            <FormMessage />
                          </div>
                        </FormItem>
                      )}
                    />
                    {watchIsBundle && (
                      <FormField
                        control={form.control}
                        name="components"
                        render={() => (
                          <FormItem>
                            <FormLabel>Components</FormLabel>
                            <FormDescription>
                              Pick the items consumed when one bundle ships.
                              Quantity is per single bundle.
                            </FormDescription>
                            <div className="space-y-2 mt-2">
                              {watchComponents.map((row, idx) => (
                                <div
                                  key={idx}
                                  className="flex items-center gap-2"
                                  data-testid={`row-component-${idx}`}
                                >
                                  <select
                                    className="flex-1 h-9 rounded-md border bg-background px-2 text-sm"
                                    value={row.componentItemId || ""}
                                    onChange={(e) => {
                                      const next = [...watchComponents];
                                      next[idx] = {
                                        ...next[idx],
                                        componentItemId: Number(e.target.value),
                                      };
                                      form.setValue("components", next, {
                                        shouldValidate: true,
                                      });
                                    }}
                                    data-testid={`select-component-${idx}`}
                                  >
                                    <option value="">Choose item…</option>
                                    {componentCandidates.map((c) => (
                                      <option
                                        key={c.id}
                                        value={c.id}
                                        disabled={
                                          editingItem?.id === c.id ||
                                          watchComponents.some(
                                            (other, j) =>
                                              j !== idx &&
                                              other.componentItemId === c.id,
                                          )
                                        }
                                      >
                                        {c.sku} — {c.name}
                                      </option>
                                    ))}
                                  </select>
                                  <Input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    className="w-24"
                                    value={row.quantityPerBundle}
                                    onChange={(e) => {
                                      const next = [...watchComponents];
                                      next[idx] = {
                                        ...next[idx],
                                        quantityPerBundle: Number(
                                          e.target.value,
                                        ),
                                      };
                                      form.setValue("components", next, {
                                        shouldValidate: true,
                                      });
                                    }}
                                    data-testid={`input-component-qty-${idx}`}
                                  />
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => {
                                      const next = watchComponents.filter(
                                        (_, j) => j !== idx,
                                      );
                                      form.setValue("components", next, {
                                        shouldValidate: true,
                                      });
                                    }}
                                    data-testid={`btn-remove-component-${idx}`}
                                    aria-label="Remove component"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </div>
                              ))}
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  form.setValue(
                                    "components",
                                    [
                                      ...watchComponents,
                                      {
                                        componentItemId: 0,
                                        quantityPerBundle: 1,
                                      },
                                    ],
                                    { shouldValidate: true },
                                  );
                                }}
                                data-testid="btn-add-component"
                              >
                                <Plus className="mr-1 h-3 w-3" />
                                Add component
                              </Button>
                            </div>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}
                  </div>
                );
              })()}

              <div className="pt-4 flex justify-end">
                <Button
                  type="submit"
                  disabled={
                    createMutation.isPending || updateMutation.isPending
                  }
                  data-testid="btn-save-item"
                >
                  {createMutation.isPending || updateMutation.isPending
                    ? "Saving..."
                    : "Save Item"}
                </Button>
              </div>
            </form>
          </Form>
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={!!deleteDialogItem}
        onOpenChange={(open) => !open && setDeleteDialogItem(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Item</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {deleteDialogItem?.name}? This
              action cannot be undone. Note: Items cannot be deleted if they
              are used in sales or purchase orders, and parent items must
              have all their variants deleted first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                deleteDialogItem &&
                deleteMutation.mutate({ id: deleteDialogItem.id })
              }
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
