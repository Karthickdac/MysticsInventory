import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
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
import { Switch } from "@/components/ui/switch";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle,
  ArrowLeft,
  Loader2,
  Plug,
  RefreshCw,
  Receipt,
  ShieldCheck,
  Unlink,
} from "lucide-react";
import { format } from "date-fns";
import {
  useGetEinvoiceConnection,
  useConnectEinvoice,
  useDisconnectEinvoice,
  useUpdateEinvoiceConnection,
  getGetEinvoiceConnectionQueryKey,
} from "@/lib/queryKeys";

const connectSchema = z.object({
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(
      /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9][A-Z][0-9A-Z]$/u,
      "Enter a valid 15-character GSTIN",
    ),
  username: z.string().trim().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  clientId: z.string().trim().optional(),
  clientSecret: z.string().optional(),
});

type ConnectValues = z.infer<typeof connectSchema>;

function formatTime(value: string | null | undefined) {
  if (!value) return "Never";
  return format(new Date(value), "MMM d, h:mm a");
}

export default function IntegrationEinvoice() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const {
    data: connection,
    isLoading,
    isError,
    error,
    refetch,
  } = useGetEinvoiceConnection();

  const form = useForm<ConnectValues>({
    resolver: zodResolver(connectSchema),
    defaultValues: {
      gstin: "",
      username: "",
      password: "",
      clientId: "",
      clientSecret: "",
    },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: getGetEinvoiceConnectionQueryKey(),
    });
  };

  const connectMutation = useConnectEinvoice({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "E-invoice account connected" });
        form.reset({
          gstin: "",
          username: "",
          password: "",
          clientId: "",
          clientSecret: "",
        });
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        toast({
          title: "Could not connect to IRP",
          description:
            e.response?.data?.error ??
            "Check your GSTIN, API username and password and try again.",
          variant: "destructive",
        });
      },
    },
  });

  const disconnectMutation = useDisconnectEinvoice({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "E-invoice account disconnected" });
      },
    },
  });

  const updateMutation = useUpdateEinvoiceConnection({
    mutation: {
      onSuccess: () => {
        invalidate();
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        toast({
          title: "Could not update e-invoice settings",
          description: e.response?.data?.error ?? "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  const onSubmit = (values: ConnectValues) => {
    connectMutation.mutate({
      data: {
        gstin: values.gstin,
        username: values.username,
        password: values.password,
        clientId: values.clientId?.trim() ? values.clientId.trim() : null,
        clientSecret: values.clientSecret ? values.clientSecret : null,
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
      <PageHeader title="E-invoice (IRP / GSP)" className="mb-0" />
    </div>
  );

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-2xl" data-testid="einvoice-loading">
        {header}
        <Card>
          <CardContent className="flex items-center gap-3 py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading e-invoice connection…
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-6 max-w-2xl" data-testid="einvoice-error">
        {header}
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive">
              Couldn&apos;t load e-invoice status
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

  const c = connection!;

  return (
    <div className="space-y-6 max-w-2xl">
      {header}

      {!c.connected ? (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Receipt className="h-8 w-8 text-emerald-600" />
              <div>
                <CardTitle>Connect your IRP account</CardTitle>
                <CardDescription>
                  Enter the GSTIN you file under and the API
                  username/password issued by the IRP API portal (or
                  the GSP that fronts it). The password is encrypted
                  at rest and used to refresh short-lived (~6 hour)
                  session tokens.
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
                  name="gstin"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>GSTIN</FormLabel>
                      <FormControl>
                        <Input
                          type="text"
                          placeholder="22AAAAA0000A1Z5"
                          maxLength={15}
                          {...field}
                          onChange={(e) =>
                            field.onChange(e.target.value.toUpperCase())
                          }
                          data-testid="input-einvoice-gstin"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="username"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>API Username</FormLabel>
                      <FormControl>
                        <Input
                          type="text"
                          autoComplete="username"
                          {...field}
                          data-testid="input-einvoice-username"
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
                      <FormLabel>API Password</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          autoComplete="current-password"
                          {...field}
                          data-testid="input-einvoice-password"
                        />
                      </FormControl>
                      <FormDescription>
                        IRP tokens last about 6 hours and can only be
                        refreshed with the username + password — so we
                        keep an encrypted copy of the password to
                        refresh silently in the background.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="clientId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>GSP client ID (optional)</FormLabel>
                        <FormControl>
                          <Input
                            type="text"
                            {...field}
                            data-testid="input-einvoice-client-id"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="clientSecret"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>GSP client secret (optional)</FormLabel>
                        <FormControl>
                          <Input
                            type="password"
                            autoComplete="off"
                            {...field}
                            data-testid="input-einvoice-client-secret"
                          />
                        </FormControl>
                        <FormDescription className="text-xs">
                          Required only when filing through a GSP that
                          issues an app-level credential pair.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <Button
                  type="submit"
                  disabled={connectMutation.isPending}
                  data-testid="btn-connect-einvoice"
                >
                  <Plug className="mr-2 h-4 w-4" />
                  {connectMutation.isPending ? "Connecting…" : "Connect"}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-emerald-200 dark:border-emerald-900/30">
          <CardHeader className="bg-emerald-50/50 dark:bg-emerald-900/10 rounded-t-xl border-b border-emerald-100 dark:border-emerald-900/20">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-3 w-3 bg-emerald-600 rounded-full animate-pulse" />
                <CardTitle className="text-lg">Connected to IRP</CardTitle>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => disconnectMutation.mutate()}
                disabled={disconnectMutation.isPending}
                data-testid="btn-disconnect-einvoice"
              >
                <Unlink className="h-4 w-4 mr-2" /> Disconnect
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
              <div>
                <p className="text-sm font-medium">
                  Auto-register IRN on invoice
                </p>
                <p className="text-xs text-muted-foreground">
                  When enabled, every B2B invoice (customer GSTIN
                  present) is sent to the IRP automatically when an
                  order moves to the Invoiced status.
                </p>
              </div>
              <Switch
                checked={c.enabled}
                disabled={updateMutation.isPending}
                onCheckedChange={(v) =>
                  updateMutation.mutate({ data: { enabled: v } })
                }
                data-testid="switch-einvoice-enabled"
              />
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="font-medium text-muted-foreground">GSTIN</p>
                <p
                  className="font-medium font-mono"
                  data-testid="text-einvoice-gstin"
                >
                  {c.gstin ?? "—"}
                </p>
              </div>
              <div>
                <p className="font-medium text-muted-foreground">
                  API username
                </p>
                <p data-testid="text-einvoice-username">
                  {c.username ?? "—"}
                </p>
              </div>
              <div>
                <p className="font-medium text-muted-foreground">
                  Token expires
                </p>
                <p>{formatTime(c.tokenExpiresAt)}</p>
              </div>
              <div>
                <p className="font-medium text-muted-foreground">
                  Connected on
                </p>
                <p>{formatTime(c.connectedAt)}</p>
              </div>
            </div>
            {c.lastErrorAt && c.lastErrorMessage && (
              <div
                className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                data-testid="einvoice-last-error"
              >
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">
                    Last IRP error · {formatTime(c.lastErrorAt)}
                  </p>
                  <p>{c.lastErrorMessage}</p>
                </div>
              </div>
            )}
            <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-emerald-600" />
              <p>
                Your password{c.hasClientCredentials ? " and GSP client secret" : ""}
                {" "}is encrypted at rest using AES-256-GCM and is only
                used to refresh expired session tokens. Disconnecting
                wipes the saved credentials and the cached token.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
