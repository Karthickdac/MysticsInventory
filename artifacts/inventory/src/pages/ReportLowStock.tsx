import { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { useGetLowStockReport, useListWarehouses } from "@/lib/queryKeys";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { Link } from "wouter";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { ReportExportButton, type ExportColumn } from "@/components/ReportExportButton";

export default function ReportLowStock() {
  const [warehouseId, setWarehouseId] = useState<string>("");
  const [search, setSearch] = useState<string>("");

  const { data: warehouses } = useListWarehouses();

  const { data: rows, isLoading } = useGetLowStockReport({
    ...(warehouseId ? { warehouseId: Number(warehouseId) } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
  });

  const hasFilters = !!(warehouseId || search.trim());
  const clearFilters = () => { setWarehouseId(""); setSearch(""); };

  type Row = NonNullable<typeof rows>[number];
  const exportColumns: ExportColumn<Row>[] = [
    { header: "SKU", accessor: (r) => r.sku },
    { header: "Item Name", accessor: (r) => r.name },
    { header: "Barcode", accessor: (r) => r.barcode ?? "" },
    { header: "Warehouse", accessor: (r) => r.warehouseName },
    { header: "Min Stock Level", accessor: (r) => r.reorderLevel },
    { header: "Current Stock", accessor: (r) => r.quantityOnHand },
    { header: "Deficit", accessor: (r) => r.deficit },
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
          title="Low Stock Alerts" 
          description="Items that are below their configured reorder level."
          className="mb-0"
        />
        <div className="ml-auto">
          <ReportExportButton
            filename="low-stock"
            title="Low Stock Alerts"
            columns={exportColumns}
            rows={rows ?? []}
            disabled={isLoading}
          />
        </div>
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
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters} data-testid="button-report-clear">Clear</Button>
          )}
        </CardContent>
      </Card>

      <div className="rounded-md border bg-card shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>SKU</TableHead>
              <TableHead>Item Name</TableHead>
              <TableHead>Barcode</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead className="text-right">Min Stock Level</TableHead>
              <TableHead className="text-right">Current Stock</TableHead>
              <TableHead className="text-right font-bold text-foreground">Deficit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center">Loading...</TableCell>
              </TableRow>
            ) : rows?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-48 text-center text-muted-foreground flex-col flex items-center justify-center">
                  <div className="bg-green-100 dark:bg-green-900/20 p-3 rounded-full mb-3">
                    <AlertTriangle className="h-6 w-6 text-green-600 dark:text-green-500" />
                  </div>
                  All items have sufficient stock.
                </TableCell>
              </TableRow>
            ) : (
              rows?.map((row, idx) => (
                <TableRow key={`${row.itemId}-${row.warehouseId}-${idx}`} className="bg-red-50/50 hover:bg-red-50/80 dark:bg-red-950/10 dark:hover:bg-red-950/20">
                  <TableCell className="font-mono text-xs text-muted-foreground">{row.sku}</TableCell>
                  <TableCell className="font-medium">
                    <Link href={`/items/${row.itemId}`} className="hover:underline">{row.name}</Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{row.barcode ?? <span className="text-muted-foreground/50">—</span>}</TableCell>
                  <TableCell>{row.warehouseName}</TableCell>
                  <TableCell className="text-right">{row.reorderLevel}</TableCell>
                  <TableCell className="text-right font-bold text-red-600 dark:text-red-500">{row.quantityOnHand}</TableCell>
                  <TableCell className="text-right font-medium text-red-600 dark:text-red-500">{row.deficit}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
