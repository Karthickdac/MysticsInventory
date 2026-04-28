import { SignIn } from "@clerk/react";
import { Boxes, Zap, ShieldCheck, FileCheck2, Truck } from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

const valueProps = [
  {
    icon: Zap,
    title: "Built for speed",
    body: "Stock, sales and purchases in a focused cockpit — no bloat.",
  },
  {
    icon: ShieldCheck,
    title: "Multi-tenant by design",
    body: "Every workspace is isolated, encrypted at rest, audit-trailed.",
  },
  {
    icon: FileCheck2,
    title: "GST-ready out of the box",
    body: "GSTR-1, e-invoice (IRP) and e-way bills generated automatically.",
  },
  {
    icon: Truck,
    title: "Logistics integrations",
    body: "Shopify, Shiprocket and barcode-driven warehouse workflows.",
  },
];

export default function SignInPage() {
  return (
    <div className="min-h-[100dvh] grid lg:grid-cols-2 bg-background">
      {/* Left: brand + value props (hidden on small screens) */}
      <aside className="relative hidden lg:flex flex-col justify-between overflow-hidden bg-gradient-to-br from-primary via-primary to-[hsl(262_75%_42%)] text-primary-foreground px-12 py-12">
        <div
          aria-hidden
          className="absolute inset-0 opacity-30 [mask-image:radial-gradient(circle_at_30%_20%,black,transparent_70%)]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.35) 1px, transparent 0)",
            backgroundSize: "24px 24px",
          }}
        />
        <div className="relative z-10 flex items-center gap-2.5">
          <div className="h-9 w-9 rounded-lg bg-white/15 ring-1 ring-white/30 flex items-center justify-center backdrop-blur-sm">
            <Boxes className="h-5 w-5" strokeWidth={2.5} />
          </div>
          <div className="leading-tight">
            <div className="text-base font-semibold tracking-tight">
              Mystics
            </div>
            <div className="text-[10px] uppercase tracking-[0.18em] opacity-80">
              Inventory
            </div>
          </div>
        </div>

        <div className="relative z-10 max-w-md">
          <h1 className="text-4xl font-semibold tracking-tight leading-tight">
            Inventory management with calm precision.
          </h1>
          <p className="mt-4 text-base text-white/85 leading-relaxed">
            The focused cockpit Indian SMBs use to run stock, sales,
            purchases and GST — without the bloat of legacy ERPs.
          </p>

          <ul className="mt-10 space-y-5">
            {valueProps.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-3">
                <div className="mt-0.5 h-9 w-9 shrink-0 rounded-lg bg-white/15 ring-1 ring-white/25 flex items-center justify-center backdrop-blur-sm">
                  <Icon className="h-4.5 w-4.5" strokeWidth={2.25} />
                </div>
                <div>
                  <div className="text-sm font-semibold">{title}</div>
                  <div className="text-sm text-white/80 leading-snug">
                    {body}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative z-10 text-xs text-white/70">
          © {new Date().getFullYear()} Mystics Inventory · Made for ambitious
          Indian SMBs
        </div>
      </aside>

      {/* Right: sign-in form */}
      <main className="flex items-center justify-center px-4 py-12 sm:px-8 bg-muted/30">
        <div className="w-full max-w-md flex flex-col items-center">
          <div className="lg:hidden mb-6 flex items-center gap-2.5 text-foreground">
            <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-primary to-[hsl(262_75%_58%)] flex items-center justify-center shadow-sm">
              <Boxes
                className="h-5 w-5 text-primary-foreground"
                strokeWidth={2.5}
              />
            </div>
            <div className="leading-tight">
              <div className="text-base font-semibold tracking-tight">
                Mystics
              </div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                Inventory
              </div>
            </div>
          </div>

          <SignIn
            routing="path"
            path={`${basePath}/sign-in`}
            signUpUrl={`${basePath}/sign-up`}
          />
        </div>
      </main>
    </div>
  );
}
