import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Textarea } from "@/components/ui/textarea";
import { useGetCurrentOrganization, useUpdateCurrentOrganization, getGetCurrentOrganizationQueryKey } from "@/lib/queryKeys";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useEffect } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Building2, FileCheck2, ChevronRight } from "lucide-react";
import { Link } from "wouter";
import { ImageUploader } from "@/components/ImageUploader";

const orgSchema = z.object({
  name: z.string().min(1, "Organization name is required"),
  currency: z.string().min(3),
  timezone: z.string().min(1),
  gstNumber: z.string().optional().or(z.literal("")),
  addressLine1: z.string().optional().or(z.literal("")),
  city: z.string().optional().or(z.literal("")),
  state: z.string().optional().or(z.literal("")),
  postalCode: z.string().optional().or(z.literal("")),
  country: z.string().optional().or(z.literal("")),
  // Either an uploaded object-storage path (`/objects/uploads/<id>`) or a full
  // https URL (e.g. a Shopify CDN logo synced in from elsewhere).
  logoUrl: z
    .string()
    .refine(
      (v) => v === "" || v.startsWith("/objects/") || /^https?:\/\//i.test(v),
      "Must be an uploaded image or a valid URL",
    )
    .optional()
    .or(z.literal("")),
  invoiceFooter: z.string().optional().or(z.literal("")),
});

type OrgFormValues = z.infer<typeof orgSchema>;

export default function Settings() {
  const { data: org, isLoading } = useGetCurrentOrganization();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const updateMutation = useUpdateCurrentOrganization({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCurrentOrganizationQueryKey() });
        toast({ title: "Settings saved successfully" });
      }
    }
  });

  const form = useForm<OrgFormValues>({
    resolver: zodResolver(orgSchema),
    defaultValues: {
      name: "",
      currency: "INR",
      timezone: "Asia/Kolkata",
      gstNumber: "",
      addressLine1: "",
      city: "",
      state: "",
      postalCode: "",
      country: "India",
      logoUrl: "",
      invoiceFooter: "",
    }
  });

  useEffect(() => {
    if (org) {
      form.reset({
        name: org.name,
        currency: org.currency,
        timezone: org.timezone,
        gstNumber: org.gstNumber || "",
        addressLine1: org.addressLine1 || "",
        city: org.city || "",
        state: org.state || "",
        postalCode: org.postalCode || "",
        country: org.country || "India",
        logoUrl: org.logoUrl || "",
        invoiceFooter: org.invoiceFooter || "",
      });
    }
  }, [org, form]);

  const onSubmit = (data: OrgFormValues) => {
    updateMutation.mutate({
      data: {
        ...data,
        gstNumber: data.gstNumber || null,
        addressLine1: data.addressLine1 || null,
        city: data.city || null,
        state: data.state || null,
        postalCode: data.postalCode || null,
        country: data.country || null,
        logoUrl: data.logoUrl || null,
        invoiceFooter: data.invoiceFooter || null,
      }
    });
  };

  if (isLoading) return null;

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader 
        title="Settings" 
        description="Manage your organization profile and preferences."
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            Organization Profile
          </CardTitle>
          <CardDescription>
            These details appear on your invoices and purchase orders.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <div className="grid md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Organization Name *</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-org-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="gstNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>GST Number</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-org-gst" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="currency"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Base Currency</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-org-currency">
                            <SelectValue placeholder="Select currency" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="INR">Indian Rupee (₹)</SelectItem>
                          <SelectItem value="USD">US Dollar ($)</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormDescription>Your reporting currency.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="timezone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Timezone</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-org-timezone">
                            <SelectValue placeholder="Select timezone" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="Asia/Kolkata">India Standard Time (IST)</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="space-y-4 border-t pt-6 mt-6">
                <h3 className="text-sm font-medium">Headquarters Address</h3>
                
                <FormField
                  control={form.control}
                  name="addressLine1"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Street Address</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-org-address" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="city"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>City</FormLabel>
                        <FormControl>
                          <Input {...field} data-testid="input-org-city" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="state"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>State</FormLabel>
                        <FormControl>
                          <Input {...field} data-testid="input-org-state" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="postalCode"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>PIN Code</FormLabel>
                        <FormControl>
                          <Input {...field} data-testid="input-org-pin" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="country"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Country</FormLabel>
                        <FormControl>
                          <Input {...field} disabled data-testid="input-org-country" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              <div className="space-y-4 border-t pt-6 mt-6">
                <h3 className="text-sm font-medium">Invoice branding</h3>
                <FormField
                  control={form.control}
                  name="logoUrl"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Logo</FormLabel>
                      <FormControl>
                        <ImageUploader
                          value={field.value || null}
                          onChange={(next) => field.onChange(next ?? "")}
                          testId="org-logo"
                        />
                      </FormControl>
                      <FormDescription>
                        Shown at the top of every invoice, purchase order and delivery challan, plus your sidebar. PNG/JPEG, up to 2 MB recommended.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="invoiceFooter"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Invoice footer</FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          rows={3}
                          placeholder="Bank details, terms of payment, thank-you note..."
                          data-testid="input-org-invoice-footer"
                        />
                      </FormControl>
                      <FormDescription>
                        Appears at the bottom of every invoice PDF.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="flex justify-end pt-4">
                <Button 
                  type="submit" 
                  disabled={updateMutation.isPending}
                  data-testid="btn-save-settings"
                >
                  {updateMutation.isPending ? "Saving..." : "Save Settings"}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileCheck2 className="h-5 w-5 text-primary" />
            GST Compliance
          </CardTitle>
          <CardDescription>
            Connect the GST e-invoice (IRP) and e-way bill portals so
            invoices over the mandatory threshold are reported
            automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Link href="/integrations/einvoice">
            <a
              className="flex items-center justify-between rounded-md border p-3 hover-elevate active-elevate-2"
              data-testid="link-settings-einvoice"
            >
              <div>
                <div className="text-sm font-medium">E-invoice (IRP)</div>
                <div className="text-xs text-muted-foreground">
                  Auto-register IRN + signed QR when an order is invoiced.
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </a>
          </Link>
          <Link href="/integrations/ewb">
            <a
              className="flex items-center justify-between rounded-md border p-3 hover-elevate active-elevate-2"
              data-testid="link-settings-ewb"
            >
              <div>
                <div className="text-sm font-medium">E-way bill (NIC)</div>
                <div className="text-xs text-muted-foreground">
                  Generate EWB for shipments above the state threshold.
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </a>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
