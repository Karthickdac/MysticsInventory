import { Link } from "wouter";
import { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import {
  useListJobWorkOrders,
  useListSuppliers,
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
import { Plus } from "lucide-react";
import { StatusBadge } from "@/components/StatusBadge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "issued", label: "Issued" },
  { value: "partially_received", label: "Partially received" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

export default function JobWorkOrders() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [supplierFilter, setSupplierFilter] = useState<string>("all");

  const { data: suppliers } = useListSuppliers();
  const jobWorkers = (suppliers ?? []).filter((s) => s.isJobWorker);

  const {
    data: orders,
    isLoading,
    isError,
    error,
    refetch,
  } = useListJobWorkOrders({
    status: statusFilter === "all" ? undefined : statusFilter,
    supplierId:
      supplierFilter === "all" ? undefined : Number(supplierFilter),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Job Work"
        description="Send raw materials to outside workers and track finished goods."
        actions={
          <Button asChild data-testid="btn-create-job-work-order">
            <Link href="/job-work/new">
              <Plus className="mr-2 h-4 w-4" />
              New Job Work Order
            </Link>
          </Button>
        }
      />

      <div className="flex flex-col sm:flex-row sm:items-end gap-4 bg-card border rounded-lg p-4">
        <div className="space-y-1 w-full sm:w-56">
          <Label>Status</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger data-testid="filter-jwo-status">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 w-full sm:w-64">
          <Label>Job worker</Label>
          <Select value={supplierFilter} onValueChange={setSupplierFilter}>
            <SelectTrigger data-testid="filter-jwo-supplier">
              <SelectValue placeholder="All workers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All workers</SelectItem>
              {jobWorkers.map((s) => (
                <SelectItem key={s.id} value={s.id.toString()}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>JWO #</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Job worker</TableHead>
              <TableHead>Output</TableHead>
              <TableHead className="text-right">Planned</TableHead>
              <TableHead className="text-right">Received</TableHead>
              <TableHead className="text-right">Pending</TableHead>
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
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center text-sm">
                  <div className="space-y-2">
                    <p className="text-destructive">
                      Could not load job work orders.
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {(error as Error)?.message ?? "Unknown error"}
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => refetch()}
                      data-testid="btn-jwo-retry"
                    >
                      Try again
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ) : (orders ?? []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center">
                  No job work orders yet. Create one to send materials to a
                  job worker.
                </TableCell>
              </TableRow>
            ) : (
              orders?.map((o) => {
                const planned = Number(o.outputQuantity);
                const received = Number(o.receivedQuantity ?? 0);
                const pending = Number(
                  o.remainingQuantity ?? Math.max(0, planned - received),
                );
                return (
                  <TableRow key={o.id} data-testid={`row-jwo-${o.id}`}>
                    <TableCell className="font-mono">
                      <Link
                        href={`/job-work/${o.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {o.jwoNumber}
                      </Link>
                    </TableCell>
                    <TableCell>{formatDate(o.createdAt)}</TableCell>
                    <TableCell>{o.supplierName}</TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span>{o.outputItemName}</span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {o.outputItemSku}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {planned}
                    </TableCell>
                    <TableCell className="text-right">{received}</TableCell>
                    <TableCell className="text-right">
                      <span
                        className={
                          pending > 0
                            ? "text-orange-600 font-medium"
                            : "text-muted-foreground"
                        }
                      >
                        {pending}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={o.status} />
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
