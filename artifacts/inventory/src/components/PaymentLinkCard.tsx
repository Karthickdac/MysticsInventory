import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListSalesOrderPaymentLinks,
  useCreateSalesOrderPaymentLink,
  useCancelPaymentLink,
  getListSalesOrderPaymentLinksQueryKey,
  getGetSalesOrderQueryKey,
} from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Copy, Link as LinkIcon, X, AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatDate } from "@/lib/format";

interface PaymentLinkCardProps {
  salesOrderId: number;
  balanceDue: number;
  orderStatus: string;
}

// Mirrors PAYABLE_ORDER_STATUSES on the backend (customerPayments.ts) so we
// don't surface a "Generate link" button for orders the API will reject with
// a 400.
const PAYABLE_STATUSES = new Set([
  "confirmed",
  "shipped",
  "delivered",
  "invoiced",
]);

const STATUS_VARIANTS: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  created: "default",
  paid: "secondary",
  cancelled: "outline",
  expired: "outline",
};

const STATUS_LABELS: Record<string, string> = {
  created: "Active",
  paid: "Paid",
  cancelled: "Cancelled",
  expired: "Expired",
};

export function PaymentLinkCard({
  salesOrderId,
  balanceDue,
  orderStatus,
}: PaymentLinkCardProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [notConfigured, setNotConfigured] = useState(false);

  const { data: links, isLoading } = useListSalesOrderPaymentLinks(salesOrderId, {
    query: {
      enabled: !!salesOrderId,
      queryKey: getListSalesOrderPaymentLinksQueryKey(salesOrderId),
    },
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({
      queryKey: getListSalesOrderPaymentLinksQueryKey(salesOrderId),
    });
    queryClient.invalidateQueries({
      queryKey: getGetSalesOrderQueryKey(salesOrderId),
    });
  };

  const createMut = useCreateSalesOrderPaymentLink({
    mutation: {
      onSuccess: () => {
        toast({ title: "Payment link generated" });
        setNotConfigured(false);
        invalidateAll();
      },
      onError: (err: unknown) => {
        const e = err as {
          status?: number;
          message?: string;
          data?: { error?: string };
        };
        const msg = e?.data?.error || e?.message || "Could not create payment link";
        if (e?.status === 503) {
          setNotConfigured(true);
          return;
        }
        toast({
          title: "Could not create payment link",
          description: msg,
          variant: "destructive",
        });
      },
    },
  });

  const cancelMut = useCancelPaymentLink({
    mutation: {
      onSuccess: () => {
        toast({ title: "Payment link cancelled" });
        invalidateAll();
      },
      onError: (err: unknown) => {
        const e = err as { message?: string; data?: { error?: string } };
        toast({
          title: "Could not cancel link",
          description: e?.data?.error || e?.message || "Try again",
          variant: "destructive",
        });
      },
    },
  });

  const sortedLinks = [...(links ?? [])].sort((a, b) => {
    return (
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  });
  const activeLink = sortedLinks.find((l) => l.status === "created");

  const canGenerate =
    balanceDue > 0 && PAYABLE_STATUSES.has(orderStatus) && !activeLink;

  const handleCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: "Link copied to clipboard" });
    } catch {
      toast({
        title: "Could not copy",
        description: "Copy the link manually from the address shown.",
        variant: "destructive",
      });
    }
  };

  if (!PAYABLE_STATUSES.has(orderStatus) && (links?.length ?? 0) === 0) {
    return null;
  }

  return (
    <Card data-testid="card-payment-link">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2">
          <LinkIcon className="h-4 w-4" />
          Razorpay payment link
        </CardTitle>
        {canGenerate && (
          <Button
            size="sm"
            onClick={() =>
              createMut.mutate({ id: salesOrderId, data: {} })
            }
            disabled={createMut.isPending}
            data-testid="btn-generate-payment-link"
          >
            {createMut.isPending ? "Generating..." : "Generate link"}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {notConfigured && (
          <Alert variant="default" data-testid="alert-razorpay-not-configured">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Razorpay not configured</AlertTitle>
            <AlertDescription>
              Add your Razorpay key id and secret in environment settings to
              generate payment links.
            </AlertDescription>
          </Alert>
        )}

        {isLoading && <Skeleton className="h-12 w-full" />}

        {!isLoading && sortedLinks.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No payment links yet. Generate one to share a hosted Razorpay
            checkout with this customer.
          </p>
        )}

        {sortedLinks.map((link) => (
          <div
            key={link.id}
            className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
            data-testid={`row-payment-link-${link.id}`}
          >
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <Badge variant={STATUS_VARIANTS[link.status] ?? "outline"}>
                  {STATUS_LABELS[link.status] ?? link.status}
                </Badge>
                <span className="text-sm font-medium">
                  {formatCurrency(link.amount)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatDate(link.createdAt)}
                </span>
              </div>
              <a
                href={link.shortUrl}
                target="_blank"
                rel="noreferrer"
                className="block truncate text-xs text-primary hover:underline"
                data-testid={`link-payment-url-${link.id}`}
              >
                {link.shortUrl}
              </a>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleCopy(link.shortUrl)}
                data-testid={`btn-copy-link-${link.id}`}
              >
                <Copy className="mr-1 h-3 w-3" /> Copy
              </Button>
              {link.status === "created" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => cancelMut.mutate({ id: link.id })}
                  disabled={cancelMut.isPending}
                  data-testid={`btn-cancel-link-${link.id}`}
                >
                  <X className="mr-1 h-3 w-3" /> Cancel
                </Button>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
