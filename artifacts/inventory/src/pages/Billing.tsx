import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { useGetSubscription, useListSubscriptionPlans, useCreateSubscriptionCheckout, useVerifySubscriptionPayment, getGetSubscriptionQueryKey } from "@/lib/queryKeys";
import { loadRazorpayScript } from "@/lib/razorpay";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Check, Zap, Shield, HelpCircle } from "lucide-react";
import { formatCurrency } from "@/lib/format";
import { format, parseISO } from "date-fns";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

export default function Billing() {
  const { data: sub, isLoading: subLoading } = useGetSubscription();
  const { data: plans, isLoading: plansLoading } = useListSubscriptionPlans();
  
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const checkoutMutation = useCreateSubscriptionCheckout();
  const verifyMutation = useVerifySubscriptionPayment({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetSubscriptionQueryKey() });
        toast({ title: "Subscription upgraded successfully", description: "Welcome to Mystics Pro!" });
      },
      onError: () => {
        toast({ title: "Payment verification failed", variant: "destructive" });
      }
    }
  });

  const handleUpgrade = async (planId: string) => {
    const isLoaded = await loadRazorpayScript();
    if (!isLoaded) {
      toast({ title: "Failed to load payment gateway", variant: "destructive" });
      return;
    }

    checkoutMutation.mutate({ data: { planId } }, {
      onSuccess: (session) => {
        const options = {
          key: session.razorpayKeyId,
          subscription_id: session.subscriptionId,
          name: "Mystics Inventory",
          description: session.planName,
          prefill: {
            name: session.customerName,
            email: session.customerEmail,
          },
          theme: { color: "#4f46e5" },
          handler: (response: any) => {
            verifyMutation.mutate({
              data: {
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySubscriptionId: response.razorpay_subscription_id,
                razorpaySignature: response.razorpay_signature,
              }
            });
          }
        };

        const rzp = new (window as any).Razorpay(options);
        rzp.open();
      },
      onError: () => {
        toast({ title: "Failed to initialize checkout", variant: "destructive" });
      }
    });
  };

  if (subLoading || plansLoading) {
    return <div className="space-y-6"><Skeleton className="h-40 w-full" /></div>;
  }

  const currentPlanObj = plans?.find(p => p.id === sub?.plan);

  return (
    <div className="space-y-8 max-w-4xl">
      <PageHeader 
        title="Billing & Subscription" 
        description="Manage your plan and payment methods."
      />

      <Card className="border-primary/20 bg-primary/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Current Plan: <Badge variant="default" className="text-sm px-3 py-0.5 uppercase tracking-widest">{sub?.plan}</Badge>
          </CardTitle>
          <CardDescription>
            {sub?.status === "active" ? (
              <span>Your subscription is active and renews on <strong className="text-foreground">{sub.currentPeriodEnd ? format(parseISO(sub.currentPeriodEnd), "MMMM d, yyyy") : ""}</strong>.</span>
            ) : sub?.isTrialing ? (
              <span>You are on a free trial until <strong className="text-foreground">{sub.trialEndsAt ? format(parseISO(sub.trialEndsAt), "MMMM d, yyyy") : ""}</strong>. Upgrade now to keep access.</span>
            ) : (
              <span>Your subscription is currently {sub?.status}.</span>
            )}
          </CardDescription>
        </CardHeader>
      </Card>

      <div className="grid md:grid-cols-2 gap-6 pt-4">
        {plans?.map((plan) => {
          const isCurrentPlan = sub?.plan === plan.id;
          const isPro = plan.id === "pro";
          
          return (
            <Card key={plan.id} className={`flex flex-col ${isPro ? 'border-primary shadow-md relative' : ''}`}>
              {isPro && (
                <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-primary text-primary-foreground px-3 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider">
                  Recommended
                </div>
              )}
              <CardHeader>
                <CardTitle className="text-2xl">{plan.name}</CardTitle>
                <div className="mt-4 flex items-baseline text-4xl font-extrabold">
                  {plan.priceMonthlyInPaise === 0 ? "Free" : formatCurrency(plan.priceMonthlyInPaise / 100)}
                  {plan.priceMonthlyInPaise > 0 && <span className="ml-1 text-xl font-medium text-muted-foreground">/mo</span>}
                </div>
              </CardHeader>
              <CardContent className="flex-1">
                <ul className="space-y-3">
                  {plan.features.map((feature, i) => (
                    <li key={i} className="flex gap-3 text-sm">
                      <Check className="h-5 w-5 shrink-0 text-primary" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
              <CardFooter>
                {isCurrentPlan ? (
                  <Button className="w-full" variant="outline" disabled>Current Plan</Button>
                ) : plan.priceMonthlyInPaise > 0 ? (
                  <Button 
                    className="w-full text-lg h-12" 
                    onClick={() => handleUpgrade(plan.id)}
                    disabled={checkoutMutation.isPending || verifyMutation.isPending}
                    data-testid={`btn-upgrade-${plan.id}`}
                  >
                    {checkoutMutation.isPending || verifyMutation.isPending ? "Processing..." : "Upgrade Now"}
                  </Button>
                ) : (
                  <Button className="w-full" variant="outline" disabled>Cannot downgrade</Button>
                )}
              </CardFooter>
            </Card>
          );
        })}
      </div>

      <div className="mt-12 space-y-6">
        <h3 className="text-xl font-semibold">Frequently Asked Questions</h3>
        <div className="grid md:grid-cols-2 gap-6">
          <div>
            <h4 className="font-medium flex items-center gap-2 mb-2"><HelpCircle className="h-4 w-4 text-primary" /> What happens when my trial ends?</h4>
            <p className="text-sm text-muted-foreground">Your account will be paused until you subscribe to a paid plan. Your data is safe and will not be deleted.</p>
          </div>
          <div>
            <h4 className="font-medium flex items-center gap-2 mb-2"><Shield className="h-4 w-4 text-primary" /> Is my payment secure?</h4>
            <p className="text-sm text-muted-foreground">Yes. All payments are processed securely through Razorpay. We do not store your credit card information.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
