import { useState } from "react";
import { Link } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import { useListItems, useCreateItem, useUpdateItem, useDeleteItem, getListItemsQueryKey } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency } from "@/lib/format";
import { Plus, Search, MoreHorizontal, Edit, Trash2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useDebounce } from "@/hooks/use-debounce";
import { Item } from "@/lib/queryKeys";

const itemSchema = z.object({
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
});

type ItemFormValues = z.infer<typeof itemSchema>;

export default function Items() {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 500);
  const { data: items, isLoading } = useListItems({ search: debouncedSearch || undefined });
  
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [deleteDialogItem, setDeleteDialogItem] = useState<Item | null>(null);
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const createMutation = useCreateItem({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        setSheetOpen(false);
        toast({ title: "Item created successfully" });
      }
    }
  });

  const updateMutation = useUpdateItem({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        setSheetOpen(false);
        toast({ title: "Item updated successfully" });
      }
    }
  });

  const deleteMutation = useDeleteItem({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        setDeleteDialogItem(null);
        toast({ title: "Item deleted successfully" });
      }
    }
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
    }
  });

  const handleEdit = (item: Item) => {
    setEditingItem(item);
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
    });
    setSheetOpen(true);
  };

  const onSubmit = (data: ItemFormValues) => {
    if (editingItem) {
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
        }
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
          openingStock: data.openingStock || 0,
        }
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
              <TableHead>SKU</TableHead>
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
                <TableCell colSpan={6} className="h-24 text-center">Loading...</TableCell>
              </TableRow>
            ) : items?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center">No items found.</TableCell>
              </TableRow>
            ) : (
              items?.map((item) => (
                <TableRow key={item.id} data-testid={`row-item-${item.id}`}>
                  <TableCell className="font-mono text-xs">{item.sku}</TableCell>
                  <TableCell>
                    <Link href={`/items/${item.id}`} className="font-medium text-primary hover:underline" data-testid={`link-item-${item.id}`}>
                      {item.name}
                    </Link>
                  </TableCell>
                  <TableCell>{item.category || "-"}</TableCell>
                  <TableCell className="text-right">{formatCurrency(item.salePrice)}</TableCell>
                  <TableCell className="text-right">
                    <Badge variant={item.totalStock <= item.reorderLevel ? "destructive" : "secondary"}>
                      {item.totalStock} {item.unit}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" className="h-8 w-8 p-0" data-testid={`btn-item-menu-${item.id}`}>
                          <span className="sr-only">Open menu</span>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleEdit(item)} data-testid={`btn-edit-item-${item.id}`}>
                          <Edit className="mr-2 h-4 w-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem 
                          className="text-red-600 focus:text-red-600" 
                          onClick={() => setDeleteDialogItem(item)}
                          data-testid={`btn-delete-item-${item.id}`}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{editingItem ? "Edit Item" : "Create Item"}</SheetTitle>
            <SheetDescription>
              {editingItem ? "Make changes to the item here." : "Add a new item to your inventory."}
            </SheetDescription>
          </SheetHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 mt-6">
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
                      <Input {...field} data-testid="input-item-description" />
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
                        <Input {...field} data-testid="input-item-category" />
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
                        <Input {...field} placeholder="pcs, kg, m" data-testid="input-item-unit" />
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
                        <Input type="number" step="0.01" {...field} data-testid="input-item-saleprice" />
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
                        <Input type="number" step="0.01" {...field} data-testid="input-item-purchaseprice" />
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
                        <Input type="number" {...field} data-testid="input-item-taxrate" />
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
                        <Input {...field} data-testid="input-item-hsncode" />
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
                        <Input type="number" {...field} data-testid="input-item-reorderlevel" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {!editingItem && (
                  <FormField
                    control={form.control}
                    name="openingStock"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Opening Stock</FormLabel>
                        <FormControl>
                          <Input type="number" {...field} data-testid="input-item-openingstock" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
              </div>

              <div className="pt-4 flex justify-end">
                <Button 
                  type="submit" 
                  disabled={createMutation.isPending || updateMutation.isPending}
                  data-testid="btn-save-item"
                >
                  {(createMutation.isPending || updateMutation.isPending) ? "Saving..." : "Save Item"}
                </Button>
              </div>
            </form>
          </Form>
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!deleteDialogItem} onOpenChange={(open) => !open && setDeleteDialogItem(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Item</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {deleteDialogItem?.name}? This action cannot be undone.
              Note: Items cannot be deleted if they are used in sales or purchase orders.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={() => deleteDialogItem && deleteMutation.mutate({ id: deleteDialogItem.id })}
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
