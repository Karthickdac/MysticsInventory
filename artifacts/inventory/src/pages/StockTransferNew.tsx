import { PageHeader } from "@/components/PageHeader";
import {
  useCreateStockTransfer,
  useListWarehouses,
  useListItems,
  getListStockTransfersQueryKey,
} from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
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
import { Trash2, Plus, ArrowLeft } from "lucide-react";
import { Separator } from "@/components/ui/separator";

const lineSchema = z.object({
  itemId: z.coerce.number().min(1, "Item required"),
  quantity: z.coerce.number().gt(0, "Must be > 0"),
});

const schema = z
  .object({
    fromWarehouseId: z.coerce.number().min(1, "Source warehouse is required"),
    toWarehouseId: z.coerce
      .number()
      .min(1, "Destination warehouse is required"),
    transferDate: z.string().min(1, "Date is required"),
    notes: z.string().optional(),
    lines: z.array(lineSchema).min(1, "At least one item is required"),
  })
  .refine((d) => d.fromWarehouseId !== d.toWarehouseId, {
    message: "Source and destination must be different",
    path: ["toWarehouseId"],
  });

type FormValues = z.infer<typeof schema>;

export default function StockTransferNew() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: warehouses } = useListWarehouses();

  const createMutation = useCreateStockTransfer({
    mutation: {
      onSuccess: (detail) => {
        queryClient.invalidateQueries({
          queryKey: getListStockTransfersQueryKey(),
        });
        toast({ title: "Transfer created" });
        setLocation(`/transfers/${detail.transfer.id}`);
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        toast({
          title: "Could not create transfer",
          description: e.response?.data?.error ?? "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      fromWarehouseId: 0,
      toWarehouseId: 0,
      transferDate: format(new Date(), "yyyy-MM-dd"),
      notes: "",
      lines: [{ itemId: 0, quantity: 1 }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "lines",
  });

  // Re-fetches the item list scoped to the chosen source warehouse so that
  // each option can show on-hand stock at that warehouse. Helps prevent
  // dispatching from the wrong source.
  const fromWarehouseId = form.watch("fromWarehouseId");
  const { data: items } = useListItems(
    fromWarehouseId
      ? { warehouseId: Number(fromWarehouseId) }
      : {},
  );

  const onSubmit = (data: FormValues) => {
    createMutation.mutate({
      data: {
        fromWarehouseId: data.fromWarehouseId,
        toWarehouseId: data.toWarehouseId,
        transferDate: data.transferDate,
        notes: data.notes || null,
        lines: data.lines,
      },
    });
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/transfers">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <PageHeader title="New Stock Transfer" className="mb-0" />
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <Card>
            <CardContent className="pt-6 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="fromWarehouseId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>From Warehouse *</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value ? field.value.toString() : ""}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-from-warehouse">
                            <SelectValue placeholder="Source warehouse" />
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
                  name="toWarehouseId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>To Warehouse *</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value ? field.value.toString() : ""}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-to-warehouse">
                            <SelectValue placeholder="Destination warehouse" />
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
                  name="transferDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Transfer Date *</FormLabel>
                      <FormControl>
                        <Input
                          type="date"
                          {...field}
                          data-testid="input-transfer-date"
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
              <h3 className="font-medium text-lg mb-4">Items to transfer</h3>

              <div className="space-y-4">
                {fields.map((field, index) => (
                  <div
                    key={field.id}
                    className="flex gap-3 items-start border p-4 rounded-lg bg-muted/20 relative"
                  >
                    <div className="grid grid-cols-12 gap-3 w-full">
                      <div className="col-span-12 md:col-span-8">
                        <FormField
                          control={form.control}
                          name={`lines.${index}.itemId`}
                          render={({ field: selectField }) => (
                            <FormItem>
                              <FormLabel className="text-xs">Item</FormLabel>
                              <Select
                                onValueChange={selectField.onChange}
                                value={
                                  selectField.value
                                    ? selectField.value.toString()
                                    : ""
                                }
                              >
                                <FormControl>
                                  <SelectTrigger
                                    data-testid={`select-item-${index}`}
                                  >
                                    <SelectValue placeholder="Select item" />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  {items?.map((i) => {
                                    const stock = i.stockAtWarehouse;
                                    return (
                                      <SelectItem
                                        key={i.id}
                                        value={i.id.toString()}
                                      >
                                        {i.sku} - {i.name}
                                        {stock !== null &&
                                        stock !== undefined ? (
                                          <span
                                            className={`ml-2 text-xs ${stock <= 0 ? "text-destructive" : "text-muted-foreground"}`}
                                          >
                                            (Stock: {stock} {i.unit})
                                          </span>
                                        ) : null}
                                      </SelectItem>
                                    );
                                  })}
                                </SelectContent>
                              </Select>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                      <div className="col-span-12 md:col-span-4">
                        <FormField
                          control={form.control}
                          name={`lines.${index}.quantity`}
                          render={({ field: inputField }) => (
                            <FormItem>
                              <FormLabel className="text-xs">
                                Quantity
                              </FormLabel>
                              <FormControl>
                                <Input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  {...inputField}
                                  data-testid={`input-qty-${index}`}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                    </div>
                    {fields.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-destructive h-9 w-9 mt-6"
                        onClick={() => remove(index)}
                        data-testid={`btn-remove-line-${index}`}
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
                onClick={() => append({ itemId: 0, quantity: 1 })}
                data-testid="btn-add-line"
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Line Item
              </Button>

              <Separator className="my-6" />

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
                        placeholder="Reason for the transfer, courier details, etc."
                        data-testid="input-notes"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          <div className="flex justify-end gap-4">
            <Button type="button" variant="outline" asChild>
              <Link href="/transfers">Cancel</Link>
            </Button>
            <Button
              type="submit"
              disabled={createMutation.isPending}
              data-testid="btn-submit-transfer"
            >
              {createMutation.isPending ? "Creating..." : "Create transfer"}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
