import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardFooter,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Link } from "wouter";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  ExternalLink,
  Loader2,
  RefreshCw,
  Unlink,
  KeyRound,
  Store,
  CheckCircle2,
  CalendarRange,
  ScanSearch,
  AlertTriangle,
  DownloadCloud,
} from "lucide-react";
import { SiShopify } from "react-icons/si";
import { format } from "date-fns";
import {
  useGetShopifyConnection,
  useDeleteShopifyConnection,
  useStartShopifyInstall,
  useSyncShopify,
  useSyncShopifyOrders,
  usePushShopifyProducts,
  useConnectShopifyCustom,
  useStartShopifyHistoricalImport,
  useGetShopifyImportJob,
  useReconcileShopifyOrders,
  getGetShopifyImportJobQueryKey,
  getReconcileShopifyOrdersQueryKey,
  getGetShopifyConnectionQueryKey,
  type ShopifyImportJob,
  type ShopifyReconcileResult,
} from "@/lib/queryKeys";

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]\.myshopify\.com$/i;

const installSchema = z.object({
  shopDomain: z
    .string()
    .min(1, "Store domain is required")
    .transform((v) =>
      v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
    )
    .refine((v) => SHOP_DOMAIN_RE.test(v), {
      message: "Must look like your-store.myshopify.com",
    }),
});

const customSchema = z.object({
  shopDomain: z
    .string()
    .min(1, "Store domain is required")
    .transform((v) =>
      v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
    )
    .refine((v) => SHOP_DOMAIN_RE.test(v), {
      message: "Must look like your-store.myshopify.com",
    }),
  accessToken: z
    .string()
    .min(1, "Access token is required")
    .refine((v) => v.trim().startsWith("shpat_") || v.trim().length >= 20, {
      message: "Paste the Admin API access token from your Shopify custom app",
    }),
});

type InstallValues = z.infer<typeof installSchema>;
type CustomValues = z.infer<typeof customSchema>;

function formatTime(value: string | null | undefined) {
  if (!value) return "Never";
  return format(new Date(value), "MMM d, h:mm a");
}

const STEPS = [
  "In your Shopify admin, go to Settings → Apps and sales channels",
  'Click "Develop apps" → "Create an app" → give it any name',
  'Go to "API credentials" tab → click "Configure Admin API scopes"',
  "Enable: read_products, write_products, read_inventory, write_inventory, read_orders, read_customers, read_locations",
  'Save, then click "Install app" → confirm',
  'Copy the "Admin API access token" (shown once) and paste it below',
];

export default function IntegrationShopify() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const {
    data: connection,
    isLoading,
    isError,
    error,
    refetch,
  } = useGetShopifyConnection();

  const invalidateConnection = () =>
    queryClient.invalidateQueries({
      queryKey: getGetShopifyConnectionQueryKey(),
    });

  const installMutation = useStartShopifyInstall({
    mutation: {
      onSuccess: (data) => {
        window.open(data.installUrl, "_blank", "noopener,noreferrer");
      },
      onError: (err: unknown) => {
        toast({
          title: "Could not start Shopify install",
          description: err instanceof Error ? err.message : "Try again",
          variant: "destructive",
        });
      },
    },
  });

  const customMutation = useConnectShopifyCustom({
    mutation: {
      onSuccess: () => {
        invalidateConnection();
        toast({ title: "Shopify connected via Custom App" });
      },
      onError: (err: unknown) => {
        toast({
          title: "Connection failed",
          description: err instanceof Error ? err.message : "Check your domain and token",
          variant: "destructive",
        });
      },
    },
  });

  const disconnectMutation = useDeleteShopifyConnection({
    mutation: {
      onSuccess: () => {
        invalidateConnection();
        toast({ title: "Shopify disconnected" });
      },
    },
  });

  const syncProductsMutation = useSyncShopify({
    mutation: {
      onSuccess: (data) => {
        invalidateConnection();
        toast({
          title: "Product sync complete",
          description: `Imported ${data.productsImported}, updated ${data.productsUpdated}.`,
        });
      },
    },
  });

  const syncOrdersMutation = useSyncShopifyOrders({
    mutation: {
      onSuccess: (data) => {
        invalidateConnection();
        toast({
          title: "Order sync complete",
          description: `Imported ${data.ordersImported}, skipped ${data.ordersSkipped}.`,
        });
      },
    },
  });

  const pushProductsMutation = usePushShopifyProducts({
    mutation: {
      onSuccess: (data) => {
        toast({
          title: "Products pushed to Shopify",
          description: `Queued ${data.itemCount} linked product${data.itemCount === 1 ? "" : "s"} for push.`,
        });
      },
      onError: (err: unknown) => {
        toast({
          title: "Push failed",
          description: err instanceof Error ? err.message : "Try again",
          variant: "destructive",
        });
      },
    },
  });

  const installForm = useForm<InstallValues>({
    resolver: zodResolver(installSchema),
    defaultValues: { shopDomain: "" },
  });

  const customForm = useForm<CustomValues>({
    resolver: zodResolver(customSchema),
    defaultValues: { shopDomain: "", accessToken: "" },
  });

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("connected") === "1") {
      toast({ title: "Shopify connected" });
      url.searchParams.delete("connected");
      window.history.replaceState({}, "", url.toString());
      invalidateConnection();
    }
  }, []);

  const header = (
    <div className="flex items-center gap-4">
      <Button variant="ghost" size="icon" asChild>
        <Link href="/integrations">
          <ArrowLeft className="h-5 w-5" />
        </Link>
      </Button>
      <PageHeader title="Shopify Integration" className="mb-0" />
    </div>
  );

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-2xl" data-testid="shopify-loading">
        {header}
        <Card>
          <CardContent className="flex items-center gap-3 py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading Shopify connection…
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-6 max-w-2xl" data-testid="shopify-error">
        {header}
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive">
              Couldn't load Shopify status
            </CardTitle>
            <CardDescription>
              {error instanceof Error ? error.message : "Unknown error."}
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button onClick={() => refetch()} variant="outline">
              <RefreshCw className="mr-2 h-4 w-4" /> Retry
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {header}

      {!connection?.connected ? (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <SiShopify className="h-8 w-8 text-[#95bf47]" />
              <div>
                <CardTitle>Connect your Shopify store</CardTitle>
                <CardDescription>
                  Choose how you want to connect — Custom App is the quickest
                  for private stores; Partner App is for published integrations.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="custom">
              <TabsList className="mb-6 w-full">
                <TabsTrigger value="custom" className="flex-1 gap-2">
                  <KeyRound className="h-4 w-4" />
                  Custom App
                  <Badge variant="secondary" className="text-xs">Recommended</Badge>
                </TabsTrigger>
                <TabsTrigger value="oauth" className="flex-1 gap-2">
                  <Store className="h-4 w-4" />
                  Partner App (OAuth)
                </TabsTrigger>
              </TabsList>

              {/* ── Custom App Tab ── */}
              <TabsContent value="custom" className="space-y-5">
                <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
                  <p className="text-sm font-medium">
                    How to create your Shopify Custom App:
                  </p>
                  <ol className="space-y-2">
                    {STEPS.map((step, i) => (
                      <li key={i} className="flex gap-3 text-sm">
                        <span className="flex-shrink-0 flex h-5 w-5 items-center justify-center rounded-full bg-[#95bf47] text-white text-xs font-bold">
                          {i + 1}
                        </span>
                        <span className="text-muted-foreground">{step}</span>
                      </li>
                    ))}
                  </ol>
                </div>

                <Form {...customForm}>
                  <form
                    onSubmit={customForm.handleSubmit((v) =>
                      customMutation.mutate({
                        data: { shopDomain: v.shopDomain, accessToken: v.accessToken },
                      }),
                    )}
                    className="space-y-4"
                  >
                    <FormField
                      control={customForm.control}
                      name="shopDomain"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Shop domain</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="your-store.myshopify.com"
                              autoComplete="off"
                              {...field}
                              data-testid="input-shopify-custom-domain"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={customForm.control}
                      name="accessToken"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Admin API access token</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="shpat_xxxxxxxxxxxxxxxxxxxx"
                              autoComplete="off"
                              {...field}
                              data-testid="input-shopify-access-token"
                            />
                          </FormControl>
                          <FormDescription>
                            Paste the token from your custom app's "API credentials" tab.
                            It starts with <code className="text-xs">shpat_</code>.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <Button
                      type="submit"
                      disabled={customMutation.isPending}
                      data-testid="btn-connect-shopify-custom"
                    >
                      {customMutation.isPending ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Connecting…
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="mr-2 h-4 w-4" />
                          Connect store
                        </>
                      )}
                    </Button>
                  </form>
                </Form>
              </TabsContent>

              {/* ── OAuth / Partner App Tab ── */}
              <TabsContent value="oauth" className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Use this if your app is registered as a Shopify Partner app and
                  you want to connect via the standard OAuth approval flow.
                  The store must have your app installed or listed as a test store
                  in the Partner dashboard.
                </p>
                <Form {...installForm}>
                  <form
                    onSubmit={installForm.handleSubmit((v) =>
                      installMutation.mutate({ data: { shopDomain: v.shopDomain } }),
                    )}
                    className="space-y-4"
                  >
                    <FormField
                      control={installForm.control}
                      name="shopDomain"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Shop domain</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="your-store.myshopify.com"
                              autoComplete="off"
                              {...field}
                              data-testid="input-shopify-domain"
                            />
                          </FormControl>
                          <FormDescription>
                            You'll be sent to Shopify to approve access.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <Button
                      type="submit"
                      disabled={installMutation.isPending}
                      data-testid="btn-install-shopify"
                    >
                      <ExternalLink className="mr-2 h-4 w-4" />
                      {installMutation.isPending
                        ? "Redirecting…"
                        : "Install on Shopify"}
                    </Button>
                  </form>
                </Form>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          <Card className="border-green-200 dark:border-green-900/30">
            <CardHeader className="bg-green-50/50 dark:bg-green-900/10 rounded-t-xl border-b border-green-100 dark:border-green-900/20">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-3 w-3 bg-[#95bf47] rounded-full animate-pulse" />
                  <CardTitle className="text-lg">
                    Connected to Shopify
                  </CardTitle>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => disconnectMutation.mutate()}
                  disabled={disconnectMutation.isPending}
                  data-testid="btn-disconnect-shopify"
                >
                  <Unlink className="h-4 w-4 mr-2" /> Disconnect
                </Button>
              </div>
            </CardHeader>
            <CardContent className="pt-6 space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="font-medium text-muted-foreground">
                    Store domain
                  </p>
                  <p className="font-medium">{connection.shopDomain}</p>
                </div>
                <div>
                  <p className="font-medium text-muted-foreground">
                    Last synced
                  </p>
                  <p>{formatTime(connection.lastSyncedAt)}</p>
                </div>
                <div>
                  <p className="font-medium text-muted-foreground">
                    Products tracked
                  </p>
                  <p>{connection.productCount ?? 0}</p>
                </div>
                <div>
                  <p className="font-medium text-muted-foreground">
                    Last webhook
                  </p>
                  <p>{formatTime(connection.lastWebhookAt)}</p>
                </div>
                <div>
                  <p className="font-medium text-muted-foreground">
                    Webhooks registered
                  </p>
                  <p>{formatTime(connection.webhooksRegisteredAt)}</p>
                </div>
                <div>
                  <p className="font-medium text-muted-foreground">
                    Warehouses mapped
                  </p>
                  <p data-testid="text-shopify-mapped-warehouses">
                    <span className="font-medium">
                      {connection.mappedWarehouseCount ?? 0}
                    </span>{" "}
                    of {connection.totalWarehouseCount ?? 0}
                    {connection.totalWarehouseCount &&
                    (connection.mappedWarehouseCount ?? 0) <
                      connection.totalWarehouseCount ? (
                      <>
                        {" — "}
                        <Link
                          href="/warehouses"
                          className="text-primary underline-offset-4 hover:underline"
                          data-testid="link-shopify-map-warehouses"
                        >
                          map now
                        </Link>
                      </>
                    ) : null}
                  </p>
                </div>
                {connection.scopes && (
                  <div className="col-span-2">
                    <p className="font-medium text-muted-foreground">
                      Granted scopes
                    </p>
                    <p className="font-mono text-xs break-all">
                      {connection.scopes}
                    </p>
                  </div>
                )}
              </div>
            </CardContent>
            <CardFooter className="bg-muted/30 border-t py-4 gap-2 flex-wrap">
              <Button
                onClick={() => syncProductsMutation.mutate()}
                disabled={syncProductsMutation.isPending}
                data-testid="btn-sync-shopify-products"
              >
                <RefreshCw
                  className={`mr-2 h-4 w-4 ${
                    syncProductsMutation.isPending ? "animate-spin" : ""
                  }`}
                />
                {syncProductsMutation.isPending
                  ? "Syncing products…"
                  : "Sync products now"}
              </Button>
              <Button
                variant="outline"
                onClick={() => pushProductsMutation.mutate()}
                disabled={pushProductsMutation.isPending}
                data-testid="btn-push-shopify-products"
                title="Push all linked inventory products back to Shopify (name, SKU, barcode, price, status, category)"
              >
                <RefreshCw
                  className={`mr-2 h-4 w-4 ${
                    pushProductsMutation.isPending ? "animate-spin" : ""
                  }`}
                />
                {pushProductsMutation.isPending
                  ? "Pushing products…"
                  : "Sync All Products to Shopify"}
              </Button>
              <Button
                variant="outline"
                onClick={() => syncOrdersMutation.mutate()}
                disabled={syncOrdersMutation.isPending}
                data-testid="btn-sync-shopify-orders"
              >
                <RefreshCw
                  className={`mr-2 h-4 w-4 ${
                    syncOrdersMutation.isPending ? "animate-spin" : ""
                  }`}
                />
                {syncOrdersMutation.isPending
                  ? "Syncing orders…"
                  : "Sync orders now"}
              </Button>
            </CardFooter>
          </Card>

          <HistoricalImportCard />
          <ReconciliationCard />
        </div>
      )}
    </div>
  );
}

function todayStr() {
  return format(new Date(), "yyyy-MM-dd");
}

function HistoricalImportCard() {
  const { toast } = useToast();
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState(todayStr());
  const [jobId, setJobId] = useState<string | null>(null);

  const startImport = useStartShopifyHistoricalImport({
    mutation: {
      onSuccess: (data) => {
        setJobId(data.jobId);
      },
      onError: (err: unknown) => {
        toast({
          title: "Could not start import",
          description: err instanceof Error ? err.message : "Try again",
          variant: "destructive",
        });
      },
    },
  });

  const { data: job } = useGetShopifyImportJob(jobId ?? "", {
    query: {
      enabled: !!jobId,
      queryKey: getGetShopifyImportJobQueryKey(jobId ?? ""),
      refetchInterval: (query) => {
        const status = (query.state.data as ShopifyImportJob | undefined)
          ?.status;
        return status === "running" ? 1500 : false;
      },
    },
  });

  useEffect(() => {
    if (!job) return;
    if (job.status === "completed") {
      toast({
        title: "Historical import complete",
        description: `Imported ${job.imported}, skipped ${job.skipped}.`,
      });
    } else if (job.status === "completed_with_errors") {
      toast({
        title: "Import finished with errors",
        description: `Imported ${job.imported}, skipped ${job.skipped}, failed ${job.failed}.`,
        variant: "destructive",
      });
    } else if (job.status === "failed") {
      toast({
        title: "Historical import failed",
        description: job.error ?? "Unknown error",
        variant: "destructive",
      });
    }
  }, [job?.status]);

  const retryFailed = () => {
    if (!job || job.failedOrders.length === 0) return;
    startImport.mutate({
      data: { orderIds: job.failedOrders.map((f) => f.id) },
    });
  };

  const running = job?.status === "running" || startImport.isPending;
  const pct =
    job && job.total && job.total > 0
      ? Math.min(100, Math.round((job.processed / job.total) * 100))
      : job && job.status !== "running"
        ? 100
        : 0;

  const canStart = !!fromDate && !!toDate && fromDate <= toDate && !running;

  return (
    <Card data-testid="card-shopify-historical-import">
      <CardHeader>
        <div className="flex items-center gap-3">
          <CalendarRange className="h-5 w-5 text-[#95bf47]" />
          <div>
            <CardTitle className="text-lg">Import historical orders</CardTitle>
            <CardDescription>
              Backfill past orders from Shopify by date range. Already-imported
              orders are skipped automatically.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="import-from">From date</Label>
            <Input
              id="import-from"
              type="date"
              value={fromDate}
              max={toDate || todayStr()}
              onChange={(e) => setFromDate(e.target.value)}
              disabled={running}
              data-testid="input-import-from"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="import-to">To date</Label>
            <Input
              id="import-to"
              type="date"
              value={toDate}
              min={fromDate || undefined}
              max={todayStr()}
              onChange={(e) => setToDate(e.target.value)}
              disabled={running}
              data-testid="input-import-to"
            />
          </div>
        </div>

        {job && (
          <div className="space-y-2" data-testid="import-progress">
            <Progress value={pct} />
            <p className="text-sm text-muted-foreground">
              {job.status === "running"
                ? `Processing ${job.processed}${
                    job.total ? ` of ${job.total}` : ""
                  }…`
                : job.status === "completed"
                  ? `Done — imported ${job.imported}, skipped ${job.skipped}.`
                  : job.status === "completed_with_errors"
                    ? `Finished with errors — imported ${job.imported}, skipped ${job.skipped}, failed ${job.failed}.`
                    : `Failed: ${job.error ?? "Unknown error"}`}
            </p>
          </div>
        )}

        {job &&
          (job.status === "completed_with_errors" ||
            (job.status !== "running" && job.failedOrders.length > 0)) && (
            <div
              className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900/40 dark:bg-amber-900/10"
              data-testid="import-failed-orders"
            >
              <div className="flex items-start gap-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
                <div className="space-y-1">
                  <p className="font-medium">
                    {job.failed} order{job.failed === 1 ? "" : "s"} failed to
                    import.
                  </p>
                  <p className="text-muted-foreground">
                    These orders were not imported. You can retry just the
                    failed orders below.
                  </p>
                </div>
              </div>
              {job.failedOrders.length > 0 && (
                <ul className="space-y-1.5">
                  {job.failedOrders.map((f) => (
                    <li
                      key={f.id}
                      className="flex flex-wrap items-center gap-2 text-sm"
                      data-testid={`failed-order-${f.id}`}
                    >
                      <Badge
                        variant="outline"
                        className="font-mono text-xs"
                      >
                        {f.id}
                      </Badge>
                      <span
                        className="text-muted-foreground"
                        data-testid={`failed-order-reason-${f.id}`}
                      >
                        {f.reason}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={retryFailed}
                disabled={running || job.failedOrders.length === 0}
                data-testid="btn-retry-failed-orders"
              >
                {running ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Retrying…
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Retry failed orders
                  </>
                )}
              </Button>
            </div>
          )}
      </CardContent>
      <CardFooter className="bg-muted/30 border-t py-4">
        <Button
          onClick={() =>
            startImport.mutate({ data: { fromDate, toDate } })
          }
          disabled={!canStart}
          data-testid="btn-start-historical-import"
        >
          {running ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Importing…
            </>
          ) : (
            <>
              <DownloadCloud className="mr-2 h-4 w-4" />
              Import orders
            </>
          )}
        </Button>
      </CardFooter>
    </Card>
  );
}

function ReconciliationCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(todayStr());
  const [params, setParams] = useState<{ from: string; to: string } | null>(
    null,
  );
  const [importJobId, setImportJobId] = useState<string | null>(null);

  const {
    data: result,
    isFetching,
    isError,
    error,
  } = useReconcileShopifyOrders(params ?? { from: "", to: "" }, {
    query: {
      enabled: !!params,
      queryKey: getReconcileShopifyOrdersQueryKey(
        params ?? { from: "", to: "" },
      ),
    },
  });

  const importMissing = useStartShopifyHistoricalImport({
    mutation: {
      onSuccess: (data) => {
        setImportJobId(data.jobId);
        toast({
          title: "Importing missing orders",
          description: "This runs in the background.",
        });
      },
      onError: (err: unknown) => {
        toast({
          title: "Could not import missing orders",
          description: err instanceof Error ? err.message : "Try again",
          variant: "destructive",
        });
      },
    },
  });

  const { data: importJob } = useGetShopifyImportJob(importJobId ?? "", {
    query: {
      enabled: !!importJobId,
      queryKey: getGetShopifyImportJobQueryKey(importJobId ?? ""),
      refetchInterval: (query) => {
        const status = (query.state.data as ShopifyImportJob | undefined)
          ?.status;
        return status === "running" ? 1500 : false;
      },
    },
  });

  useEffect(() => {
    if (!importJob || importJob.status !== "completed" || !params) return;
    toast({
      title: "Missing orders imported",
      description: `Imported ${importJob.imported}, skipped ${importJob.skipped}.`,
    });
    queryClient.invalidateQueries({
      queryKey: getReconcileShopifyOrdersQueryKey(params),
    });
    setImportJobId(null);
  }, [importJob?.status]);

  const r = result as ShopifyReconcileResult | undefined;
  const canCompare = !!from && !!to && from <= to && !isFetching;
  const importing = importJob?.status === "running" || importMissing.isPending;

  return (
    <Card data-testid="card-shopify-reconcile">
      <CardHeader>
        <div className="flex items-center gap-3">
          <ScanSearch className="h-5 w-5 text-[#95bf47]" />
          <div>
            <CardTitle className="text-lg">Reconcile orders</CardTitle>
            <CardDescription>
              Compare Shopify against your inventory for a date range to spot
              missing or duplicated orders.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="recon-from">From date</Label>
            <Input
              id="recon-from"
              type="date"
              value={from}
              max={to || todayStr()}
              onChange={(e) => setFrom(e.target.value)}
              data-testid="input-recon-from"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="recon-to">To date</Label>
            <Input
              id="recon-to"
              type="date"
              value={to}
              min={from || undefined}
              max={todayStr()}
              onChange={(e) => setTo(e.target.value)}
              data-testid="input-recon-to"
            />
          </div>
        </div>

        <Button
          variant="outline"
          onClick={() => setParams({ from, to })}
          disabled={!canCompare}
          data-testid="btn-run-reconcile"
        >
          {isFetching ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Comparing…
            </>
          ) : (
            <>
              <ScanSearch className="mr-2 h-4 w-4" />
              Compare
            </>
          )}
        </Button>

        {isError && (
          <p className="text-sm text-destructive" data-testid="recon-error">
            {error instanceof Error ? error.message : "Could not reconcile."}
          </p>
        )}

        {r && (
          <div className="space-y-4" data-testid="recon-results">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Metric</TableHead>
                  <TableHead className="text-right">Shopify</TableHead>
                  <TableHead className="text-right">Inventory</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>Order count</TableCell>
                  <TableCell className="text-right" data-testid="recon-shopify-count">
                    {r.shopifyCount}
                  </TableCell>
                  <TableCell className="text-right" data-testid="recon-inventory-count">
                    {r.inventoryCount}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Order total</TableCell>
                  <TableCell className="text-right">
                    ₹{r.shopifyTotal}
                  </TableCell>
                  <TableCell className="text-right">
                    ₹{r.inventoryTotal}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>

            {r.duplicates.length > 0 && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/10 p-3 text-sm">
                <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600 flex-shrink-0" />
                <span data-testid="recon-duplicates">
                  {r.duplicates.length} Shopify order
                  {r.duplicates.length === 1 ? "" : "s"} appear more than once in
                  inventory and may need cleanup.
                </span>
              </div>
            )}

            {r.missingInInventory.length > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <p className="text-sm" data-testid="recon-missing">
                  <span className="font-medium">
                    {r.missingInInventory.length}
                  </span>{" "}
                  order
                  {r.missingInInventory.length === 1 ? "" : "s"} in Shopify are
                  missing from inventory.
                </p>
                <Button
                  size="sm"
                  onClick={() =>
                    importMissing.mutate({
                      data: { orderIds: r.missingInInventory },
                    })
                  }
                  disabled={importing}
                  data-testid="btn-import-missing"
                >
                  {importing ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Importing…
                    </>
                  ) : (
                    <>
                      <DownloadCloud className="mr-2 h-4 w-4" />
                      Import missing
                    </>
                  )}
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50/50 dark:border-green-900/30 dark:bg-green-900/10 p-3 text-sm">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <span>Everything in Shopify is present in inventory.</span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
