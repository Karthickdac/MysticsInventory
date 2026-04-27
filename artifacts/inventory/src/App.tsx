import { Switch, Route, Router as WouterRouter, useLocation, Redirect } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { queryClient } from "@/lib/queryClient";
import { ClerkProvider, Show, useClerk } from "@clerk/react";
import { useEffect, useRef } from "react";
import { clerkAppearance } from "@/lib/clerk-appearance";

// Pages
import Landing from "@/pages/Landing";
import SignInPage from "@/pages/SignInPage";
import SignUpPage from "@/pages/SignUpPage";
import Dashboard from "@/pages/Dashboard";
import Items from "@/pages/Items";
import ItemDetail from "@/pages/ItemDetail";
import Customers from "@/pages/Customers";
import Suppliers from "@/pages/Suppliers";
import Warehouses from "@/pages/Warehouses";
import StockMovements from "@/pages/StockMovements";
import SalesOrders from "@/pages/SalesOrders";
import SalesOrderNew from "@/pages/SalesOrderNew";
import SalesOrderDetail from "@/pages/SalesOrderDetail";
import PurchaseOrders from "@/pages/PurchaseOrders";
import PurchaseOrderNew from "@/pages/PurchaseOrderNew";
import PurchaseOrderDetail from "@/pages/PurchaseOrderDetail";
import Reports from "@/pages/Reports";
import ReportInventoryValuation from "@/pages/ReportInventoryValuation";
import ReportLowStock from "@/pages/ReportLowStock";
import ReportSalesSummary from "@/pages/ReportSalesSummary";
import ReportPurchaseSummary from "@/pages/ReportPurchaseSummary";
import Integrations from "@/pages/Integrations";
import IntegrationShopify from "@/pages/IntegrationShopify";
import Billing from "@/pages/Billing";
import Settings from "@/pages/Settings";
import Onboarding from "@/pages/Onboarding";
import Team from "@/pages/Team";
import AcceptInvitation from "@/pages/AcceptInvitation";
import { AppShell } from "@/components/AppShell";

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
        <Landing />
      </Show>
    </>
  );
}

function ProtectedRoutes() {
  return (
    <AppShell>
      <Switch>
        <Route path="/dashboard" component={Dashboard} />
        <Route path="/items" component={Items} />
        <Route path="/items/:id" component={ItemDetail} />
        <Route path="/customers" component={Customers} />
        <Route path="/suppliers" component={Suppliers} />
        <Route path="/warehouses" component={Warehouses} />
        <Route path="/stock" component={StockMovements} />
        <Route path="/sales-orders" component={SalesOrders} />
        <Route path="/sales-orders/new" component={SalesOrderNew} />
        <Route path="/sales-orders/:id" component={SalesOrderDetail} />
        <Route path="/purchase-orders" component={PurchaseOrders} />
        <Route path="/purchase-orders/new" component={PurchaseOrderNew} />
        <Route path="/purchase-orders/:id" component={PurchaseOrderDetail} />
        <Route path="/reports" component={Reports} />
        <Route path="/reports/inventory-valuation" component={ReportInventoryValuation} />
        <Route path="/reports/low-stock" component={ReportLowStock} />
        <Route path="/reports/sales-summary" component={ReportSalesSummary} />
        <Route path="/reports/purchase-summary" component={ReportPurchaseSummary} />
        <Route path="/integrations" component={Integrations} />
        <Route path="/integrations/shopify" component={IntegrationShopify} />
        <Route path="/billing" component={Billing} />
        <Route path="/team" component={Team} />
        <Route path="/onboarding" component={Onboarding} />
        <Route path="/accept-invitation" component={AcceptInvitation} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
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
          <Route path="/sign-in/*?" component={SignInPage} />
          <Route path="/sign-up/*?" component={SignUpPage} />
          <Route path="/:rest*">
            <ProtectedRoutes />
          </Route>
        </Switch>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <TooltipProvider>
      <WouterRouter base={basePath}>
        <ClerkProviderWithRoutes />
      </WouterRouter>
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
