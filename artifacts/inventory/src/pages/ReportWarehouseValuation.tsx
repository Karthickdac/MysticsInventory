import { useState, useMemo } from "react";
import { PageHeader } from "@/components/PageHeader";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import { ReportExportButton, type ExportColumn } from "@/components/ReportExportButton";

type WarehouseValuationRow = {
  warehouseId: number;
  warehouseName: string;
  itemId: number;
  itemName: string;
  sku: string;
  category: string | null;
  quantity: number;
  unitCost: number;
  totalValue: number;
};

function useWarehouseValuationReport() {
  return useQuery<WarehouseValuationRow[]>({
    queryKey: ["reports", "inventory-valuation-by-warehouse"],
    queryFn: () =>
      customFetch<WarehouseValuationRow[]>(
        "/api/reports/inventory-valuation-by-warehouse",
        { method: "GET" },
      ),
  });
}

export default function ReportWarehouseValuation() {
  const { data: rows, isLoading } = useWarehouseValuationReport();
  const [selectedWarehouse, setSelectedWarehouse] = useState<string>("all");

  const warehouses = useMemo(() => {
    if (!rows) return [];
    const seen = new Map<number, string>();
    for (const r of rows) {
      if (!seen.has(r.warehouseId)) seen.set(r.warehouseId, r.warehouseName);
    }
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }, [rows]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    if (selectedWarehouse === "all") return rows;
    const id = Number(selectedWarehouse);
    return rows.filter((r) => r.warehouseId === id);
  }, [rows, selectedWarehouse]);

  const totalValue = filtered.reduce((sum, r) => sum + r.totalValue, 0);

  const groups = useMemo(() => {
    const map = new Map<
      number,
      { warehouseId: number; warehouseName: string; rows: WarehouseValuationRow[]; subtotal: number }
    >();
    for (const r of filtered) {
      let g = map.get(r.warehouseId);
      if (!g) {
        g = { warehouseId: r.warehouseId, warehouseName: r.warehouseName, rows: [], subtotal: 0 };
        map.set(r.warehouseId, g);
      }
      g.rows.push(r);
      g.subtotal += r.totalValue;
    }
    return Array.from(map.values());
  }, [filtered]);

  type Row = WarehouseValuationRow;
  const exportColumns: ExportColumn<Row>[] = [
    { header: "Warehouse", accessor: (r) => r.warehouseName },
    { header: "Item Name", accessor: (r) => r.itemName },
    { header: "SKU", accessor: (r) => r.sku },
    { header: "Category", accessor: (r) => r.category ?? "" },
    { header: "Quantity", accessor: (r) => r.quantity },
    { header: "Unit Cost", accessor: (r) => r.unitCost },
    { header: "Total Value", accessor: (r) => r.totalValue },
  ];

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/reports">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <PageHeader
          title="Warehouse-Wise Inventory Valuation"
          description="Stock value for every item broken down by warehouse location."
          className="mb-0"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Select value={selectedWarehouse} onValueChange={setSelectedWarehouse}>
            <SelectTrigger className="w-52" data-testid="select-warehouse-filter">
              <SelectValue placeholder="All warehouses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All warehouses</SelectItem>
              {warehouses.map((w) => (
                <SelectItem key={w.id} value={String(w.id)}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ReportExportButton
            filename="warehouse-inventory-valuation"
            title="Warehouse-Wise Inventory Valuation"
            columns={exportColumns}
            rows={filtered}
            disabled={isLoading}
            meta={[
              { label: "Warehouse", value: selectedWarehouse === "all" ? "All" : (warehouses.find((w) => String(w.id) === selectedWarehouse)?.name ?? "") },
              { label: "Total Value", value: formatCurrency(totalValue) },
            ]}
          />
        </div>
        <div className="bg-card border rounded-lg px-6 py-4 flex flex-col items-end shadow-sm">
          <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Total Value
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
              <TableHead>Item</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
              <TableHead className="text-right">Unit Cost</TableHead>
              <TableHead className="text-right font-bold text-foreground">
                Total Value
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center">
                  Loading...
                </TableCell>
              </TableRow>
            ) : groups.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center">
                  No inventory found.
                </TableCell>
              </TableRow>
            ) : (
              groups.flatMap((group) => [
                <TableRow
                  key={`wh-header-${group.warehouseId}`}
                  className="bg-muted/50 hover:bg-muted/50"
                  data-testid={`row-wh-header-${group.warehouseId}`}
                >
                  <TableCell
                    colSpan={6}
                    className="font-semibold text-foreground"
                  >
                    {group.warehouseName}
                  </TableCell>
                </TableRow>,
                ...group.rows.map((row, idx) => (
                  <TableRow
                    key={`wh-${group.warehouseId}-item-${row.itemId}-${idx}`}
                    data-testid={`row-wh-${group.warehouseId}-item-${row.itemId}`}
                  >
                    <TableCell className="font-medium">{row.itemName}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {row.sku}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.category ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">{row.quantity}</TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(row.unitCost)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCurrency(row.totalValue)}
                    </TableCell>
                  </TableRow>
                )),
                <TableRow
                  key={`wh-subtotal-${group.warehouseId}`}
                  className="bg-muted/30 hover:bg-muted/30"
                  data-testid={`row-wh-subtotal-${group.warehouseId}`}
                >
                  <TableCell colSpan={5} className="text-right font-bold">
                    {group.warehouseName} Subtotal
                  </TableCell>
                  <TableCell
                    className="text-right font-bold"
                    data-testid={`text-wh-subtotal-${group.warehouseId}`}
                  >
                    {formatCurrency(group.subtotal)}
                  </TableCell>
                </TableRow>,
              ])
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
