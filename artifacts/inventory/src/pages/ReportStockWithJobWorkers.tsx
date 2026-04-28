import { Link } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import { useReportStockWithJobWorkers } from "@/lib/queryKeys";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

export default function ReportStockWithJobWorkers() {
  const { data, isLoading } = useReportStockWithJobWorkers();
  const rows = data?.rows ?? [];

  // Group rows by supplier for easier scanning.
  const grouped = rows.reduce<
    Record<
      number,
      { supplierName: string; items: typeof rows }
    >
  >((acc, row) => {
    if (!acc[row.supplierId]) {
      acc[row.supplierId] = {
        supplierName: row.supplierName,
        items: [],
      };
    }
    acc[row.supplierId].items.push(row);
    return acc;
  }, {});
  const groupedList = Object.entries(grouped).map(([id, g]) => ({
    supplierId: Number(id),
    supplierName: g.supplierName,
    items: g.items,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock with Job Workers"
        description="Materials currently sitting at outside job workers, by worker."
        actions={
          <Button variant="outline" asChild>
            <Link href="/reports">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to reports
            </Link>
          </Button>
        }
      />

      {isLoading ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Loading...
          </CardContent>
        </Card>
      ) : groupedList.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No stock is currently held at any job worker.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {groupedList.map((group) => (
            <Card
              key={group.supplierId}
              data-testid={`group-${group.supplierId}`}
            >
              <CardContent className="pt-6">
                <div className="flex items-center justify-between mb-3">
                  <Link
                    href={`/suppliers/${group.supplierId}`}
                    className="text-base font-semibold text-primary hover:underline"
                  >
                    {group.supplierName}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {group.items.length} item
                    {group.items.length === 1 ? "" : "s"}
                  </span>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead className="text-right">Quantity</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {group.items.map((row) => (
                      <TableRow
                        key={`${row.warehouseId}-${row.itemId}`}
                        data-testid={`row-${row.warehouseId}-${row.itemId}`}
                      >
                        <TableCell>
                          <Link
                            href={`/items/${row.itemId}`}
                            className="hover:underline"
                          >
                            {row.itemName}
                          </Link>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {row.sku}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {Number(row.quantity)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
