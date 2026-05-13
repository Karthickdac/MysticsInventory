import { Switch, Route, Router as WouterRouter, useLocation, Redirect } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryClient } from "@/lib/queryClient";
import { lazy, Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { RouteFallback } from "@/components/RouteFallback";
import { ThemeProvider } from "@/lib/theme";
import { AuthProvider, useAuth } from "@/lib/auth";
import { initActiveOrgFromStorage } from "@/lib/orgContext";
import { canAccessPath, normalizeRole } from "@/lib/permissions";
import { useGetMe } from "@/lib/queryKeys";

initActiveOrgFromStorage();

const Landing = lazy(() => import("@/pages/Landing"));
const SignInPage = lazy(() => import("@/pages/SignInPage"));
const SignUpPage = lazy(() => import("@/pages/SignUpPage"));
const ForgotPasswordPage = lazy(() => import("@/pages/ForgotPasswordPage"));
const ResetPasswordPage = lazy(() => import("@/pages/ResetPasswordPage"));
const VerifyEmailPage = lazy(() => import("@/pages/VerifyEmailPage"));
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Items = lazy(() => import("@/pages/Items"));
const ItemDetail = lazy(() => import("@/pages/ItemDetail"));
const Customers = lazy(() => import("@/pages/Customers"));
const CustomerDetail = lazy(() => import("@/pages/CustomerDetail"));
const Suppliers = lazy(() => import("@/pages/Suppliers"));
const SupplierDetail = lazy(() => import("@/pages/SupplierDetail"));
const SupplierPayments = lazy(() => import("@/pages/SupplierPayments"));
const SupplierPaymentDetail = lazy(() => import("@/pages/SupplierPaymentDetail"));
const Warehouses = lazy(() => import("@/pages/Warehouses"));
const StockMovements = lazy(() => import("@/pages/StockMovements"));
const StockTransfers = lazy(() => import("@/pages/StockTransfers"));
const StockTransferNew = lazy(() => import("@/pages/StockTransferNew"));
const StockTransferDetail = lazy(() => import("@/pages/StockTransferDetail"));
const JobWorkOrders = lazy(() => import("@/pages/JobWorkOrders"));
const JobWorkOrderNew = lazy(() => import("@/pages/JobWorkOrderNew"));
const JobWorkOrderDetail = lazy(() => import("@/pages/JobWorkOrderDetail"));
const POS = lazy(() => import("@/pages/POS"));
const SalesOrders = lazy(() => import("@/pages/SalesOrders"));
const SalesOrderNew = lazy(() => import("@/pages/SalesOrderNew"));
const SalesOrderEdit = lazy(() => import("@/pages/SalesOrderEdit"));
const SalesOrderDetail = lazy(() => import("@/pages/SalesOrderDetail"));
const Payments = lazy(() => import("@/pages/Payments"));
const PaymentDetail = lazy(() => import("@/pages/PaymentDetail"));
const PurchaseOrders = lazy(() => import("@/pages/PurchaseOrders"));
const PurchaseOrderNew = lazy(() => import("@/pages/PurchaseOrderNew"));
const PurchaseOrderDetail = lazy(() => import("@/pages/PurchaseOrderDetail"));
const Reports = lazy(() => import("@/pages/Reports"));
const ReportInventoryValuation = lazy(() => import("@/pages/ReportInventoryValuation"));
const ReportLowStock = lazy(() => import("@/pages/ReportLowStock"));
const ReportSalesSummary = lazy(() => import("@/pages/ReportSalesSummary"));
const ReportPurchaseSummary = lazy(() => import("@/pages/ReportPurchaseSummary"));
const ReportReceivablesAging = lazy(() => import("@/pages/ReportReceivablesAging"));
const ReportPayablesAging = lazy(() => import("@/pages/ReportPayablesAging"));
const ReportWarehouseValuation = lazy(
  () => import("@/pages/ReportWarehouseValuation"),
);
const ReportStockWithJobWorkers = lazy(
  () => import("@/pages/ReportStockWithJobWorkers"),
);
const ReportPendingJobWork = lazy(
  () => import("@/pages/ReportPendingJobWork"),
);
const GstReturns = lazy(() => import("@/pages/GstReturns"));
const TallyExport = lazy(() => import("@/pages/TallyExport"));
const Integrations = lazy(() => import("@/pages/Integrations"));
const IntegrationShopify = lazy(() => import("@/pages/IntegrationShopify"));
const IntegrationShiprocket = lazy(
  () => import("@/pages/IntegrationShiprocket"),
);
const IntegrationEwb = lazy(() => import("@/pages/IntegrationEwb"));
const IntegrationEinvoice = lazy(() => import("@/pages/IntegrationEinvoice"));
const AdminOrganizations = lazy(() => import("@/pages/AdminOrganizations"));
const Settings = lazy(() => import("@/pages/Settings"));
const EmailSettingsPage = lazy(() => import("@/pages/EmailSettings"));
const Onboarding = lazy(() => import("@/pages/Onboarding"));
const Team = lazy(() => import("@/pages/Team"));
const AcceptInvitation = lazy(() => import("@/pages/AcceptInvitation"));
const NotFound = lazy(() => import("@/pages/not-found"));

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function HomeRedirect() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <RouteFallback />;
  if (user) return <Redirect to="/dashboard" />;
  return (
    <Suspense fallback={<RouteFallback />}>
      <Landing />
    </Suspense>
  );
}

function RoleGate({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: me } = useGetMe();
  // While we don't yet know the role, render children — most users
  // are owners/admins and waiting on /me would flash a fallback.
  // The server will 403 anything we get wrong.
  if (!me) return <>{children}</>;
  if (me.user.isSuperAdmin) return <>{children}</>;
  const role = normalizeRole(me.role);
  if (canAccessPath(role, location)) return <>{children}</>;
  return <Redirect to="/dashboard" />;
}

function ProtectedRoutes() {
  return (
    <AppShell>
      <Suspense fallback={<RouteFallback />}>
       <RoleGate>
        <Switch>
          <Route path="/dashboard" component={Dashboard} />
          <Route path="/items" component={Items} />
          <Route path="/items/:id" component={ItemDetail} />
          <Route path="/customers" component={Customers} />
          <Route path="/customers/:id" component={CustomerDetail} />
          <Route path="/suppliers" component={Suppliers} />
          <Route path="/suppliers/:id" component={SupplierDetail} />
          <Route path="/warehouses" component={Warehouses} />
          <Route path="/stock" component={StockMovements} />
          <Route path="/transfers" component={StockTransfers} />
          <Route path="/transfers/new" component={StockTransferNew} />
          <Route path="/transfers/:id" component={StockTransferDetail} />
          <Route path="/job-work" component={JobWorkOrders} />
          <Route path="/job-work/new" component={JobWorkOrderNew} />
          <Route path="/job-work/:id" component={JobWorkOrderDetail} />
          <Route path="/pos" component={POS} />
          <Route path="/sales-orders" component={SalesOrders} />
          <Route path="/sales-orders/new" component={SalesOrderNew} />
          <Route path="/sales-orders/:id/edit" component={SalesOrderEdit} />
          <Route path="/sales-orders/:id" component={SalesOrderDetail} />
          <Route path="/payments" component={Payments} />
          <Route path="/payments/:id" component={PaymentDetail} />
          <Route path="/purchase-orders" component={PurchaseOrders} />
          <Route path="/purchase-orders/new" component={PurchaseOrderNew} />
          <Route path="/purchase-orders/:id" component={PurchaseOrderDetail} />
          <Route path="/supplier-payments" component={SupplierPayments} />
          <Route path="/supplier-payments/:id" component={SupplierPaymentDetail} />
          <Route path="/reports" component={Reports} />
          <Route path="/reports/inventory-valuation" component={ReportInventoryValuation} />
          <Route path="/reports/low-stock" component={ReportLowStock} />
          <Route path="/reports/sales-summary" component={ReportSalesSummary} />
          <Route path="/reports/purchase-summary" component={ReportPurchaseSummary} />
          <Route path="/reports/receivables-aging" component={ReportReceivablesAging} />
          <Route path="/reports/payables-aging" component={ReportPayablesAging} />
          <Route path="/reports/warehouse-valuation" component={ReportWarehouseValuation} />
          <Route path="/reports/batches-near-expiry">
            <Redirect to="/reports" />
          </Route>
          <Route path="/reports/stock-with-job-workers" component={ReportStockWithJobWorkers} />
          <Route path="/reports/pending-job-work" component={ReportPendingJobWork} />
          <Route path="/reports/gst-returns" component={GstReturns} />
          <Route path="/reports/tally-export" component={TallyExport} />
          <Route path="/integrations" component={Integrations} />
          <Route path="/integrations/shopify" component={IntegrationShopify} />
          <Route
            path="/integrations/shiprocket"
            component={IntegrationShiprocket}
          />
          <Route path="/integrations/ewb" component={IntegrationEwb} />
          <Route
            path="/integrations/einvoice"
            component={IntegrationEinvoice}
          />
          <Route path="/team" component={Team} />
          <Route path="/admin" component={AdminOrganizations} />
          <Route path="/onboarding" component={Onboarding} />
          <Route path="/accept-invitation" component={AcceptInvitation} />
          <Route path="/settings" component={Settings} />
          <Route path="/settings/email" component={EmailSettingsPage} />
          <Route component={NotFound} />
        </Switch>
       </RoleGate>
      </Suspense>
    </AppShell>
  );
}

function AppRoutes() {
  return (
    <Switch>
      <Route path="/" component={HomeRedirect} />
      <Route path="/sign-in">
        <Suspense fallback={<RouteFallback />}>
          <SignInPage />
        </Suspense>
      </Route>
      <Route path="/sign-up">
        <Suspense fallback={<RouteFallback />}>
          <SignUpPage />
        </Suspense>
      </Route>
      <Route path="/forgot-password">
        <Suspense fallback={<RouteFallback />}>
          <ForgotPasswordPage />
        </Suspense>
      </Route>
      <Route path="/reset-password">
        <Suspense fallback={<RouteFallback />}>
          <ResetPasswordPage />
        </Suspense>
      </Route>
      <Route path="/verify-email">
        <Suspense fallback={<RouteFallback />}>
          <VerifyEmailPage />
        </Suspense>
      </Route>
      <Route path="/*?">
        <ProtectedRoutes />
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <WouterRouter base={basePath}>
              <AppRoutes />
            </WouterRouter>
          </AuthProvider>
        </QueryClientProvider>
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  );
}

export default App;
