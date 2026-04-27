import { PageHeader } from "@/components/PageHeader";
import { useGetLowStockReport } from "@/lib/queryKeys";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { Link } from "wouter";

export default function ReportLowStock() {
  const { data: rows, isLoading } = useGetLowStockReport();

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
      </div>

      <div className="rounded-md border bg-card shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>SKU</TableHead>
              <TableHead>Item Name</TableHead>
              <TableHead className="text-right">Reorder Level</TableHead>
              <TableHead className="text-right">Current Qty</TableHead>
              <TableHead className="text-right font-bold text-foreground">Deficit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center">Loading...</TableCell>
              </TableRow>
            ) : rows?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-48 text-center text-muted-foreground flex-col flex items-center justify-center">
                  <div className="bg-green-100 dark:bg-green-900/20 p-3 rounded-full mb-3">
                    <AlertTriangle className="h-6 w-6 text-green-600 dark:text-green-500" />
                  </div>
                  All items have sufficient stock.
                </TableCell>
              </TableRow>
            ) : (
              rows?.map((row) => (
                <TableRow key={row.itemId} className="bg-red-50/50 hover:bg-red-50/80 dark:bg-red-950/10 dark:hover:bg-red-950/20">
                  <TableCell className="font-mono text-xs text-muted-foreground">{row.sku}</TableCell>
                  <TableCell className="font-medium">
                    <Link href={`/items/${row.itemId}`} className="hover:underline">{row.name}</Link>
                  </TableCell>
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
