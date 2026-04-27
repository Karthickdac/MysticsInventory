import { Link } from "wouter";
import { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import {
  useListStockTransfers,
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
import { formatDate } from "@/lib/format";
import { Plus, ArrowRight } from "lucide-react";
import { StatusBadge } from "@/components/StatusBadge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";


export default function StockTransfers() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [warehouseFilter, setWarehouseFilter] = useState<string>("all");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");

  const { data: warehouses } = useListWarehouses();
  const { data: transfers, isLoading } = useListStockTransfers({
    status: statusFilter === "all" ? undefined : statusFilter,
    warehouseId:
      warehouseFilter === "all" ? undefined : Number(warehouseFilter),
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
  });

  const hasDateFilter = fromDate !== "" || toDate !== "";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock Transfers"
        description="Move inventory between your warehouses."
        actions={
          <Button asChild data-testid="btn-create-transfer">
            <Link href="/transfers/new">
              <Plus className="mr-2 h-4 w-4" />
              New Transfer
            </Link>
          </Button>
        }
      />

      <div className="flex flex-col sm:flex-row sm:items-end gap-4 bg-card border rounded-lg p-4">
        <div className="space-y-1 w-full sm:w-56">
          <Label>Status</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger data-testid="filter-transfer-status">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="in_transit">In transit</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 w-full sm:w-64">
          <Label>Warehouse (source or destination)</Label>
          <Select
            value={warehouseFilter}
            onValueChange={setWarehouseFilter}
          >
            <SelectTrigger data-testid="filter-transfer-warehouse">
              <SelectValue placeholder="All Warehouses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Warehouses</SelectItem>
              {warehouses?.map((w) => (
                <SelectItem key={w.id} value={w.id.toString()}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 w-full sm:w-44">
          <Label>From date</Label>
          <Input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            data-testid="filter-transfer-from-date"
          />
        </div>
        <div className="space-y-1 w-full sm:w-44">
          <Label>To date</Label>
          <Input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            data-testid="filter-transfer-to-date"
          />
        </div>
        {hasDateFilter && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFromDate("");
              setToDate("");
            }}
            data-testid="btn-clear-transfer-dates"
          >
            Clear dates
          </Button>
        )}
      </div>

      <div className="rounded-md border bg-card">
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
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center">
                  Loading...
                </TableCell>
              </TableRow>
            ) : transfers?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center">
                  No transfers found.
                </TableCell>
              </TableRow>
            ) : (
              transfers?.map((tr) => (
                <TableRow key={tr.id} data-testid={`row-transfer-${tr.id}`}>
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
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
