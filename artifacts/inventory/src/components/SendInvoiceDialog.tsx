import { useEffect, useState } from "react";
import {
  useEmailSalesOrderInvoice,
  useGetCustomer,
  getGetCustomerQueryKey,
  getListSalesOrderEmailLogQueryKey,
} from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  salesOrderId: number;
  orderNumber: string;
  customerId: number;
  customerName: string;
}

export function SendInvoiceDialog({
  open,
  onOpenChange,
  salesOrderId,
  orderNumber,
  customerId,
  customerName,
}: Props) {
  const customerQuery = useGetCustomer(customerId, {
    query: {
      enabled: open && !!customerId,
      queryKey: getGetCustomerQueryKey(customerId),
    },
  });
  const defaultRecipient = customerQuery.data?.email ?? "";

  const [to, setTo] = useState("");
  const [subject, setSubject] = useState(`Invoice ${orderNumber}`);
  const [body, setBody] = useState(
    `Hi ${customerName},\n\nPlease find attached invoice ${orderNumber} for your records.\n\nThanks!`,
  );

  const queryClient = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    if (open) {
      setTo(defaultRecipient);
      setSubject(`Invoice ${orderNumber}`);
      setBody(
        `Hi ${customerName},\n\nPlease find attached invoice ${orderNumber} for your records.\n\nThanks!`,
      );
    }
  }, [open, defaultRecipient, customerName, orderNumber]);

  const sendMutation = useEmailSalesOrderInvoice({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getListSalesOrderEmailLogQueryKey(salesOrderId),
        });
        toast({
          title: "Invoice sent",
          description: `The invoice has been emailed to ${to}.`,
        });
        onOpenChange(false);
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        queryClient.invalidateQueries({
          queryKey: getListSalesOrderEmailLogQueryKey(salesOrderId),
        });
        toast({
          title: "Could not send invoice",
          description:
            e.response?.data?.error ??
            "Please verify your email settings and try again.",
          variant: "destructive",
        });
      },
    },
  });

  const handleSend = () => {
    if (!to.trim()) return;
    sendMutation.mutate({
      id: salesOrderId,
      data: { to: to.trim(), subject: subject.trim() || null, body: body || null },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send invoice to customer</DialogTitle>
          <DialogDescription>
            We'll attach the invoice PDF and (when possible) include a secure
            link the customer can open without signing in.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="invoice-to">To</Label>
            <Input
              id="invoice-to"
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="customer@example.com"
              data-testid="input-invoice-to"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="invoice-subject">Subject</Label>
            <Input
              id="invoice-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              data-testid="input-invoice-subject"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="invoice-body">Message</Label>
            <Textarea
              id="invoice-body"
              rows={6}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              data-testid="input-invoice-body"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={sendMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSend}
            disabled={sendMutation.isPending || !to.trim()}
            data-testid="btn-send-invoice"
          >
            {sendMutation.isPending ? "Sending..." : "Send invoice"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
