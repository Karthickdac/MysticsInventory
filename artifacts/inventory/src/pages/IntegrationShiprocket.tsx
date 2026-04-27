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
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Loader2,
  RefreshCw,
  Unlink,
  Plug,
  Truck,
  ShieldCheck,
} from "lucide-react";
import { format } from "date-fns";
import {
  useGetShiprocketConnection,
  useConnectShiprocket,
  useDisconnectShiprocket,
  useSyncShiprocketTracking,
  getGetShiprocketConnectionQueryKey,
  getListSalesOrdersQueryKey,
} from "@/lib/queryKeys";

const connectSchema = z.object({
  email: z.string().email("Enter a valid Shiprocket email"),
  password: z.string().min(1, "Password is required"),
  pickupPincode: z
    .string()
    .trim()
    .regex(/^[0-9]{6}$/u, "Pincode must be 6 digits")
    .optional()
    .or(z.literal("")),
});

type ConnectValues = z.infer<typeof connectSchema>;

function formatTime(value: string | null | undefined) {
  if (!value) return "Never";
  return format(new Date(value), "MMM d, h:mm a");
}

export default function IntegrationShiprocket() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const {
    data: connection,
    isLoading,
    isError,
    error,
    refetch,
  } = useGetShiprocketConnection();

  const connectMutation = useConnectShiprocket({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getGetShiprocketConnectionQueryKey(),
        });
        toast({ title: "Shiprocket connected" });
        form.reset({ email: "", password: "", pickupPincode: "" });
      },
      onError: (err: unknown) => {
        toast({
          title: "Could not connect to Shiprocket",
          description:
            err instanceof Error
              ? err.message
              : "Check your credentials and try again.",
          variant: "destructive",
        });
      },
    },
  });

  const disconnectMutation = useDisconnectShiprocket({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getGetShiprocketConnectionQueryKey(),
        });
        toast({ title: "Shiprocket disconnected" });
      },
    },
  });

  const syncMutation = useSyncShiprocketTracking({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({
          queryKey: getGetShiprocketConnectionQueryKey(),
        });
        // Tracking refresh may have updated shipment trackingStatus on
        // many sales orders — drop every cached sales-order list/detail
        // and shipments entry so any open detail view repaints with
        // fresh badges and tracking info.
        queryClient.invalidateQueries({
          queryKey: getListSalesOrdersQueryKey(),
        });
        queryClient.invalidateQueries({
          predicate: (query) => {
            const first = query.queryKey?.[0];
            return (
              typeof first === "string" && first.startsWith("/api/sales-orders")
            );
          },
        });
        toast({
          title: "Tracking sync complete",
          description: `Updated ${data.updated}, skipped ${data.skipped}, failed ${data.failed}.`,
        });
      },
      onError: (err: unknown) => {
        toast({
          title: "Tracking sync failed",
          description: err instanceof Error ? err.message : "Try again later.",
          variant: "destructive",
        });
      },
    },
  });

  const form = useForm<ConnectValues>({
    resolver: zodResolver(connectSchema),
    defaultValues: { email: "", password: "", pickupPincode: "" },
  });

  const onSubmit = (values: ConnectValues) => {
    connectMutation.mutate({
      data: {
        email: values.email,
        password: values.password,
        pickupPincode: values.pickupPincode?.trim()
          ? values.pickupPincode.trim()
          : null,
      },
    });
  };

  const header = (
    <div className="flex items-center gap-4">
      <Button variant="ghost" size="icon" asChild>
        <Link href="/integrations">
          <ArrowLeft className="h-5 w-5" />
        </Link>
      </Button>
      <PageHeader title="Shiprocket Integration" className="mb-0" />
    </div>
  );

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-2xl" data-testid="shiprocket-loading">
        {header}
        <Card>
          <CardContent className="flex items-center gap-3 py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading Shiprocket connection…
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-6 max-w-2xl" data-testid="shiprocket-error">
        {header}
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive">
              Couldn't load Shiprocket status
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

  // "Connected before but the token has expired or was revoked" —
  // show a reconnect prompt distinct from the first-time connect
  // view. Shiprocket has no refresh-token mechanism and we
  // deliberately do not store the password, so this branch fires
  // every ~10 days (when the token TTL elapses) or whenever the
  // server clears a token after a 401 from Shiprocket.
  const previouslyConnected = !connection?.connected && !!connection?.email;

  return (
    <div className="space-y-6 max-w-2xl">
      {header}

      {!connection?.connected ? (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Truck className="h-8 w-8 text-blue-600" />
              <div>
                <CardTitle>
                  {previouslyConnected
                    ? "Reconnect your Shiprocket account"
                    : "Connect your Shiprocket account"}
                </CardTitle>
                <CardDescription>
                  {previouslyConnected
                    ? "Your Shiprocket session has expired (tokens last about 10 days). Re-enter your password to mint a fresh one and continue booking shipments."
                    : "Enter the email and password you use to sign in to Shiprocket. Your password is used once to obtain an API token and is then discarded — only the encrypted token is stored."}
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
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input
                          type="email"
                          placeholder={connection?.email ?? "you@business.com"}
                          autoComplete="username"
                          {...field}
                          data-testid="input-shiprocket-email"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Password</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          autoComplete="current-password"
                          {...field}
                          data-testid="input-shiprocket-password"
                        />
                      </FormControl>
                      <FormDescription>
                        Used once to obtain an API token from Shiprocket
                        and then discarded — your password is never written
                        to our database.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="pickupPincode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Pickup pincode (optional)</FormLabel>
                      <FormControl>
                        <Input
                          type="text"
                          inputMode="numeric"
                          maxLength={6}
                          placeholder="e.g. 110001"
                          {...field}
                          data-testid="input-shiprocket-pickup-pincode"
                        />
                      </FormControl>
                      <FormDescription>
                        Used to look up courier rates. Defaults to your
                        organization address pincode if left blank.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  disabled={connectMutation.isPending}
                  data-testid="btn-connect-shiprocket"
                >
                  <Plug className="mr-2 h-4 w-4" />
                  {connectMutation.isPending
                    ? "Connecting…"
                    : previouslyConnected
                    ? "Reconnect"
                    : "Connect"}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          <Card className="border-blue-200 dark:border-blue-900/30">
            <CardHeader className="bg-blue-50/50 dark:bg-blue-900/10 rounded-t-xl border-b border-blue-100 dark:border-blue-900/20">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-3 w-3 bg-blue-600 rounded-full animate-pulse" />
                  <CardTitle className="text-lg">
                    Connected to Shiprocket
                  </CardTitle>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => disconnectMutation.mutate()}
                  disabled={disconnectMutation.isPending}
                  data-testid="btn-disconnect-shiprocket"
                >
                  <Unlink className="h-4 w-4 mr-2" /> Disconnect
                </Button>
              </div>
            </CardHeader>
            <CardContent className="pt-6 space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="font-medium text-muted-foreground">Account</p>
                  <p className="font-medium" data-testid="text-shiprocket-email">
                    {connection.email ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="font-medium text-muted-foreground">
                    Token expires
                  </p>
                  <p>{formatTime(connection.tokenExpiresAt)}</p>
                </div>
                <div>
                  <p className="font-medium text-muted-foreground">
                    Last tracking sync
                  </p>
                  <p>{formatTime(connection.lastSyncedAt)}</p>
                </div>
                <div>
                  <p className="font-medium text-muted-foreground">
                    Pickup pincode
                  </p>
                  <p data-testid="text-shiprocket-pickup-pincode">
                    {connection.pickupPincode ?? "Not set"}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-blue-600" />
                <p>
                  Only your encrypted Shiprocket API token is stored — your
                  password is used once at connect time and then discarded.
                  Shiprocket tokens last about 10 days; when this one
                  expires you'll see a "Reconnect" prompt here to mint a
                  fresh one.
                </p>
              </div>
            </CardContent>
            <CardFooter className="bg-muted/30 border-t py-4 gap-2 flex-wrap">
              <Button
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
                data-testid="btn-sync-shiprocket-tracking"
              >
                <RefreshCw
                  className={`mr-2 h-4 w-4 ${
                    syncMutation.isPending ? "animate-spin" : ""
                  }`}
                />
                {syncMutation.isPending
                  ? "Syncing tracking…"
                  : "Sync tracking now"}
              </Button>
            </CardFooter>
          </Card>
        </div>
      )}
    </div>
  );
}
