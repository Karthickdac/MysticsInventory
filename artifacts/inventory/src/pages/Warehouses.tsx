import { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { useListWarehouses, useCreateWarehouse, useUpdateWarehouse, useDeleteWarehouse, getListWarehousesQueryKey } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, MoreHorizontal, Edit, Trash2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Checkbox } from "@/components/ui/checkbox";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Warehouse } from "@/lib/queryKeys";

const warehouseSchema = z.object({
  name: z.string().min(1, "Name is required"),
  code: z.string().min(1, "Code is required"),
  addressLine1: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  isDefault: z.boolean().default(false),
});

type WarehouseFormValues = z.infer<typeof warehouseSchema>;

export default function Warehouses() {
  const { data: warehouses, isLoading } = useListWarehouses();
  
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingWarehouse, setEditingWarehouse] = useState<Warehouse | null>(null);
  const [deleteDialogWarehouse, setDeleteDialogWarehouse] = useState<Warehouse | null>(null);
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const createMutation = useCreateWarehouse({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListWarehousesQueryKey() });
        setSheetOpen(false);
        toast({ title: "Warehouse created successfully" });
      }
    }
  });

  const updateMutation = useUpdateWarehouse({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListWarehousesQueryKey() });
        setSheetOpen(false);
        toast({ title: "Warehouse updated successfully" });
      }
    }
  });

  const deleteMutation = useDeleteWarehouse({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListWarehousesQueryKey() });
        setDeleteDialogWarehouse(null);
        toast({ title: "Warehouse deleted successfully" });
      }
    }
  });

  const form = useForm<WarehouseFormValues>({
    resolver: zodResolver(warehouseSchema),
    defaultValues: {
      name: "",
      code: "",
      addressLine1: "",
      city: "",
      state: "",
      country: "",
      isDefault: false,
    }
  });

  const handleEdit = (warehouse: Warehouse) => {
    setEditingWarehouse(warehouse);
    form.reset({
      name: warehouse.name,
      code: warehouse.code,
      addressLine1: warehouse.addressLine1 || "",
      city: warehouse.city || "",
      state: warehouse.state || "",
      country: warehouse.country || "",
      isDefault: warehouse.isDefault,
    });
    setSheetOpen(true);
  };

  const handleCreate = () => {
    setEditingWarehouse(null);
    form.reset({
      name: "",
      code: "",
      addressLine1: "",
      city: "",
      state: "",
      country: "",
      isDefault: false,
    });
    setSheetOpen(true);
  };

  const onSubmit = (data: WarehouseFormValues) => {
    const payload = {
      name: data.name,
      code: data.code,
      addressLine1: data.addressLine1 || null,
      city: data.city || null,
      state: data.state || null,
      country: data.country || null,
      isDefault: data.isDefault,
    };

    if (editingWarehouse) {
      updateMutation.mutate({ id: editingWarehouse.id, data: payload });
    } else {
      createMutation.mutate({ data: payload });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader 
        title="Warehouses" 
        description="Manage your inventory locations."
        actions={
          <Button onClick={handleCreate} data-testid="btn-create-warehouse">
            <Plus className="mr-2 h-4 w-4" />
            Add Warehouse
          </Button>
        }
      />

      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="w-[100px]">Status</TableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center">Loading...</TableCell>
              </TableRow>
            ) : warehouses?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center">No warehouses found.</TableCell>
              </TableRow>
            ) : (
              warehouses?.map((warehouse) => (
                <TableRow key={warehouse.id} data-testid={`row-warehouse-${warehouse.id}`}>
                  <TableCell className="font-mono text-xs">{warehouse.code}</TableCell>
                  <TableCell className="font-medium">{warehouse.name}</TableCell>
                  <TableCell>
                    {[warehouse.city, warehouse.state].filter(Boolean).join(", ") || "-"}
                  </TableCell>
                  <TableCell>
                    {warehouse.isDefault && <Badge variant="secondary">Default</Badge>}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" className="h-8 w-8 p-0" data-testid={`btn-warehouse-menu-${warehouse.id}`}>
                          <span className="sr-only">Open menu</span>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleEdit(warehouse)} data-testid={`btn-edit-warehouse-${warehouse.id}`}>
                          <Edit className="mr-2 h-4 w-4" />
                          Edit
                        </DropdownMenuItem>
                        {!warehouse.isDefault && (
                          <DropdownMenuItem 
                            className="text-red-600 focus:text-red-600" 
                            onClick={() => setDeleteDialogWarehouse(warehouse)}
                            data-testid={`btn-delete-warehouse-${warehouse.id}`}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        )}
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
            <SheetTitle>{editingWarehouse ? "Edit Warehouse" : "Create Warehouse"}</SheetTitle>
            <SheetDescription>
              {editingWarehouse ? "Update warehouse details." : "Add a new warehouse to your organization."}
            </SheetDescription>
          </SheetHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 mt-6">
              <div className="grid grid-cols-3 gap-4">
                <FormField
                  control={form.control}
                  name="code"
                  render={({ field }) => (
                    <FormItem className="col-span-1">
                      <FormLabel>Code *</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="MAIN" data-testid="input-warehouse-code" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem className="col-span-2">
                      <FormLabel>Name *</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-warehouse-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="addressLine1"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Address</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="input-warehouse-address" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="city"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>City</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-warehouse-city" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="state"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>State</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-warehouse-state" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="isDefault"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        data-testid="input-warehouse-isdefault"
                      />
                    </FormControl>
                    <div className="space-y-1 leading-none">
                      <FormLabel>
                        Set as default warehouse
                      </FormLabel>
                    </div>
                  </FormItem>
                )}
              />
              <div className="pt-4 flex justify-end">
                <Button 
                  type="submit" 
                  disabled={createMutation.isPending || updateMutation.isPending}
                  data-testid="btn-save-warehouse"
                >
                  {(createMutation.isPending || updateMutation.isPending) ? "Saving..." : "Save Warehouse"}
                </Button>
              </div>
            </form>
          </Form>
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!deleteDialogWarehouse} onOpenChange={(open) => !open && setDeleteDialogWarehouse(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Warehouse</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {deleteDialogWarehouse?.name}? This action cannot be undone.
              Warehouses with existing stock cannot be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={() => deleteDialogWarehouse && deleteMutation.mutate({ id: deleteDialogWarehouse.id })}
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
