import { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import {
  useGetBatchesNearExpiryReport,
  useListWarehouses,
} from "@/lib/queryKeys";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, CalendarClock } from "lucide-react";
import { Link } from "wouter";
import { formatDate } from "@/lib/format";
import { ReportExportButton, type ExportColumn } from "@/components/ReportExportButton";

export default function ReportBatchesNearExpiry() {
  const [days, setDays] = useState<number>(30);
  const [warehouseId, setWarehouseId] = useState<string>("all");
  const { data: warehouses } = useListWarehouses();
  const params = {
    days,
    ...(warehouseId !== "all"
      ? { warehouseId: Number(warehouseId) }
      : {}),
  };
  const { data: rows, isLoading } = useGetBatchesNearExpiryReport(params);

  type Row = NonNullable<typeof rows>[number];
  const exportColumns: ExportColumn<Row>[] = [
    { header: "SKU", accessor: (r) => r.sku },
    { header: "Item", accessor: (r) => r.itemName },
    { header: "Batch #", accessor: (r) => r.batchNumber ?? "" },
    { header: "Mfg date", accessor: (r) => (r.mfgDate ? formatDate(r.mfgDate) : "") },
    { header: "Expiry", accessor: (r) => formatDate(r.expiryDate) },
    { header: "Warehouse", accessor: (r) => r.warehouseName },
    { header: "Qty on hand", accessor: (r) => r.quantity },
    {
      header: "Status",
      accessor: (r) =>
        r.expired
          ? `Expired (${-r.daysUntilExpiry}d ago)`
          : `${r.daysUntilExpiry}d left`,
    },
  ];
  const warehouseLabel =
    warehouseId === "all"
      ? "All warehouses"
      : warehouses?.find((w) => String(w.id) === warehouseId)?.name ?? "—";

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/reports">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <PageHeader
          title="Batches Near Expiry"
          description="Batch-tracked stock that has already expired or expires within the chosen window."
          className="mb-0"
        />
        <div className="ml-auto">
          <ReportExportButton
            filename="batches-near-expiry"
            title="Batches Near Expiry"
            columns={exportColumns}
            rows={rows ?? []}
            disabled={isLoading}
            meta={[
              { label: "Window", value: `${days} days` },
              { label: "Warehouse", value: warehouseLabel },
            ]}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-2">
          <Label htmlFor="days">Window (days)</Label>
          <Input
            id="days"
            type="number"
            min={0}
            max={3650}
            step={1}
            value={days}
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next) && next >= 0)
                setDays(Math.floor(next));
            }}
            className="w-32"
            data-testid="input-window-days"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="warehouse">Warehouse</Label>
          <Select value={warehouseId} onValueChange={setWarehouseId}>
            <SelectTrigger
              id="warehouse"
              className="w-56"
              data-testid="select-warehouse"
            >
              <SelectValue placeholder="All warehouses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All warehouses</SelectItem>
              {(warehouses ?? []).map((w) => (
                <SelectItem key={w.id} value={String(w.id)}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-md border bg-card shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>SKU</TableHead>
              <TableHead>Item</TableHead>
              <TableHead>Batch #</TableHead>
              <TableHead>Mfg date</TableHead>
              <TableHead>Expiry</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead className="text-right">Qty on hand</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center">
                  Loading...
                </TableCell>
              </TableRow>
            ) : !rows || rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="py-12 text-center text-muted-foreground"
                >
                  <div className="flex flex-col items-center justify-center">
                    <div className="bg-green-100 dark:bg-green-900/20 p-3 rounded-full mb-3">
                      <CalendarClock className="h-6 w-6 text-green-600 dark:text-green-500" />
                    </div>
                    No batches expire within the selected window.
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => {
                const status = r.expired
                  ? {
                      label: `Expired (${-r.daysUntilExpiry}d ago)`,
                      variant: "destructive" as const,
                    }
                  : r.daysUntilExpiry <= 7
                    ? {
                        label: `${r.daysUntilExpiry}d left`,
                        variant: "destructive" as const,
                      }
                    : {
                        label: `${r.daysUntilExpiry}d left`,
                        variant: "secondary" as const,
                      };
                return (
                  <TableRow
                    key={`${r.itemBatchId}-${r.warehouseId}`}
                    data-testid={`row-batch-expiry-${r.itemBatchId}-${r.warehouseId}`}
                    className={
                      r.expired
                        ? "bg-red-50/50 hover:bg-red-50/80 dark:bg-red-950/10 dark:hover:bg-red-950/20"
                        : undefined
                    }
                  >
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {r.sku}
                    </TableCell>
                    <TableCell className="font-medium">
                      <Link
                        href={`/items/${r.itemId}`}
                        className="hover:underline"
                      >
                        {r.itemName}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {r.batchNumber}
                    </TableCell>
                    <TableCell>
                      {r.mfgDate ? formatDate(r.mfgDate) : "-"}
                    </TableCell>
                    <TableCell>{formatDate(r.expiryDate)}</TableCell>
                    <TableCell>{r.warehouseName}</TableCell>
                    <TableCell className="text-right">
                      {r.quantity}
                    </TableCell>
                    <TableCell>
                      <Badge variant={status.variant}>{status.label}</Badge>
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
