import { PageHeader } from "@/components/PageHeader";
import { useGetSalesSummaryReport, useListCustomers, useListWarehouses } from "@/lib/queryKeys";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { format, parseISO } from "date-fns";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState } from "react";
import { ReportExportButton, type ExportColumn } from "@/components/ReportExportButton";

export default function ReportSalesSummary() {
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [customerId, setCustomerId] = useState<string>("");
  const [warehouseId, setWarehouseId] = useState<string>("");

  const { data: customers } = useListCustomers();
  const { data: warehouses } = useListWarehouses();

  const { data: report, isLoading } = useGetSalesSummaryReport({
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(customerId ? { customerId: Number(customerId) } : {}),
    ...(warehouseId ? { warehouseId: Number(warehouseId) } : {}),
  });

  const hasFilters = !!(from || to || customerId || warehouseId);
  const clearFilters = () => { setFrom(""); setTo(""); setCustomerId(""); setWarehouseId(""); };

  if (isLoading || !report) {
    return <div className="space-y-6"><Skeleton className="h-40 w-full" /></div>;
  }

  type CustomerRow = (typeof report.byCustomer)[number];
  const exportColumns: ExportColumn<CustomerRow>[] = [
    { header: "Customer Name", accessor: (r) => r.customerName },
    { header: "Orders", accessor: (r) => r.orderCount },
    { header: "Total Revenue", accessor: (r) => r.total },
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
          title="Sales Summary" 
          description="Revenue and customer performance."
          className="mb-0"
        />
        <div className="ml-auto">
          <ReportExportButton
            filename="sales-summary"
            title="Sales Summary — by Customer"
            columns={exportColumns}
            rows={report.byCustomer}
            meta={[
              { label: "Total Sales", value: formatCurrency(report.totalSales) },
              { label: "Order Count", value: String(report.orderCount) },
              { label: "Average Order Value", value: formatCurrency(report.averageOrderValue) },
            ]}
          />
        </div>
      </div>

      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="sales-from">From</label>
            <Input id="sales-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="input-report-from" className="w-44" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="sales-to">To</label>
            <Input id="sales-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="input-report-to" className="w-44" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Customer</label>
            <Select value={customerId} onValueChange={setCustomerId}>
              <SelectTrigger className="w-48" data-testid="select-report-customer">
                <SelectValue placeholder="All customers" />
              </SelectTrigger>
              <SelectContent>
                {customers?.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
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

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="p-6">
            <p className="text-sm font-medium text-muted-foreground mb-1">Total Sales</p>
            <p className="text-3xl font-bold text-primary">{formatCurrency(report.totalSales)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm font-medium text-muted-foreground mb-1">Orders Count</p>
            <p className="text-3xl font-bold">{report.orderCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm font-medium text-muted-foreground mb-1">Average Order Value</p>
            <p className="text-3xl font-bold">{formatCurrency(report.averageOrderValue)}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sales Trend</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={report.trend} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis 
                  dataKey="date" 
                  tickFormatter={(val) => format(parseISO(val), "d MMM")}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis 
                  tickFormatter={(val) => `₹${(val / 1000).toFixed(0)}k`}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip 
                  formatter={(value: number) => formatCurrency(value)}
                  labelFormatter={(label: string) => format(parseISO(label), "d MMM yyyy")}
                />
                <Area 
                  type="monotone" 
                  dataKey="sales" 
                  name="Sales"
                  stroke="hsl(var(--primary))" 
                  fillOpacity={1} 
                  fill="url(#colorSales)" 
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sales by Customer</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer Name</TableHead>
                <TableHead className="text-right">Orders</TableHead>
                <TableHead className="text-right font-bold">Total Revenue</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.byCustomer.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="h-24 text-center">No sales data.</TableCell>
                </TableRow>
              ) : (
                report.byCustomer.map((row) => (
                  <TableRow key={row.customerId}>
                    <TableCell className="font-medium">{row.customerName}</TableCell>
                    <TableCell className="text-right">{row.orderCount}</TableCell>
                    <TableCell className="text-right font-medium">{formatCurrency(row.total)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
