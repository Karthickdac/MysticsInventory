import { useState } from "react";
import { useLocation } from "wouter";
import {
  useCompleteOnboarding,
  useListSubscriptionPlans,
  type SubscriptionPlan,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

export default function Onboarding() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const plansQuery = useListSubscriptionPlans();
  const [organizationName, setOrganizationName] = useState("");
  const [gstNumber, setGstNumber] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [planId, setPlanId] = useState<string>("starter");

  const completeOnboarding = useCompleteOnboarding({
    mutation: {
      onSuccess: async () => {
        await qc.invalidateQueries();
        toast({ title: "Workspace ready", description: "Welcome to Mystics Inventory." });
        setLocation("/dashboard");
      },
      onError: (err: unknown) => {
        toast({
          title: "Could not save",
          description: err instanceof Error ? err.message : "Try again",
          variant: "destructive",
        });
      },
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!organizationName.trim()) {
      toast({ title: "Workspace name is required", variant: "destructive" });
      return;
    }
    completeOnboarding.mutate({
      data: {
        organizationName: organizationName.trim(),
        gstNumber: gstNumber.trim() || null,
        addressLine1: addressLine1.trim() || null,
        city: city.trim() || null,
        state: state.trim() || null,
        postalCode: postalCode.trim() || null,
        plan: planId,
      },
    });
  }

  return (
    <div className="max-w-2xl mx-auto py-10">
      <Card>
        <CardHeader>
          <CardTitle>Welcome to Mystics Inventory</CardTitle>
          <CardDescription>
            Tell us about your business so we can set up your workspace. You can change everything later in Settings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4" data-testid="form-onboarding">
            <div className="space-y-2">
              <Label htmlFor="org-name">Business name</Label>
              <Input
                id="org-name"
                data-testid="input-org-name"
                value={organizationName}
                onChange={(e) => setOrganizationName(e.target.value)}
                placeholder="Acme Trading Co"
                required
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="gst">GSTIN (optional)</Label>
                <Input
                  id="gst"
                  data-testid="input-gst"
                  value={gstNumber}
                  onChange={(e) => setGstNumber(e.target.value)}
                  placeholder="22AAAAA0000A1Z5"
                  maxLength={20}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="postal">PIN code</Label>
                <Input
                  id="postal"
                  data-testid="input-postal"
                  value={postalCode}
                  onChange={(e) => setPostalCode(e.target.value)}
                  placeholder="560001"
                  maxLength={6}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="address">Address line</Label>
              <Input
                id="address"
                data-testid="input-address"
                value={addressLine1}
                onChange={(e) => setAddressLine1(e.target.value)}
                placeholder="221B Baker Street"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="city">City</Label>
                <Input
                  id="city"
                  data-testid="input-city"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="state">State</Label>
                <Input
                  id="state"
                  data-testid="input-state"
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Choose a starting plan</Label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {plansQuery.data?.map((p: SubscriptionPlan) => (
                  <button
                    key={p.id}
                    type="button"
                    data-testid={`plan-${p.id}`}
                    onClick={() => setPlanId(p.id)}
                    className={`text-left rounded-md border p-3 transition-colors ${
                      planId === p.id
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/50"
                    }`}
                  >
                    <div className="font-medium">{p.name}</div>
                    <div className="text-sm text-muted-foreground">
                      {p.priceMonthlyInPaise === 0
                        ? "Free trial"
                        : `Rs ${(p.priceMonthlyInPaise / 100).toLocaleString("en-IN")}/mo`}
                    </div>
                  </button>
                ))}
              </div>
            </div>
            <Button
              type="submit"
              className="w-full"
              data-testid="button-submit-onboarding"
              disabled={completeOnboarding.isPending}
            >
              {completeOnboarding.isPending ? "Saving..." : "Continue to dashboard"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
