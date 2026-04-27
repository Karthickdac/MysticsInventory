import { PageHeader } from "@/components/PageHeader";
import { useGetInventoryValuationReport } from "@/lib/queryKeys";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { Link } from "wouter";

export default function ReportInventoryValuation() {
  const { data: rows, isLoading } = useGetInventoryValuationReport();

  const totalValue = rows?.reduce((sum, row) => sum + row.totalValue, 0) || 0;

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

      <div className="flex justify-end mb-4">
        <div className="bg-card border rounded-lg px-6 py-4 flex flex-col items-end shadow-sm">
          <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Total Stock Value</span>
          <span className="text-3xl font-bold text-primary">{formatCurrency(totalValue)}</span>
        </div>
      </div>

      <div className="rounded-md border bg-card shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>SKU</TableHead>
              <TableHead>Item Name</TableHead>
              <TableHead className="text-right">Qty on Hand</TableHead>
              <TableHead className="text-right">Unit Cost</TableHead>
              <TableHead className="text-right font-bold text-foreground">Total Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center">Loading...</TableCell>
              </TableRow>
            ) : rows?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center">No inventory found.</TableCell>
              </TableRow>
            ) : (
              rows?.map((row) => (
                <TableRow key={row.itemId}>
                  <TableCell className="font-mono text-xs text-muted-foreground">{row.sku}</TableCell>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell className="text-right">{row.quantityOnHand}</TableCell>
                  <TableCell className="text-right">{formatCurrency(row.unitCost)}</TableCell>
                  <TableCell className="text-right font-medium">{formatCurrency(row.totalValue)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
