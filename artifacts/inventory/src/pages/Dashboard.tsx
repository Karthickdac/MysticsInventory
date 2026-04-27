import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useGetDashboardSummary } from "@/lib/queryKeys";
import { formatCurrency } from "@/lib/format";
import { StatCard } from "@/components/StatCard";
import { PageHeader } from "@/components/PageHeader";
import { Package, TrendingUp, AlertTriangle, ShoppingCart, ShoppingBag, CreditCard, Banknote, Clock } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { format, parseISO } from "date-fns";

export default function Dashboard() {
  const { data: summary, isLoading } = useGetDashboardSummary();

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
      <PageHeader title="Dashboard" description="Overview of your inventory and sales performance." />
      
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
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
        <StatCard
          title="Low Stock Alerts"
          value={summary.lowStockCount}
          icon={<AlertTriangle className="h-4 w-4 text-destructive" />}
          className={summary.lowStockCount > 0 ? "border-destructive/50" : ""}
        />
        <StatCard
          title="Open Sales Orders"
          value={summary.openSalesOrders}
          icon={<ShoppingCart className="h-4 w-4 text-muted-foreground" />}
        />
        <StatCard
          title="Open Purchase Orders"
          value={summary.openPurchaseOrders}
          icon={<ShoppingBag className="h-4 w-4 text-muted-foreground" />}
        />
        <StatCard
          title="Sales This Month"
          value={formatCurrency(summary.salesThisMonth)}
          icon={<TrendingUp className="h-4 w-4 text-muted-foreground" />}
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
