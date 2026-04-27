import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useLocation, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, RefreshCw, Unlink } from "lucide-react";
import { SiShopify } from "react-icons/si";
import { format } from "date-fns";
import { 
  useGetShopifyConnection, 
  useSetShopifyConnection, 
  useDeleteShopifyConnection, 
  useSyncShopify,
  getGetShopifyConnectionQueryKey 
} from "@/lib/queryKeys";

const connectSchema = z.object({
  shopDomain: z.string().min(1, "Store domain is required").url("Must be a valid URL, e.g., mystore.myshopify.com"),
  accessToken: z.string().min(1, "Access token is required"),
});

export default function IntegrationShopify() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: connection, isLoading } = useGetShopifyConnection();

  const connectMutation = useSetShopifyConnection({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetShopifyConnectionQueryKey() });
        toast({ title: "Shopify connected successfully" });
      }
    }
  });

  const disconnectMutation = useDeleteShopifyConnection({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetShopifyConnectionQueryKey() });
        toast({ title: "Shopify disconnected" });
      }
    }
  });

  const syncMutation = useSyncShopify({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getGetShopifyConnectionQueryKey() });
        toast({ 
          title: "Sync complete", 
          description: `Imported ${data.productsImported}, updated ${data.productsUpdated} items.` 
        });
      }
    }
  });

  const form = useForm<z.infer<typeof connectSchema>>({
    resolver: zodResolver(connectSchema),
    defaultValues: {
      shopDomain: "",
      accessToken: "",
    }
  });

  const onSubmit = (data: z.infer<typeof connectSchema>) => {
    connectMutation.mutate({ data });
  };

  if (isLoading) return null;

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/integrations">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <PageHeader title="Shopify Integration" className="mb-0" />
      </div>

      {!connection?.connected ? (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <SiShopify className="h-8 w-8 text-[#95bf47]" />
              <div>
                <CardTitle>Connect your store</CardTitle>
                <CardDescription>Enter your Shopify custom app credentials to sync products.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="shopDomain"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Shop Domain</FormLabel>
                      <FormControl>
                        <Input placeholder="https://your-store.myshopify.com" {...field} data-testid="input-shopify-domain" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="accessToken"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Admin API Access Token</FormLabel>
                      <FormControl>
                        <Input type="password" placeholder="shpat_..." {...field} data-testid="input-shopify-token" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button type="submit" disabled={connectMutation.isPending} data-testid="btn-connect-shopify">
                  {connectMutation.isPending ? "Connecting..." : "Connect Store"}
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
                  <div className="h-3 w-3 bg-[#95bf47] rounded-full animate-pulse"></div>
                  <CardTitle className="text-lg">Connected to Shopify</CardTitle>
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
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Store Domain</p>
                  <p className="font-medium">{connection.shopDomain}</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Last Synced</p>
                  <p>{connection.lastSyncedAt ? format(new Date(connection.lastSyncedAt), "MMM d, h:mm a") : "Never"}</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Products Tracked</p>
                  <p>{connection.productCount || 0}</p>
                </div>
              </div>
            </CardContent>
            <CardFooter className="bg-muted/30 border-t py-4">
              <Button 
                onClick={() => syncMutation.mutate()} 
                disabled={syncMutation.isPending}
                data-testid="btn-sync-shopify"
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
                {syncMutation.isPending ? "Syncing..." : "Sync Products Now"}
              </Button>
            </CardFooter>
          </Card>
        </div>
      )}
    </div>
  );
}
