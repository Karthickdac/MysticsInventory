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
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Link } from "wouter";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, ExternalLink, Loader2, RefreshCw, Unlink } from "lucide-react";
import { SiShopify } from "react-icons/si";
import { format } from "date-fns";
import {
  useGetShopifyConnection,
  useDeleteShopifyConnection,
  useStartShopifyInstall,
  useSyncShopify,
  useSyncShopifyOrders,
  getGetShopifyConnectionQueryKey,
} from "@/lib/queryKeys";

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]\.myshopify\.com$/i;

const installSchema = z.object({
  shopDomain: z
    .string()
    .min(1, "Store domain is required")
    .transform((v) => v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .refine((v) => SHOP_DOMAIN_RE.test(v), {
      message: "Must look like your-store.myshopify.com",
    }),
});

type InstallValues = z.infer<typeof installSchema>;

function formatTime(value: string | null | undefined) {
  if (!value) return "Never";
  return format(new Date(value), "MMM d, h:mm a");
}

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

  const installMutation = useStartShopifyInstall({
    mutation: {
      onSuccess: (data) => {
        window.location.href = data.installUrl;
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

  const disconnectMutation = useDeleteShopifyConnection({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getGetShopifyConnectionQueryKey(),
        });
        toast({ title: "Shopify disconnected" });
      },
    },
  });

  const syncProductsMutation = useSyncShopify({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({
          queryKey: getGetShopifyConnectionQueryKey(),
        });
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
        queryClient.invalidateQueries({
          queryKey: getGetShopifyConnectionQueryKey(),
        });
        toast({
          title: "Order sync complete",
          description: `Imported ${data.ordersImported}, skipped ${data.ordersSkipped}.`,
        });
      },
    },
  });

  const form = useForm<InstallValues>({
    resolver: zodResolver(installSchema),
    defaultValues: { shopDomain: "" },
  });

  // Surface a toast when the OAuth callback redirects back with ?connected=1
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("connected") === "1") {
      toast({ title: "Shopify connected" });
      url.searchParams.delete("connected");
      window.history.replaceState({}, "", url.toString());
      queryClient.invalidateQueries({
        queryKey: getGetShopifyConnectionQueryKey(),
      });
    }
  }, [queryClient, toast]);

  const onSubmit = (values: InstallValues) => {
    installMutation.mutate({ data: { shopDomain: values.shopDomain } });
  };

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
                <CardTitle>Connect your store</CardTitle>
                <CardDescription>
                  Install the Mystics Inventory app on your Shopify store.
                  We'll request access to products, inventory and orders, then
                  keep them in sync automatically.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="space-y-4"
              >
                <FormField
                  control={form.control}
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
                        The full *.myshopify.com domain. You'll be sent to
                        Shopify to approve access.
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
                    Location ID
                  </p>
                  <p className="font-mono text-xs">
                    {connection.locationId ?? "—"}
                  </p>
                </div>
                <div className="col-span-2">
                  <p className="font-medium text-muted-foreground">
                    Granted scopes
                  </p>
                  <p className="font-mono text-xs break-all">
                    {connection.scopes ?? "—"}
                  </p>
                </div>
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
