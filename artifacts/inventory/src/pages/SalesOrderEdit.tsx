import { PageHeader } from "@/components/PageHeader";
import {
  useGetSalesOrder,
  useUpdateSalesOrder,
  useListCustomers,
  useListWarehouses,
  useListItems,
  getGetSalesOrderQueryKey,
  getListSalesOrdersQueryKey,
} from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Link, useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/format";
import { Trash2, Plus, ArrowLeft } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { ItemPicker } from "@/components/ItemPicker";
import { Skeleton } from "@/components/ui/skeleton";
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

export default function SalesOrderEdit() {
  const { id } = useParams();
  const orderId = parseInt(id || "0", 10);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: orderDetail, isLoading } = useGetSalesOrder(orderId, {
    query: { enabled: !!orderId, queryKey: getGetSalesOrderQueryKey(orderId) },
  });
  const { data: customers } = useListCustomers();
  const { data: warehouses } = useListWarehouses();

  const [parentByLine, setParentByLine] = useState<Record<string, number>>({});
  const prefilledRef = useRef(false);

  const updateMutation = useUpdateSalesOrder({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetSalesOrderQueryKey(orderId) });
        queryClient.invalidateQueries({ queryKey: getListSalesOrdersQueryKey() });
        toast({ title: "Sales order updated" });
        setLocation(`/sales-orders/${orderId}`);
      },
      onError: (err: unknown) => {
        const e = err as {
          data?: { error?: string };
          response?: { data?: { error?: string } };
          message?: string;
        };
        toast({
          title: "Could not update order",
          description:
            e.data?.error ??
            e.response?.data?.error ??
            e.message ??
            "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  const form = useForm<SalesOrderFormValues>({
    resolver: zodResolver(salesOrderSchema),
    defaultValues: {
      customerId: 0,
      warehouseId: 0,
      orderDate: "",
      expectedShipDate: "",
      notes: "",
      lines: [{ itemId: 0, quantity: 1, unitPrice: 0, taxRate: 18, description: "" }],
    },
  });

  const { fields, append, remove, replace } = useFieldArray({
    control: form.control,
    name: "lines",
  });

  // Pre-fill the form once the order loads. Only run once so the user's
  // edits aren't blown away by background refetches.
  useEffect(() => {
    if (prefilledRef.current || !orderDetail) return;
    const o = orderDetail.order;
    form.reset({
      customerId: o.customerId,
      warehouseId: o.warehouseId,
      orderDate: o.orderDate,
      expectedShipDate: o.expectedShipDate ?? "",
      notes: o.notes ?? "",
      lines:
        orderDetail.lines.length > 0
          ? orderDetail.lines.map((l) => ({
              itemId: l.itemId,
              quantity: Number(l.quantity),
              unitPrice: Number(l.unitPrice),
              taxRate: Number(l.taxRate),
              description: l.description ?? "",
            }))
          : [
              {
                itemId: 0,
                quantity: 1,
                unitPrice: 0,
                taxRate: 18,
                description: "",
              },
            ],
    });
    prefilledRef.current = true;
  }, [orderDetail, form]);

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

  // Mirror SalesOrderNew: switching warehouse mid-edit clears lines
  // because the items at the new warehouse may be different. We skip
  // the very first run (the prefill itself), so loading the page
  // doesn't wipe the existing lines.
  const previousWarehouseRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const prev = previousWarehouseRef.current;
    if (
      prefilledRef.current &&
      prev !== undefined &&
      prev !== warehouseIdNum
    ) {
      replace([
        { itemId: 0, quantity: 1, unitPrice: 0, taxRate: 18, description: "" },
      ]);
      setParentByLine({});
    }
    previousWarehouseRef.current = warehouseIdNum;
  }, [warehouseIdNum, replace]);

  const watchLines = form.watch("lines");
  const subtotal = watchLines.reduce(
    (acc, line) => acc + line.quantity * line.unitPrice,
    0,
  );
  const taxTotal = watchLines.reduce(
    (acc, line) =>
      acc + line.quantity * line.unitPrice * (line.taxRate / 100),
    0,
  );
  const total = subtotal + taxTotal;

  const onSubmit = (data: SalesOrderFormValues) => {
    updateMutation.mutate({
      id: orderId,
      data: {
        ...data,
        expectedShipDate: data.expectedShipDate || null,
        notes: data.notes || null,
        lines: data.lines.map((l) => ({
          ...l,
          description: l.description || null,
        })),
      },
    });
  };

  const applyItemDefaults = (index: number, itemId: number) => {
    const selectedItem = items.find((i) => i.id === itemId);
    if (selectedItem) {
      form.setValue(`lines.${index}.unitPrice`, selectedItem.salePrice);
      form.setValue(`lines.${index}.taxRate`, selectedItem.taxRate);
      form.setValue(
        `lines.${index}.description`,
        selectedItem.description || "",
      );
    }
  };

  const handleParentChange = (
    index: number,
    fieldId: string,
    parentId: number,
  ) => {
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

  const handleVariantChange = (
    index: number,
    fieldId: string,
    variantId: number,
  ) => {
    setParentByLine((prev) => {
      const next = { ...prev };
      delete next[fieldId];
      return next;
    });
    form.setValue(`lines.${index}.itemId`, variantId);
    applyItemDefaults(index, variantId);
  };

  if (isLoading || !orderDetail) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-32" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  // Backend mirrors this rule (`Only draft orders can be edited`).
  // We surface it up-front so the user isn't stuck on a form that
  // can't be saved.
  if (orderDetail.order.status !== "draft") {
    return (
      <div className="space-y-6 max-w-3xl">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href={`/sales-orders/${orderId}`}>
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
          <PageHeader
            title={`Edit ${orderDetail.order.orderNumber}`}
            className="mb-0"
          />
        </div>
        <Card>
          <CardContent className="pt-6 space-y-3">
            <p className="text-sm">
              This order is{" "}
              <span className="font-medium">{orderDetail.order.status}</span>{" "}
              and can no longer be edited. Sales orders are only editable
              while they are in draft status (before the order is confirmed).
            </p>
            <p className="text-sm text-muted-foreground">
              To change a confirmed order, cancel it and create a new one.
            </p>
            <div>
              <Button asChild>
                <Link href={`/sales-orders/${orderId}`}>Back to order</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href={`/sales-orders/${orderId}`}>
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <PageHeader
          title={`Edit ${orderDetail.order.orderNumber}`}
          className="mb-0"
        />
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <Card>
            <CardContent className="pt-6 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="customerId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Customer *</FormLabel>
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
                      <div className="col-span-12 md:col-span-4">
                        <FormField
                          control={form.control}
                          name={`lines.${index}.itemId`}
                          render={({ field: selectField, fieldState }) => (
                            <ItemPicker
                              items={items}
                              selectedItemId={selectField.value || null}
                              parentSelection={
                                parentByLine[field.id] ?? null
                              }
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
                        <span className="text-xs text-muted-foreground">
                          Line Total
                        </span>
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
                  append({
                    itemId: 0,
                    quantity: 1,
                    unitPrice: 0,
                    taxRate: 18,
                    description: "",
                  })
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
              <Link href={`/sales-orders/${orderId}`}>Cancel</Link>
            </Button>
            <Button
              type="submit"
              disabled={updateMutation.isPending}
              data-testid="btn-save-order"
            >
              {updateMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
