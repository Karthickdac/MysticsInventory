import { PageHeader } from "@/components/PageHeader";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "wouter";
import { SiShopify } from "react-icons/si";
import { FileText, Receipt, Truck } from "lucide-react";

export default function Integrations() {
  return (
    <div className="space-y-6 max-w-4xl">
      <PageHeader 
        title="Integrations" 
        description="Connect your inventory with external platforms."
      />

      <div className="grid gap-6 md:grid-cols-2">
        <Link href="/integrations/shopify" data-testid="link-integration-shopify">
          <Card className="hover:border-primary/50 transition-colors cursor-pointer border-2">
            <CardHeader className="flex flex-row items-center gap-4">
              <div className="bg-[#95bf47]/10 p-3 rounded-xl">
                <SiShopify className="h-8 w-8 text-[#95bf47]" />
              </div>
              <div>
                <CardTitle>Shopify</CardTitle>
                <CardDescription>Sync products and orders with your Shopify store.</CardDescription>
              </div>
            </CardHeader>
          </Card>
        </Link>

        <Link href="/integrations/shiprocket" data-testid="link-integration-shiprocket">
          <Card className="hover:border-primary/50 transition-colors cursor-pointer border-2">
            <CardHeader className="flex flex-row items-center gap-4">
              <div className="bg-blue-500/10 p-3 rounded-xl">
                <Truck className="h-8 w-8 text-blue-600" />
              </div>
              <div>
                <CardTitle>Shiprocket</CardTitle>
                <CardDescription>Book courier shipments and track AWBs end to end.</CardDescription>
              </div>
            </CardHeader>
          </Card>
        </Link>

        <Link href="/integrations/ewb" data-testid="link-integration-ewb">
          <Card className="hover:border-primary/50 transition-colors cursor-pointer border-2">
            <CardHeader className="flex flex-row items-center gap-4">
              <div className="bg-amber-500/10 p-3 rounded-xl">
                <FileText className="h-8 w-8 text-amber-600" />
              </div>
              <div>
                <CardTitle>E-way Bill (NIC)</CardTitle>
                <CardDescription>Generate, update and cancel e-way bills directly from sales orders.</CardDescription>
              </div>
            </CardHeader>
          </Card>
        </Link>

        <Link href="/integrations/einvoice" data-testid="link-integration-einvoice">
          <Card className="hover:border-primary/50 transition-colors cursor-pointer border-2">
            <CardHeader className="flex flex-row items-center gap-4">
              <div className="bg-emerald-500/10 p-3 rounded-xl">
                <Receipt className="h-8 w-8 text-emerald-600" />
              </div>
              <div>
                <CardTitle>E-invoice (IRP / GSP)</CardTitle>
                <CardDescription>Auto-register B2B invoices with the IRP and embed the signed QR on PDFs.</CardDescription>
              </div>
            </CardHeader>
          </Card>
        </Link>
      </div>
    </div>
  );
}
