import { useParams, Link } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import { useGetItem, useAdjustItemStock, useListWarehouses, useListStockTransfers, getGetItemQueryKey, getListStockTransfersQueryKey } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { formatCurrency } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Save, Plus, ArrowRight } from "lucide-react";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useState, useMemo } from "react";
import { useRecordVisit } from "@/lib/recentRecords";

const adjustStockSchema = z.object({
  warehouseId: z.coerce.number().min(1, "Warehouse is required"),
  quantity: z.coerce.number().refine(val => val !== 0, "Quantity cannot be zero"),
  reason: z.enum(["manual_adjustment", "damaged", "lost", "found"]),
  notes: z.string().optional(),
});

type AdjustStockFormValues = z.infer<typeof adjustStockSchema>;

export default function ItemDetail() {
  const { id } = useParams();
  const itemId = parseInt(id || "0", 10);
  
  const { data: itemDetail, isLoading } = useGetItem(itemId, {
    query: { enabled: !!itemId, queryKey: getGetItemQueryKey(itemId) }
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
        enabled: !!itemId,
        queryKey: getListStockTransfersQueryKey({ itemId }),
      },
    },
  );
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  
  const adjustMutation = useAdjustItemStock({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetItemQueryKey(itemId) });
        setDialogOpen(false);
        form.reset();
        toast({ title: "Stock adjusted successfully" });
      }
    }
  });

  const form = useForm<AdjustStockFormValues>({
    resolver: zodResolver(adjustStockSchema),
    defaultValues: {
      quantity: 0,
      reason: "manual_adjustment",
      notes: "",
    }
  });

  const onSubmit = (data: AdjustStockFormValues) => {
    adjustMutation.mutate({
      id: itemId,
      data: {
        warehouseId: data.warehouseId,
        quantity: data.quantity,
        reason: data.reason,
        notes: data.notes || null,
      }
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

  const { item, stockByWarehouse } = itemDetail;

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
        />
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Item Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-y-4 gap-x-8">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Category</p>
                <p>{item.category || "-"}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Unit</p>
                <p>{item.unit}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Sale Price</p>
                <p>{formatCurrency(item.salePrice)}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Purchase Price</p>
                <p>{formatCurrency(item.purchasePrice)}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Tax Rate</p>
                <p>{item.taxRate}%</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">HSN Code</p>
                <p>{item.hsnCode || "-"}</p>
              </div>
            </div>
            {item.description && (
              <div className="pt-4 border-t">
                <p className="text-sm font-medium text-muted-foreground mb-1">Description</p>
                <p className="text-sm">{item.description}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Total Stock</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{item.totalStock} {item.unit}</div>
              <p className="text-sm text-muted-foreground mt-1">Reorder level: {item.reorderLevel}</p>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Stock by Warehouse</CardTitle>
            <CardDescription>Current inventory levels across all locations.</CardDescription>
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
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <FormField
                    control={form.control}
                    name="warehouseId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Warehouse</FormLabel>
                        <Select onValueChange={(val) => field.onChange(parseInt(val))} value={field.value?.toString() || ""}>
                          <FormControl>
                            <SelectTrigger data-testid="select-warehouse">
                              <SelectValue placeholder="Select a warehouse" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {warehouses?.map(w => (
                              <SelectItem key={w.id} value={w.id.toString()}>{w.name}</SelectItem>
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
                        <FormLabel>Adjustment Quantity (use negative for removal)</FormLabel>
                        <FormControl>
                          <Input type="number" {...field} data-testid="input-adjust-qty" />
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
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-reason">
                              <SelectValue placeholder="Select a reason" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="manual_adjustment">Manual Adjustment</SelectItem>
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
                          <Input {...field} data-testid="input-adjust-notes" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <div className="flex justify-end pt-4">
                    <Button type="submit" disabled={adjustMutation.isPending} data-testid="btn-submit-adjust">
                      {adjustMutation.isPending ? "Adjusting..." : "Apply Adjustment"}
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
                <TableHead className="text-right">Quantity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stockByWarehouse.map((stock) => (
                <TableRow key={stock.warehouseId} data-testid={`row-stock-wh-${stock.warehouseId}`}>
                  <TableCell className="font-medium">{stock.warehouseName}</TableCell>
                  <TableCell className="text-right">{stock.quantity}</TableCell>
                </TableRow>
              ))}
              {stockByWarehouse.length === 0 && (
                <TableRow>
                  <TableCell colSpan={2} className="text-center py-4 text-muted-foreground">
                    No stock available in any warehouse.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

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
    </div>
  );
}
