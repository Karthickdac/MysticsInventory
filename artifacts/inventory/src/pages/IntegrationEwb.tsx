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
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  AlertTriangle,
  FileText,
  Loader2,
  Plug,
  RefreshCw,
  ShieldCheck,
  Unlink,
} from "lucide-react";
import { format } from "date-fns";
import {
  useGetEwbConnection,
  useConnectEwb,
  useDisconnectEwb,
  getGetEwbConnectionQueryKey,
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
});

type ConnectValues = z.infer<typeof connectSchema>;

function formatTime(value: string | null | undefined) {
  if (!value) return "Never";
  return format(new Date(value), "MMM d, h:mm a");
}

export default function IntegrationEwb() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const {
    data: connection,
    isLoading,
    isError,
    error,
    refetch,
  } = useGetEwbConnection();

  const form = useForm<ConnectValues>({
    resolver: zodResolver(connectSchema),
    defaultValues: { gstin: "", username: "", password: "" },
  });

  const connectMutation = useConnectEwb({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getGetEwbConnectionQueryKey(),
        });
        toast({ title: "E-way bill account connected" });
        form.reset({ gstin: "", username: "", password: "" });
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        toast({
          title: "Could not connect to NIC EWB",
          description:
            e.response?.data?.error ??
            "Check your GSTIN, username and password and try again.",
          variant: "destructive",
        });
      },
    },
  });

  const disconnectMutation = useDisconnectEwb({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getGetEwbConnectionQueryKey(),
        });
        toast({ title: "E-way bill account disconnected" });
      },
    },
  });

  const onSubmit = (values: ConnectValues) => {
    connectMutation.mutate({
      data: {
        gstin: values.gstin,
        username: values.username,
        password: values.password,
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
      <PageHeader title="E-way Bill (NIC)" className="mb-0" />
    </div>
  );

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-2xl" data-testid="ewb-loading">
        {header}
        <Card>
          <CardContent className="flex items-center gap-3 py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading e-way bill connection…
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-6 max-w-2xl" data-testid="ewb-error">
        {header}
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive">
              Couldn&apos;t load EWB status
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
              <FileText className="h-8 w-8 text-amber-600" />
              <div>
                <CardTitle>Connect your NIC EWB account</CardTitle>
                <CardDescription>
                  Enter your GSTIN and the API username/password issued by the
                  NIC EWB portal (under <em>API Registration</em>). The
                  password is encrypted at rest and used to refresh
                  short-lived (~6 hour) session tokens.
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
                          data-testid="input-ewb-gstin"
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
                          data-testid="input-ewb-username"
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
                          data-testid="input-ewb-password"
                        />
                      </FormControl>
                      <FormDescription>
                        NIC tokens last about 6 hours and can only be
                        refreshed with the username + password — so we keep
                        an encrypted copy of the password to refresh
                        silently in the background.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  disabled={connectMutation.isPending}
                  data-testid="btn-connect-ewb"
                >
                  <Plug className="mr-2 h-4 w-4" />
                  {connectMutation.isPending ? "Connecting…" : "Connect"}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-amber-200 dark:border-amber-900/30">
          <CardHeader className="bg-amber-50/50 dark:bg-amber-900/10 rounded-t-xl border-b border-amber-100 dark:border-amber-900/20">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-3 w-3 bg-amber-600 rounded-full animate-pulse" />
                <CardTitle className="text-lg">Connected to NIC EWB</CardTitle>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => disconnectMutation.mutate()}
                disabled={disconnectMutation.isPending}
                data-testid="btn-disconnect-ewb"
              >
                <Unlink className="h-4 w-4 mr-2" /> Disconnect
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-6 space-y-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="font-medium text-muted-foreground">GSTIN</p>
                <p className="font-medium font-mono" data-testid="text-ewb-gstin">
                  {c.gstin ?? "—"}
                </p>
              </div>
              <div>
                <p className="font-medium text-muted-foreground">API username</p>
                <p data-testid="text-ewb-username">{c.username ?? "—"}</p>
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
                data-testid="ewb-last-error"
              >
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">
                    Last NIC error · {formatTime(c.lastErrorAt)}
                  </p>
                  <p>{c.lastErrorMessage}</p>
                </div>
              </div>
            )}
            <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
              <p>
                Your password is encrypted at rest using AES-256-GCM and is
                only used to refresh expired session tokens. Disconnecting
                wipes both the password and the cached token.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
