import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "wouter";
import { SiShopify } from "react-icons/si";

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
      </div>
    </div>
  );
}
