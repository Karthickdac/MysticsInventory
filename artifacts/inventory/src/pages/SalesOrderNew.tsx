import { PageHeader } from "@/components/PageHeader";
import {
  useCreateSalesOrder,
  useListCustomers,
  useListWarehouses,
  useListItems,
  getListSalesOrdersQueryKey,
  getListCustomersQueryKey,
  useCreateCustomer,
  lookupItemByCode,
} from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useLocation, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { formatCurrency } from "@/lib/format";
import { Trash2, Plus, ArrowLeft, ScanBarcode, UserPlus, Loader2 } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { ItemPicker } from "@/components/ItemPicker";
import { useEffect, useMemo, useRef, useState } from "react";

const orderLineSchema = z.object({
  itemId: z.coerce.number().min(1, "Item required"),
  quantity: z.coerce.number().min(1, "Must be > 0"),
  unitPrice: z.coerce.number().min(0),
  taxRate: z.coerce.number().min(0),
  description: z.string().optional(),
});

const salesOrderSchema = z.object({
  customerId: z.coerce.number().min(1, "Customer is required"),
  warehouseId: z.coerce.number().min(1, "Warehouse is required"),
  orderDate: z.string().min(1, "Date is required"),
  expectedShipDate: z.string().optional().or(z.literal("")),
  notes: z.string().optional(),
  lines: z.array(orderLineSchema).min(1, "At least one item is required"),
});

type SalesOrderFormValues = z.infer<typeof salesOrderSchema>;

export default function SalesOrderNew() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: customers } = useListCustomers();
  const { data: warehouses } = useListWarehouses();

  const [parentByLine, setParentByLine] = useState<Record<string, number>>({});
  // Per-line barcode input values (keyed by field.id)
  const [barcodeByLine, setBarcodeByLine] = useState<Record<string, string>>({});
  // Per-line loading indicator while the lookup is in flight
  const [barcodeLookingUp, setBarcodeLookingUp] = useState<Record<string, boolean>>({});

  // New-customer dialog state
  const [newCustomerOpen, setNewCustomerOpen] = useState(false);
  const [newCustName, setNewCustName] = useState("");
  const [newCustPhone, setNewCustPhone] = useState("");
  const [newCustEmail, setNewCustEmail] = useState("");
  const createCustomerMutation = useCreateCustomer();

  const createMutation = useCreateSalesOrder({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSalesOrdersQueryKey() });
        toast({ title: "Sales order created successfully" });
        setLocation("/sales-orders");
      },
    },
  });

  const form = useForm<SalesOrderFormValues>({
    resolver: zodResolver(salesOrderSchema),
    defaultValues: {
      orderDate: format(new Date(), "yyyy-MM-dd"),
      expectedShipDate: "",
      notes: "",
      lines: [{ itemId: 0, quantity: 1, unitPrice: 0, taxRate: 18, description: "" }],
    },
  });

  const { fields, append, remove, replace } = useFieldArray({
    control: form.control,
    name: "lines",
  });

  const watchWarehouseId = form.watch("warehouseId");
  const parsedWarehouseId = Number(watchWarehouseId);
  const warehouseIdNum =
    Number.isFinite(parsedWarehouseId) && parsedWarehouseId > 0
      ? parsedWarehouseId
      : undefined;

  const { data: itemsRaw } = useListItems(
    warehouseIdNum ? { warehouseId: warehouseIdNum } : undefined,
  );

  const items = useMemo(() => itemsRaw ?? [], [itemsRaw]);

  const previousWarehouseRef = useRef<number | undefined>(warehouseIdNum);
  useEffect(() => {
    const prev = previousWarehouseRef.current;
    if (prev !== undefined && prev !== warehouseIdNum) {
      replace([{ itemId: 0, quantity: 1, unitPrice: 0, taxRate: 18, description: "" }]);
      setParentByLine({});
      setBarcodeByLine({});
    }
    previousWarehouseRef.current = warehouseIdNum;
  }, [warehouseIdNum, replace]);

  const watchLines = form.watch("lines");

  const subtotal = watchLines.reduce(
    (acc, line) => acc + line.quantity * line.unitPrice,
    0,
  );
  const taxTotal = watchLines.reduce(
    (acc, line) => acc + line.quantity * line.unitPrice * (line.taxRate / 100),
    0,
  );
  const total = subtotal + taxTotal;

  const onSubmit = (data: SalesOrderFormValues) => {
    createMutation.mutate({
      data: {
        ...data,
        expectedShipDate: data.expectedShipDate || null,
        notes: data.notes || null,
        lines: data.lines.map((l) => ({ ...l, description: l.description || null })),
      },
    });
  };

  const applyItemDefaults = (index: number, itemId: number) => {
    const selectedItem = items.find((i) => i.id === itemId);
    if (selectedItem) {
      form.setValue(`lines.${index}.unitPrice`, selectedItem.salePrice);
      form.setValue(`lines.${index}.taxRate`, selectedItem.taxRate);
      form.setValue(`lines.${index}.description`, selectedItem.description || "");
    }
  };

  const handleParentChange = (index: number, fieldId: string, parentId: number) => {
    const picked = items.find((i) => i.id === parentId);
    if (!picked) return;
    if (picked.hasVariants) {
      setParentByLine((prev) => ({ ...prev, [fieldId]: parentId }));
      form.setValue(`lines.${index}.itemId`, 0);
    } else {
      setParentByLine((prev) => {
        const next = { ...prev };
        delete next[fieldId];
        return next;
      });
      form.setValue(`lines.${index}.itemId`, picked.id);
      applyItemDefaults(index, picked.id);
    }
  };

  const handleVariantChange = (index: number, fieldId: string, variantId: number) => {
    setParentByLine((prev) => {
      const next = { ...prev };
      delete next[fieldId];
      return next;
    });
    form.setValue(`lines.${index}.itemId`, variantId);
    applyItemDefaults(index, variantId);
  };

  // Resolve a barcode/SKU code for a given line.
  const handleBarcodeResolve = async (index: number, fieldId: string, code: string) => {
    const trimmed = code.trim();
    if (!trimmed) return;
    setBarcodeLookingUp((prev) => ({ ...prev, [fieldId]: true }));
    try {
      const matched = await lookupItemByCode({ code: trimmed });
      // Fill the line with the matched item
      form.setValue(`lines.${index}.itemId`, matched.id);
      form.setValue(`lines.${index}.unitPrice`, matched.salePrice);
      form.setValue(`lines.${index}.taxRate`, matched.taxRate);
      form.setValue(`lines.${index}.description`, matched.description || "");
      // Clear parent selection if any
      setParentByLine((prev) => {
        const next = { ...prev };
        delete next[fieldId];
        return next;
      });
      // Clear the barcode input after successful resolve
      setBarcodeByLine((prev) => ({ ...prev, [fieldId]: "" }));
      toast({ title: `Item resolved: ${matched.name}` });
    } catch {
      toast({
        title: "Barcode not found",
        description: `No item matched "${trimmed}"`,
        variant: "destructive",
      });
    } finally {
      setBarcodeLookingUp((prev) => ({ ...prev, [fieldId]: false }));
    }
  };

  // Create a new customer inline and auto-select them on the order.
  const handleCreateCustomer = async () => {
    if (!newCustName.trim()) return;
    try {
      const created = await createCustomerMutation.mutateAsync({
        data: {
          name: newCustName.trim(),
          phone: newCustPhone.trim() || null,
          email: newCustEmail.trim() || null,
        },
      });
      await queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
      form.setValue("customerId", created.id);
      setNewCustomerOpen(false);
      setNewCustName("");
      setNewCustPhone("");
      setNewCustEmail("");
      toast({ title: `Customer "${created.name}" created and selected` });
    } catch {
      toast({
        title: "Failed to create customer",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/sales-orders">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <PageHeader title="New Sales Order" className="mb-0" />
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <Card>
            <CardContent className="pt-6 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Customer field + New Customer button */}
                <FormField
                  control={form.control}
                  name="customerId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Customer *</FormLabel>
                      <div className="flex gap-2">
                        <Select
                          onValueChange={field.onChange}
                          value={field.value ? field.value.toString() : ""}
                        >
                          <FormControl>
                            <SelectTrigger data-testid="select-customer">
                              <SelectValue placeholder="Select a customer" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {customers?.map((c) => (
                              <SelectItem key={c.id} value={c.id.toString()}>
                                {c.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          title="New customer"
                          onClick={() => setNewCustomerOpen(true)}
                          data-testid="btn-new-customer"
                        >
                          <UserPlus className="h-4 w-4" />
                        </Button>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="warehouseId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Fulfill from Warehouse *</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value ? field.value.toString() : ""}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-warehouse">
                            <SelectValue placeholder="Select warehouse" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {warehouses?.map((w) => (
                            <SelectItem key={w.id} value={w.id.toString()}>
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
                  name="orderDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Order Date *</FormLabel>
                      <FormControl>
                        <Input
                          type="date"
                          {...field}
                          data-testid="input-order-date"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="expectedShipDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Expected Ship Date</FormLabel>
                      <FormControl>
                        <Input
                          type="date"
                          {...field}
                          data-testid="input-ship-date"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <h3 className="font-medium text-lg mb-4">Line Items</h3>

              <div className="space-y-4">
                {fields.map((field, index) => (
                  <div
                    key={field.id}
                    className="flex gap-3 items-start border p-4 rounded-lg bg-muted/20 relative"
                  >
                    <div className="grid grid-cols-12 gap-3 w-full">
                      {/* Barcode scan row — spans the full width of the item column */}
                      <div className="col-span-12 md:col-span-4">
                        <div className="space-y-1.5 mb-2">
                          <Label
                            htmlFor={`barcode-line-${field.id}`}
                            className="text-xs text-muted-foreground flex items-center gap-1"
                          >
                            <ScanBarcode className="h-3 w-3" />
                            Scan / type barcode
                          </Label>
                          <div className="relative">
                            <Input
                              id={`barcode-line-${field.id}`}
                              value={barcodeByLine[field.id] ?? ""}
                              onChange={(e) =>
                                setBarcodeByLine((prev) => ({
                                  ...prev,
                                  [field.id]: e.target.value,
                                }))
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  handleBarcodeResolve(
                                    index,
                                    field.id,
                                    barcodeByLine[field.id] ?? "",
                                  );
                                }
                              }}
                              onBlur={() =>
                                handleBarcodeResolve(
                                  index,
                                  field.id,
                                  barcodeByLine[field.id] ?? "",
                                )
                              }
                              placeholder="Scan or type, then press Enter"
                              className="pr-8 text-xs h-8"
                              disabled={!warehouseIdNum}
                              data-testid={`input-barcode-${index}`}
                            />
                            {barcodeLookingUp[field.id] && (
                              <Loader2 className="absolute right-2 top-1.5 h-4 w-4 animate-spin text-muted-foreground" />
                            )}
                          </div>
                        </div>

                        <FormField
                          control={form.control}
                          name={`lines.${index}.itemId`}
                          render={({ field: selectField, fieldState }) => (
                            <ItemPicker
                              items={items}
                              selectedItemId={selectField.value || null}
                              parentSelection={parentByLine[field.id] ?? null}
                              onParentChange={(pid) =>
                                pid != null &&
                                handleParentChange(index, field.id, pid)
                              }
                              onVariantChange={(vid) =>
                                handleVariantChange(index, field.id, vid)
                              }
                              testIdPrefix={`select-item-${index}`}
                              errorMessage={fieldState.error?.message}
                              disabled={!warehouseIdNum}
                              disabledMessage="Pick a warehouse first"
                              emptyMessage="No items yet — add some on the Items page"
                              showStockHint
                            />
                          )}
                        />
                      </div>

                      <div className="col-span-6 md:col-span-2">
                        <FormField
                          control={form.control}
                          name={`lines.${index}.quantity`}
                          render={({ field: inputField }) => (
                            <FormItem>
                              <FormLabel className="text-xs">Qty</FormLabel>
                              <FormControl>
                                <Input
                                  type="number"
                                  {...inputField}
                                  data-testid={`input-qty-${index}`}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>

                      <div className="col-span-6 md:col-span-2">
                        <FormField
                          control={form.control}
                          name={`lines.${index}.unitPrice`}
                          render={({ field: inputField }) => (
                            <FormItem>
                              <FormLabel className="text-xs">Price</FormLabel>
                              <FormControl>
                                <Input
                                  type="number"
                                  step="0.01"
                                  {...inputField}
                                  data-testid={`input-price-${index}`}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>

                      <div className="col-span-6 md:col-span-2">
                        <FormField
                          control={form.control}
                          name={`lines.${index}.taxRate`}
                          render={({ field: inputField }) => (
                            <FormItem>
                              <FormLabel className="text-xs">Tax %</FormLabel>
                              <FormControl>
                                <Input
                                  type="number"
                                  {...inputField}
                                  data-testid={`input-tax-${index}`}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>

                      <div className="col-span-6 md:col-span-2 flex flex-col justify-end pb-2 text-right">
                        <span className="text-xs text-muted-foreground">Line Total</span>
                        <span className="font-medium">
                          {formatCurrency(
                            watchLines[index].quantity *
                              watchLines[index].unitPrice *
                              (1 + watchLines[index].taxRate / 100),
                          )}
                        </span>
                      </div>
                    </div>

                    {fields.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-destructive h-9 w-9 mt-6"
                        onClick={() => remove(index)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>

              <Button
                type="button"
                variant="outline"
                className="mt-4"
                onClick={() =>
                  append({ itemId: 0, quantity: 1, unitPrice: 0, taxRate: 18, description: "" })
                }
                data-testid="btn-add-line"
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Line Item
              </Button>

              <Separator className="my-6" />

              <div className="flex flex-col md:flex-row justify-between gap-8">
                <div className="flex-1">
                  <FormField
                    control={form.control}
                    name="notes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Notes</FormLabel>
                        <FormControl>
                          <Textarea
                            {...field}
                            className="h-24"
                            placeholder="Add any notes for the customer here..."
                            data-testid="input-notes"
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                </div>
                <div className="w-full md:w-64 space-y-2 bg-muted/20 p-4 rounded-lg border">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span>{formatCurrency(subtotal)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Tax</span>
                    <span>{formatCurrency(taxTotal)}</span>
                  </div>
                  <Separator />
                  <div className="flex justify-between font-bold text-lg">
                    <span>Total</span>
                    <span>{formatCurrency(total)}</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end gap-4">
            <Button type="button" variant="outline" asChild>
              <Link href="/sales-orders">Cancel</Link>
            </Button>
            <Button
              type="submit"
              disabled={createMutation.isPending}
              data-testid="btn-submit-order"
            >
              {createMutation.isPending ? "Creating..." : "Create Order"}
            </Button>
          </div>
        </form>
      </Form>

      {/* Inline new-customer dialog */}
      <Dialog open={newCustomerOpen} onOpenChange={setNewCustomerOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Customer</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="new-cust-name">Name *</Label>
              <Input
                id="new-cust-name"
                value={newCustName}
                onChange={(e) => setNewCustName(e.target.value)}
                placeholder="e.g. Priya Sharma"
                data-testid="input-new-customer-name"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleCreateCustomer();
                  }
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-cust-phone">Phone</Label>
              <Input
                id="new-cust-phone"
                type="tel"
                value={newCustPhone}
                onChange={(e) => setNewCustPhone(e.target.value)}
                placeholder="9876543210"
                data-testid="input-new-customer-phone"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-cust-email">Email</Label>
              <Input
                id="new-cust-email"
                type="email"
                value={newCustEmail}
                onChange={(e) => setNewCustEmail(e.target.value)}
                placeholder="priya@example.com"
                data-testid="input-new-customer-email"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setNewCustomerOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateCustomer}
              disabled={!newCustName.trim() || createCustomerMutation.isPending}
              data-testid="btn-create-customer-submit"
            >
              {createCustomerMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating…
                </>
              ) : (
                "Create & Select"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
