import { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { useGetInventoryValuationReport, useListWarehouses, useListItems } from "@/lib/queryKeys";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import { ReportExportButton, type ExportColumn } from "@/components/ReportExportButton";
import { Card, CardContent } from "@/components/ui/card";

export default function ReportInventoryValuation() {
  const [showBatches, setShowBatches] = useState(false);
  const [warehouseId, setWarehouseId] = useState<string>("");
  const [itemId, setItemId] = useState<string>("");
  const [search, setSearch] = useState<string>("");

  const { data: warehouses } = useListWarehouses();
  const { data: items } = useListItems();

  const { data: rows, isLoading } = useGetInventoryValuationReport({
    showBatches: showBatches || undefined,
    ...(warehouseId ? { warehouseId: Number(warehouseId) } : {}),
    ...(itemId ? { itemId: Number(itemId) } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
  });

  const totalValue = rows?.reduce((sum, row) => sum + row.totalValue, 0) || 0;
  const colSpan = showBatches ? 7 : 5;

  const hasFilters = !!(warehouseId || itemId || search.trim());
  const clearFilters = () => { setWarehouseId(""); setItemId(""); setSearch(""); };

  type Row = NonNullable<typeof rows>[number];
  const exportColumns: ExportColumn<Row>[] = [
    { header: "SKU", accessor: (r) => r.sku },
    { header: "Item Name", accessor: (r) => r.name },
    ...(showBatches
      ? [
          { header: "Batch #", accessor: (r: Row) => r.batchNumber ?? "" },
          {
            header: "Expiry",
            accessor: (r: Row) => (r.expiryDate ? formatDate(r.expiryDate) : ""),
          },
        ]
      : []),
    { header: "Qty on Hand", accessor: (r) => r.quantityOnHand },
    { header: "Unit Cost", accessor: (r) => r.unitCost },
    { header: "Total Value", accessor: (r) => r.totalValue },
  ];

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/reports">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <PageHeader
          title="Inventory Valuation"
          description="Total value of items currently in stock."
          className="mb-0"
        />
      </div>

      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Search</label>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Item name or SKU..."
              className="w-52"
              data-testid="input-report-search"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Warehouse</label>
            <Select value={warehouseId} onValueChange={setWarehouseId}>
              <SelectTrigger className="w-48" data-testid="select-report-warehouse">
                <SelectValue placeholder="All warehouses" />
              </SelectTrigger>
              <SelectContent>
                {warehouses?.map((w) => (
                  <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Item</label>
            <Select value={itemId} onValueChange={setItemId}>
              <SelectTrigger className="w-52" data-testid="select-report-item">
                <SelectValue placeholder="All items" />
              </SelectTrigger>
              <SelectContent>
                {items?.map((i) => (
                  <SelectItem key={i.id} value={String(i.id)}>{i.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters} data-testid="button-report-clear">Clear</Button>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Switch
            id="toggle-show-batches"
            checked={showBatches}
            onCheckedChange={setShowBatches}
            data-testid="toggle-show-batches"
          />
          <Label htmlFor="toggle-show-batches" className="cursor-pointer">
            Show batches
          </Label>
          <span className="text-xs text-muted-foreground">
            Expand batch-tracked items into one row per batch.
          </span>
          <ReportExportButton
            filename="inventory-valuation"
            title="Inventory Valuation"
            columns={exportColumns}
            rows={rows ?? []}
            disabled={isLoading}
            meta={[
              { label: "Total Stock Value", value: formatCurrency(totalValue) },
              { label: "Batches expanded", value: showBatches ? "Yes" : "No" },
            ]}
          />
        </div>
        <div className="bg-card border rounded-lg px-6 py-4 flex flex-col items-end shadow-sm">
          <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Total Stock Value
          </span>
          <span
            className="text-3xl font-bold text-primary"
            data-testid="text-total-value"
          >
            {formatCurrency(totalValue)}
          </span>
        </div>
      </div>

      <div className="rounded-md border bg-card shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>SKU</TableHead>
              <TableHead>Item Name</TableHead>
              {showBatches && <TableHead>Batch #</TableHead>}
              {showBatches && <TableHead>Expiry</TableHead>}
              <TableHead className="text-right">Qty on Hand</TableHead>
              <TableHead className="text-right">Unit Cost</TableHead>
              <TableHead className="text-right font-bold text-foreground">
                Total Value
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={colSpan} className="h-24 text-center">
                  Loading...
                </TableCell>
              </TableRow>
            ) : rows?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={colSpan} className="h-24 text-center">
                  No inventory found.
                </TableCell>
              </TableRow>
            ) : (
              rows?.map((row) => {
                const key = row.isBatch
                  ? `batch-${row.itemBatchId}`
                  : `item-${row.itemId}`;
                return (
                  <TableRow
                    key={key}
                    data-testid={`row-${key}`}
                    className={row.isBatch ? "bg-muted/20" : undefined}
                  >
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {row.sku}
                    </TableCell>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {row.name}
                        {row.isBatch && (
                          <Badge variant="secondary">Batch</Badge>
                        )}
                      </div>
                    </TableCell>
                    {showBatches && (
                      <TableCell className="font-mono text-xs">
                        {row.batchNumber ?? "—"}
                      </TableCell>
                    )}
                    {showBatches && (
                      <TableCell className="text-sm">
                        {row.expiryDate ? formatDate(row.expiryDate) : "—"}
                      </TableCell>
                    )}
                    <TableCell className="text-right">
                      {row.quantityOnHand}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(row.unitCost)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCurrency(row.totalValue)}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
