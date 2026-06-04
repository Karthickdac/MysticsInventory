import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useListWarehouses } from "@/lib/queryKeys";
import { customFetch, type DashboardSummary } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { formatCurrency } from "@/lib/format";
import { StatCard } from "@/components/StatCard";
import { PageHeader } from "@/components/PageHeader";
import { Package, TrendingUp, AlertTriangle, ShoppingCart, ShoppingBag, CreditCard, Banknote, Clock, Receipt, Store } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { format, parseISO } from "date-fns";
import { Link } from "wouter";
import { getEinvoiceFixSummary } from "@/lib/einvoiceFixes";

function useDashboardSummary(warehouseId: number | undefined) {
  const url = warehouseId
    ? `/api/dashboard/summary?warehouseId=${warehouseId}`
    : `/api/dashboard/summary`;
  return useQuery<DashboardSummary>({
    queryKey: ["/api/dashboard/summary", warehouseId ?? null],
    queryFn: ({ signal }) => customFetch<DashboardSummary>(url, { signal }),
  });
}

export default function Dashboard() {
  const [warehouseId, setWarehouseId] = useState<number | undefined>(undefined);
  const { data: warehouses } = useListWarehouses();
  const { data: summary, isLoading } = useDashboardSummary(warehouseId);

  const visibleWarehouses = (warehouses ?? []).filter((w) => !w.isVirtual);

  if (isLoading || !summary) {
    return (
      <div className="space-y-6">
        <PageHeader title="Dashboard" />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-[400px] w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <PageHeader
          title="Dashboard"
          description="Overview of your inventory and sales performance."
          className="mb-0"
        />
        <div className="flex items-center gap-2 shrink-0">
          <Store className="h-4 w-4 text-muted-foreground" />
          <Select
            value={warehouseId ? warehouseId.toString() : "all"}
            onValueChange={(val) =>
              setWarehouseId(val === "all" ? undefined : parseInt(val))
            }
          >
            <SelectTrigger className="w-48" data-testid="select-dashboard-warehouse">
              <SelectValue placeholder="All Warehouses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Warehouses</SelectItem>
              {visibleWarehouses.map((w) => (
                <SelectItem key={w.id} value={w.id.toString()}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Open Sales Orders"
          value={summary.openSalesOrders}
          icon={<ShoppingCart className="h-4 w-4 text-muted-foreground" />}
        />
        <StatCard
          title="Sales This Month"
          value={formatCurrency(summary.salesThisMonth)}
          icon={<TrendingUp className="h-4 w-4 text-muted-foreground" />}
        />
        <Link href="/reports/low-stock" className="block">
          <StatCard
            title="Low Stock Alerts"
            value={summary.lowStockCount}
            icon={<AlertTriangle className="h-4 w-4 text-destructive" />}
            className={summary.lowStockCount > 0 ? "border-destructive/50 cursor-pointer hover:border-destructive/80 transition-colors" : "cursor-pointer hover:bg-muted/50 transition-colors"}
          />
        </Link>
        <StatCard
          title="Open Purchase Orders"
          value={summary.openPurchaseOrders}
          icon={<ShoppingBag className="h-4 w-4 text-muted-foreground" />}
        />
        <StatCard
          title="Outstanding Receivables"
          value={formatCurrency(summary.outstandingReceivables)}
          icon={<CreditCard className="h-4 w-4 text-muted-foreground" />}
        />
        <StatCard
          title="Outstanding Payables"
          value={formatCurrency(summary.outstandingPayables)}
          icon={<Clock className="h-4 w-4 text-muted-foreground" />}
        />
        <StatCard
          title="Total Items"
          value={summary.totalItems}
          icon={<Package className="h-4 w-4 text-muted-foreground" />}
        />
        <StatCard
          title="Total Stock Value"
          value={formatCurrency(summary.totalStockValue)}
          icon={<Banknote className="h-4 w-4 text-muted-foreground" />}
        />
      </div>

      <div className="grid gap-6 md:grid-cols-7">
        <Card className="md:col-span-4 lg:col-span-5">
          <CardHeader>
            <CardTitle>Sales vs Purchases (30 Days)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[350px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={summary.salesTrend} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="colorPurchases" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--muted-foreground))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--muted-foreground))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="date"
                    tickFormatter={(val) => format(parseISO(val), "d MMM")}
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                    dy={10}
                  />
                  <YAxis
                    tickFormatter={(val) => `₹${(val / 1000).toFixed(0)}k`}
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                    dx={-10}
                  />
                  <Tooltip
                    formatter={(value: number) => formatCurrency(value)}
                    labelFormatter={(label: string) => format(parseISO(label), "d MMM yyyy")}
                    contentStyle={{ borderRadius: "8px", border: "1px solid hsl(var(--border))" }}
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
                  <Area
                    type="monotone"
                    dataKey="purchases"
                    name="Purchases"
                    stroke="hsl(var(--muted-foreground))"
                    fillOpacity={1}
                    fill="url(#colorPurchases)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="md:col-span-3 lg:col-span-2 flex flex-col">
          <CardHeader>
            <CardTitle>Top Selling Items</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 px-0 pb-0">
            <ScrollArea className="h-[350px] px-6">
              <div className="space-y-6 pb-6">
                {summary.topItems.map((item, i) => (
                  <div key={item.itemId} className="flex items-center" data-testid={`row-top-item-${item.itemId}`}>
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary font-semibold text-sm">
                      {i + 1}
                    </div>
                    <div className="ml-4 space-y-1 overflow-hidden">
                      <p className="text-sm font-medium leading-none truncate" title={item.name}>{item.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{item.sku}</p>
                    </div>
                    <div className="ml-auto font-medium text-sm">
                      {formatCurrency(item.revenue)}
                    </div>
                  </div>
                ))}
                {summary.topItems.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-4">No sales data available yet.</p>
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      {summary.failedEinvoices.length > 0 && (
        <Card
          className="border-destructive/40"
          data-testid="card-failed-einvoices"
        >
          <CardHeader>
            <div className="flex items-start gap-3">
              <Receipt className="h-5 w-5 text-destructive" />
              <div>
                <CardTitle>Failed e-invoices</CardTitle>
                <CardDescription>
                  These orders couldn't be registered with the IRP. Each
                  link points at the exact record to fix.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {summary.failedEinvoices.map((entry) => {
                const fix = getEinvoiceFixSummary(
                  {
                    errorCode: entry.errorCode,
                    errorContext: entry.errorContext,
                  },
                  {
                    customerId: entry.customerId,
                    customerName: entry.customerName,
                  },
                );
                const fixSummary =
                  fix?.title ?? entry.error ?? "IRP submission failed";
                return (
                  <li
                    key={entry.salesOrderId}
                    className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between"
                    data-testid={`failed-einvoice-${entry.salesOrderId}`}
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2 text-sm">
                        <Link
                          href={`/sales-orders/${entry.salesOrderId}`}
                          className="font-mono font-medium text-primary hover:underline"
                        >
                          {entry.orderNumber}
                        </Link>
                        <span className="text-muted-foreground">·</span>
                        <span className="truncate text-muted-foreground">
                          {entry.customerName}
                        </span>
                      </div>
                      <p className="flex items-start gap-1 text-xs text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        <span className="break-words">{fixSummary}</span>
                      </p>
                    </div>
                    {fix && (
                      <Button
                        asChild
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        data-testid={`btn-failed-einvoice-fix-${entry.salesOrderId}`}
                      >
                        <Link href={fix.href}>{fix.cta}</Link>
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-8">
            {summary.recentActivity.map((activity) => (
              <div key={activity.id} className="flex items-start gap-4" data-testid={`row-activity-${activity.id}`}>
                <div className="mt-0.5 rounded-full bg-muted p-2">
                  {activity.kind === "sales_order" ? (
                    <ShoppingCart className="h-4 w-4 text-foreground" />
                  ) : activity.kind === "purchase_order" ? (
                    <ShoppingBag className="h-4 w-4 text-foreground" />
                  ) : (
                    <Package className="h-4 w-4 text-foreground" />
                  )}
                </div>
                <div className="flex-1 space-y-1">
                  <p className="text-sm font-medium leading-none">{activity.title}</p>
                  {activity.subtitle && (
                    <p className="text-sm text-muted-foreground">{activity.subtitle}</p>
                  )}
                </div>
                <div className="text-right">
                  {activity.amount !== null && (
                    <p className="text-sm font-medium">{formatCurrency(activity.amount)}</p>
                  )}
                  <p className="text-xs text-muted-foreground">{format(parseISO(activity.timestamp), "MMM d, h:mm a")}</p>
                </div>
              </div>
            ))}
            {summary.recentActivity.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">No recent activity.</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
