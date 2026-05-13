import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "wouter";
import { FileText, AlertTriangle, TrendingUp, ShoppingBag, Clock, Warehouse, Receipt, BookText, Scissors, Hourglass } from "lucide-react";

export default function Reports() {
  const reports = [
    {
      title: "Inventory Valuation",
      description: "Current stock value broken down by item based on unit cost.",
      href: "/reports/inventory-valuation",
      icon: <FileText className="h-6 w-6" />,
      color: "text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30",
    },
    {
      title: "Warehouse-Wise Inventory Valuation",
      description: "Stock value for every item broken down by warehouse location.",
      href: "/reports/warehouse-valuation",
      icon: <Warehouse className="h-6 w-6" />,
      color: "text-sky-600 bg-sky-100 dark:text-sky-400 dark:bg-sky-900/30",
    },
    {
      title: "Low Stock",
      description: "Items that have fallen below their configured reorder level.",
      href: "/reports/low-stock",
      icon: <AlertTriangle className="h-6 w-6" />,
      color: "text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30",
    },
    {
      title: "Sales Summary",
      description: "Revenue performance and top customers.",
      href: "/reports/sales-summary",
      icon: <TrendingUp className="h-6 w-6" />,
      color: "text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30",
    },
    {
      title: "Purchase Summary",
      description: "Procurement expenses and top suppliers.",
      href: "/reports/purchase-summary",
      icon: <ShoppingBag className="h-6 w-6" />,
      color: "text-orange-600 bg-orange-100 dark:text-orange-400 dark:bg-orange-900/30",
    },
    {
      title: "Receivables Aging",
      description: "Outstanding customer balances bucketed by days overdue.",
      href: "/reports/receivables-aging",
      icon: <Clock className="h-6 w-6" />,
      color: "text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-900/30",
    },
    {
      title: "Payables Aging",
      description: "Outstanding supplier balances bucketed by days overdue.",
      href: "/reports/payables-aging",
      icon: <Clock className="h-6 w-6" />,
      color: "text-amber-600 bg-amber-100 dark:text-amber-400 dark:bg-amber-900/30",
    },
    {
      title: "Stock with Job Workers",
      description: "Materials currently held at outside job workers, by worker.",
      href: "/reports/stock-with-job-workers",
      icon: <Scissors className="h-6 w-6" />,
      color: "text-cyan-600 bg-cyan-100 dark:text-cyan-400 dark:bg-cyan-900/30",
    },
    {
      title: "Pending Job Work",
      description: "Open job work orders with how much is still to be received.",
      href: "/reports/pending-job-work",
      icon: <Hourglass className="h-6 w-6" />,
      color: "text-violet-600 bg-violet-100 dark:text-violet-400 dark:bg-violet-900/30",
    },
    {
      title: "GST Returns",
      description: "Preview GSTR-1, GSTR-3B and HSN summary, then download CSV or GSTN JSON.",
      href: "/reports/gst-returns",
      icon: <Receipt className="h-6 w-6" />,
      color: "text-indigo-600 bg-indigo-100 dark:text-indigo-400 dark:bg-indigo-900/30",
    },
    {
      title: "Tally Export",
      description: "Download a Tally-importable XML of vouchers (sales, purchases, payments).",
      href: "/reports/tally-export",
      icon: <BookText className="h-6 w-6" />,
      color: "text-teal-600 bg-teal-100 dark:text-teal-400 dark:bg-teal-900/30",
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader 
        title="Reports" 
        description="Business intelligence and analytics for your inventory."
      />

      <div className="grid gap-6 md:grid-cols-2">
        {reports.map((report) => (
          <Link key={report.href} href={report.href} data-testid={`link-report-${report.title.toLowerCase().replace(/\s+/g, '-')}`}>
            <Card className="hover:shadow-md transition-shadow cursor-pointer h-full border-border/50">
              <CardHeader className="flex flex-row items-center gap-4">
                <div className={`p-3 rounded-lg ${report.color}`}>
                  {report.icon}
                </div>
                <div>
                  <CardTitle className="text-xl">{report.title}</CardTitle>
                  <CardDescription className="mt-1">{report.description}</CardDescription>
                </div>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
