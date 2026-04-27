import { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { useListSuppliers, useCreateSupplier, useUpdateSupplier, useDeleteSupplier, getListSuppliersQueryKey } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency } from "@/lib/format";
import { Plus, Search, MoreHorizontal, Edit, Trash2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useDebounce } from "@/hooks/use-debounce";
import { Supplier } from "@/lib/queryKeys";

const supplierSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email").optional().or(z.literal("")),
  phone: z.string().optional(),
  company: z.string().optional(),
  gstNumber: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
});

type SupplierFormValues = z.infer<typeof supplierSchema>;

export default function Suppliers() {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 500);
  const { data: suppliers, isLoading } = useListSuppliers({ search: debouncedSearch || undefined });
  
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [deleteDialogSupplier, setDeleteDialogSupplier] = useState<Supplier | null>(null);
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const createMutation = useCreateSupplier({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
        setSheetOpen(false);
        toast({ title: "Supplier created successfully" });
      }
    }
  });

  const updateMutation = useUpdateSupplier({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
        setSheetOpen(false);
        toast({ title: "Supplier updated successfully" });
      }
    }
  });

  const deleteMutation = useDeleteSupplier({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
        setDeleteDialogSupplier(null);
        toast({ title: "Supplier deleted successfully" });
      }
    }
  });

  const form = useForm<SupplierFormValues>({
    resolver: zodResolver(supplierSchema),
    defaultValues: {
      name: "",
      email: "",
      phone: "",
      company: "",
      gstNumber: "",
      address: "",
      notes: "",
    }
  });

  const handleEdit = (supplier: Supplier) => {
    setEditingSupplier(supplier);
    form.reset({
      name: supplier.name,
      email: supplier.email || "",
      phone: supplier.phone || "",
      company: supplier.company || "",
      gstNumber: supplier.gstNumber || "",
      address: supplier.address || "",
      notes: supplier.notes || "",
    });
    setSheetOpen(true);
  };

  const handleCreate = () => {
    setEditingSupplier(null);
    form.reset({
      name: "",
      email: "",
      phone: "",
      company: "",
      gstNumber: "",
      address: "",
      notes: "",
    });
    setSheetOpen(true);
  };

  const onSubmit = (data: SupplierFormValues) => {
    const payload = {
      name: data.name,
      email: data.email || null,
      phone: data.phone || null,
      company: data.company || null,
      gstNumber: data.gstNumber || null,
      address: data.address || null,
      notes: data.notes || null,
    };

    if (editingSupplier) {
      updateMutation.mutate({ id: editingSupplier.id, data: payload });
    } else {
      createMutation.mutate({ data: payload });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader 
        title="Suppliers" 
        description="Manage your vendors and payable balances."
        actions={
          <Button onClick={handleCreate} data-testid="btn-create-supplier">
            <Plus className="mr-2 h-4 w-4" />
            Add Supplier
          </Button>
        }
      />

      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search suppliers..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-search-suppliers"
          />
        </div>
      </div>

      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead className="text-right">Payable</TableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center">Loading...</TableCell>
              </TableRow>
            ) : suppliers?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center">No suppliers found.</TableCell>
              </TableRow>
            ) : (
              suppliers?.map((supplier) => (
                <TableRow key={supplier.id} data-testid={`row-supplier-${supplier.id}`}>
                  <TableCell className="font-medium">{supplier.name}</TableCell>
                  <TableCell>{supplier.company || "-"}</TableCell>
                  <TableCell>
                    <div className="flex flex-col text-sm">
                      {supplier.email && <span className="text-muted-foreground">{supplier.email}</span>}
                      {supplier.phone && <span className="text-muted-foreground">{supplier.phone}</span>}
                      {!supplier.email && !supplier.phone && "-"}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    <span className={supplier.outstandingPayable > 0 ? "text-orange-600" : ""}>
                      {formatCurrency(supplier.outstandingPayable)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" className="h-8 w-8 p-0" data-testid={`btn-supplier-menu-${supplier.id}`}>
                          <span className="sr-only">Open menu</span>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleEdit(supplier)} data-testid={`btn-edit-supplier-${supplier.id}`}>
                          <Edit className="mr-2 h-4 w-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem 
                          className="text-red-600 focus:text-red-600" 
                          onClick={() => setDeleteDialogSupplier(supplier)}
                          data-testid={`btn-delete-supplier-${supplier.id}`}
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
            <SheetTitle>{editingSupplier ? "Edit Supplier" : "Create Supplier"}</SheetTitle>
            <SheetDescription>
              {editingSupplier ? "Update supplier details." : "Add a new supplier to your database."}
            </SheetDescription>
          </SheetHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 mt-6">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name *</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="input-supplier-name" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="company"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Company Name</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="input-supplier-company" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input type="email" {...field} data-testid="input-supplier-email" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phone</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-supplier-phone" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="gstNumber"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>GST Number</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="input-supplier-gst" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="address"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Address</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="input-supplier-address" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="pt-4 flex justify-end">
                <Button 
                  type="submit" 
                  disabled={createMutation.isPending || updateMutation.isPending}
                  data-testid="btn-save-supplier"
                >
                  {(createMutation.isPending || updateMutation.isPending) ? "Saving..." : "Save Supplier"}
                </Button>
              </div>
            </form>
          </Form>
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!deleteDialogSupplier} onOpenChange={(open) => !open && setDeleteDialogSupplier(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Supplier</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {deleteDialogSupplier?.name}? This action cannot be undone.
              Suppliers with existing purchase orders cannot be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={() => deleteDialogSupplier && deleteMutation.mutate({ id: deleteDialogSupplier.id })}
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
