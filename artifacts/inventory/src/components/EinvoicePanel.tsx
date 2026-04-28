import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Loader2,
  Receipt,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { Link } from "wouter";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  useGenerateSalesOrderIrn,
  useCancelSalesOrderIrn,
  useGetEinvoiceConnection,
  getGetSalesOrderQueryKey,
  CancelIrnPayloadReasonCode,
  type EinvoiceDetails,
} from "@/lib/queryKeys";
import { buildEinvoiceFixes } from "@/lib/einvoiceFixes";

interface EinvoicePanelProps {
  orderId: number;
  orderNumber: string;
  orderStatus: string;
  customerId: number;
  customerName: string;
  customerHasGstin: boolean;
  einvoice: EinvoiceDetails | null | undefined;
}

const CANCEL_REASONS = [
  { code: "1", label: "1 — Duplicate" },
  { code: "2", label: "2 — Data entry mistake" },
  { code: "3", label: "3 — Order cancelled" },
  { code: "4", label: "4 — Other" },
];

function formatTime(value: string | null | undefined) {
  if (!value) return "—";
  return format(new Date(value), "MMM d, h:mm a");
}

function StatusBadge({
  einvoice,
}: {
  einvoice: EinvoiceDetails | null | undefined;
}) {
  if (!einvoice || !einvoice.status) {
    return (
      <Badge variant="outline" className="bg-muted/40">
        Not generated
      </Badge>
    );
  }
  if (einvoice.status === "active") {
    return (
      <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
        <CheckCircle2 className="mr-1 h-3 w-3" /> Active
      </Badge>
    );
  }
  if (einvoice.status === "cancelled") {
    return (
      <Badge variant="outline" className="border-destructive/40 text-destructive">
        <XCircle className="mr-1 h-3 w-3" /> Cancelled
      </Badge>
    );
  }
  if (einvoice.status === "failed") {
    return (
      <Badge variant="destructive">
        <AlertTriangle className="mr-1 h-3 w-3" /> Failed
      </Badge>
    );
  }
  return <Badge variant="outline">{einvoice.status}</Badge>;
}

export function EinvoicePanel({
  orderId,
  orderNumber,
  orderStatus,
  customerId,
  customerName,
  customerHasGstin,
  einvoice,
}: EinvoicePanelProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const connectionQuery = useGetEinvoiceConnection();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReasonCode, setCancelReasonCode] =
    useState<(typeof CancelIrnPayloadReasonCode)[keyof typeof CancelIrnPayloadReasonCode]>(
      CancelIrnPayloadReasonCode.NUMBER_2,
    );
  const [cancelRemarks, setCancelRemarks] = useState("");

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: getGetSalesOrderQueryKey(orderId),
    });
  };

  const generateMutation = useGenerateSalesOrderIrn({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "IRN generated" });
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        toast({
          title: "Could not generate IRN",
          description: e.response?.data?.error ?? "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  const cancelMutation = useCancelSalesOrderIrn({
    mutation: {
      onSuccess: () => {
        invalidate();
        setCancelOpen(false);
        setCancelRemarks("");
        toast({ title: "IRN cancelled" });
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        toast({
          title: "Could not cancel IRN",
          description: e.response?.data?.error ?? "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  const orderInvoiced = ["invoiced", "paid"].includes(orderStatus);

  if (connectionQuery.isLoading) {
    return null;
  }

  if (!connectionQuery.data?.connected) {
    if (!einvoice?.irn) return null;
    return (
      <Card data-testid="einvoice-panel">
        <CardHeader>
          <div className="flex items-center gap-3">
            <Receipt className="h-6 w-6 text-emerald-600" />
            <div>
              <CardTitle>e-Invoice (IRP)</CardTitle>
              <CardDescription>
                Reconnect your IRP account to manage this IRN.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link href="/integrations/einvoice">Set up e-invoice integration</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!connectionQuery.data.enabled && !einvoice?.irn) {
    return null;
  }

  const showSetupHint = !customerHasGstin && !einvoice?.irn;
  const isCancelled = einvoice?.status === "cancelled";

  return (
    <Card data-testid="einvoice-panel">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Receipt className="h-6 w-6 text-emerald-600" />
          <div>
            <CardTitle>e-Invoice (IRP)</CardTitle>
            <CardDescription>
              {einvoice?.irn
                ? `IRN ${einvoice.irn.slice(0, 16)}…`
                : isCancelled
                  ? "This invoice's IRN was cancelled at the IRP."
                  : showSetupHint
                    ? "Customer has no GSTIN — IRN is not required for B2C invoices."
                    : "No IRN has been registered for this invoice yet."}
            </CardDescription>
          </div>
        </div>
        <StatusBadge einvoice={einvoice ?? null} />
      </CardHeader>
      <CardContent className="space-y-4">
        {einvoice?.irn ? (
          <>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <div className="grid flex-1 grid-cols-2 gap-4 text-sm">
                <div className="col-span-2">
                  <p className="text-muted-foreground font-medium">IRN</p>
                  <p
                    className="font-mono text-xs break-all"
                    data-testid="text-einvoice-irn"
                  >
                    {einvoice.irn}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground font-medium">Ack #</p>
                  <p className="font-mono" data-testid="text-einvoice-ack">
                    {einvoice.ackNumber ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground font-medium">Ack date</p>
                  <p>{formatTime(einvoice.ackDate)}</p>
                </div>
              </div>
              {einvoice.qrPayload && einvoice.status === "active" && (
                <div className="flex flex-col items-center gap-1">
                  <img
                    src={`/api/sales-orders/${orderId}/einvoice/qr.png`}
                    alt={`IRN ${einvoice.irn} signed QR code`}
                    className="h-32 w-32 rounded border bg-white p-1"
                    data-testid="img-einvoice-qr"
                  />
                  <p className="text-xs text-muted-foreground">Signed QR</p>
                </div>
              )}
            </div>
            {einvoice.cancelledAt && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs">
                <p className="font-medium text-destructive">
                  Cancelled on {formatTime(einvoice.cancelledAt)}
                </p>
                {einvoice.cancelReason && (
                  <p className="text-muted-foreground mt-1">
                    {einvoice.cancelReason}
                  </p>
                )}
              </div>
            )}
            {einvoice.status === "active" && einvoice.cancellable && (
              <div className="flex flex-wrap gap-2 pt-1">
                <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
                  <DialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      data-testid="btn-cancel-einvoice"
                    >
                      <Ban className="mr-2 h-4 w-4" /> Cancel IRN
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Cancel IRN</DialogTitle>
                      <DialogDescription>
                        IRNs can only be cancelled within 24 hours of
                        registration. The cancellation is permanent and
                        the IRP will not let you re-register the same
                        invoice number.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <Label>Reason</Label>
                        <Select
                          value={cancelReasonCode}
                          onValueChange={(v) =>
                            setCancelReasonCode(
                              v as (typeof CancelIrnPayloadReasonCode)[keyof typeof CancelIrnPayloadReasonCode],
                            )
                          }
                        >
                          <SelectTrigger data-testid="select-cancel-reason">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {CANCEL_REASONS.map((r) => (
                              <SelectItem key={r.code} value={r.code}>
                                {r.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label>Remarks</Label>
                        <Textarea
                          value={cancelRemarks}
                          onChange={(e) => setCancelRemarks(e.target.value)}
                          maxLength={100}
                          placeholder="Briefly explain why this IRN is being cancelled (max 100 chars)."
                          data-testid="textarea-cancel-remarks"
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button
                        variant="outline"
                        onClick={() => setCancelOpen(false)}
                      >
                        Keep IRN
                      </Button>
                      <Button
                        variant="destructive"
                        disabled={
                          cancelMutation.isPending ||
                          cancelRemarks.trim().length === 0
                        }
                        onClick={() =>
                          cancelMutation.mutate({
                            id: orderId,
                            data: {
                              reasonCode: cancelReasonCode,
                              reasonRemark: cancelRemarks.trim(),
                            },
                          })
                        }
                        data-testid="btn-confirm-cancel-einvoice"
                      >
                        {cancelMutation.isPending && (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        )}
                        Cancel IRN
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            )}
            {einvoice.status === "active" && !einvoice.cancellable && (
              <p className="text-xs text-muted-foreground">
                The 24-hour cancellation window for this IRN has passed.
                Issue a credit note to reverse it.
              </p>
            )}
          </>
        ) : (
          <>
            {einvoice?.error && (
              <div
                className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs"
                data-testid="einvoice-error-block"
              >
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
                <div>
                  <p className="font-medium text-destructive">
                    Last attempt failed
                  </p>
                  <p className="text-muted-foreground mt-1">{einvoice.error}</p>
                </div>
              </div>
            )}
            {einvoice &&
              (() => {
                const fixes = buildEinvoiceFixes(einvoice, {
                  customerId,
                  customerName,
                });
                if (fixes.length === 0) return null;
                return (
                  <div
                    className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-900/60 dark:bg-amber-950/40"
                    data-testid="einvoice-whattofix"
                  >
                    <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                      What to fix
                    </p>
                    <p className="mt-0.5 text-amber-800/90 dark:text-amber-200/80">
                      Resolve the issue below, then retry. The IRP will accept the
                      invoice once the underlying record is corrected.
                    </p>
                    <ul className="mt-2 space-y-2">
                      {fixes.map((fix, i) => (
                        <li
                          key={i}
                          className="flex flex-col gap-2 rounded border border-amber-200 bg-white p-2 sm:flex-row sm:items-start sm:justify-between dark:border-amber-900/60 dark:bg-amber-950/60"
                          data-testid={`einvoice-fix-${einvoice.errorCode ?? "unknown"}`}
                        >
                          <div className="min-w-0">
                            <p className="font-medium text-amber-900 dark:text-amber-100">
                              {fix.title}
                            </p>
                            <p className="mt-0.5 text-amber-800/80 dark:text-amber-200/70">
                              {fix.detail}
                            </p>
                          </div>
                          <Button
                            asChild
                            size="sm"
                            variant="outline"
                            className="shrink-0"
                            data-testid={`btn-einvoice-fix-${einvoice.errorCode ?? "unknown"}`}
                          >
                            <Link href={fix.href}>{fix.cta}</Link>
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })()}
            {isCancelled ? (
              <div
                className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs"
                data-testid="einvoice-cancelled-block"
              >
                <p className="font-medium text-destructive">
                  IRN cancelled — re-registration is blocked
                </p>
                {einvoice?.cancelledAt && (
                  <p className="text-muted-foreground mt-1">
                    Cancelled on {formatTime(einvoice.cancelledAt)}
                    {einvoice.cancelReason ? ` — ${einvoice.cancelReason}` : ""}
                  </p>
                )}
                <p className="text-muted-foreground mt-1">
                  The IRP does not allow a second IRN against the same
                  invoice number. Issue a credit note against this order
                  to reverse it.
                </p>
              </div>
            ) : orderInvoiced && customerHasGstin ? (
              <Button
                size="sm"
                onClick={() => generateMutation.mutate({ id: orderId })}
                disabled={generateMutation.isPending}
                data-testid="btn-generate-einvoice"
              >
                {generateMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : einvoice?.error ? (
                  <RefreshCw className="mr-2 h-4 w-4" />
                ) : (
                  <Receipt className="mr-2 h-4 w-4" />
                )}
                {einvoice?.error ? "Retry IRN" : "Generate IRN"}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                {!customerHasGstin
                  ? "Add a GSTIN to the customer to enable e-invoicing."
                  : `Move the order to status Invoiced to register the IRN (current status: ${orderStatus}).`}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
