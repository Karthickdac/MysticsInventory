import { Switch, Route, Router as WouterRouter, useLocation, Redirect } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryClient } from "@/lib/queryClient";
import { ClerkProvider, Show, useClerk } from "@clerk/react";
import { lazy, Suspense, useEffect, useRef } from "react";
import { clerkAppearance } from "@/lib/clerk-appearance";
import { AppShell } from "@/components/AppShell";
import { RouteFallback } from "@/components/RouteFallback";
import { ThemeProvider } from "@/lib/theme";

// Code-split every page so the initial bundle is small and TTI is fast.
// Pages load on demand and stay cached after the first visit.
const Landing = lazy(() => import("@/pages/Landing"));
const SignInPage = lazy(() => import("@/pages/SignInPage"));
const SignUpPage = lazy(() => import("@/pages/SignUpPage"));
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
const SalesOrders = lazy(() => import("@/pages/SalesOrders"));
const SalesOrderNew = lazy(() => import("@/pages/SalesOrderNew"));
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
const Integrations = lazy(() => import("@/pages/Integrations"));
const IntegrationShopify = lazy(() => import("@/pages/IntegrationShopify"));
const Billing = lazy(() => import("@/pages/Billing"));
const Settings = lazy(() => import("@/pages/Settings"));
const Onboarding = lazy(() => import("@/pages/Onboarding"));
const Team = lazy(() => import("@/pages/Team"));
const AcceptInvitation = lazy(() => import("@/pages/AcceptInvitation"));
const NotFound = lazy(() => import("@/pages/not-found"));

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        queryClient.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener]);

  return null;
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/dashboard" />
      </Show>
      <Show when="signed-out">
        <Suspense fallback={<RouteFallback />}>
          <Landing />
        </Suspense>
      </Show>
    </>
  );
}

function ProtectedRoutes() {
  return (
    <AppShell>
      <Suspense fallback={<RouteFallback />}>
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
          <Route path="/sales-orders" component={SalesOrders} />
          <Route path="/sales-orders/new" component={SalesOrderNew} />
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
          <Route path="/integrations" component={Integrations} />
          <Route path="/integrations/shopify" component={IntegrationShopify} />
          <Route path="/billing" component={Billing} />
          <Route path="/team" component={Team} />
          <Route path="/onboarding" component={Onboarding} />
          <Route path="/accept-invitation" component={AcceptInvitation} />
          <Route path="/settings" component={Settings} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </AppShell>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Welcome back",
            subtitle: "Sign in to your Mystics Inventory cockpit",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <Switch>
          <Route path="/" component={HomeRedirect} />
          <Route path="/sign-in/*?">
            <Suspense fallback={<RouteFallback />}>
              <SignInPage />
            </Suspense>
          </Route>
          <Route path="/sign-up/*?">
            <Suspense fallback={<RouteFallback />}>
              <SignUpPage />
            </Suspense>
          </Route>
          <Route path="/*?">
            <ProtectedRoutes />
          </Route>
        </Switch>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <WouterRouter base={basePath}>
          <ClerkProviderWithRoutes />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  );
}

export default App;
