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
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Link } from "wouter";
import { useEffect } from "react";
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
} from "lucide-react";
import { SiShopify } from "react-icons/si";
import { format } from "date-fns";
import {
  useGetShopifyConnection,
  useDeleteShopifyConnection,
  useStartShopifyInstall,
  useSyncShopify,
  useSyncShopifyOrders,
  useConnectShopifyCustom,
  getGetShopifyConnectionQueryKey,
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
        </div>
      )}
    </div>
  );
}
