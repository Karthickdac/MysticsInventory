import { SignUp } from "@clerk/react";
import { Boxes, Zap, ShieldCheck, FileCheck2, Truck } from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

const valueProps = [
  {
    icon: Zap,
    title: "Onboard in minutes",
    body: "Create your workspace, import your catalog and start invoicing.",
  },
  {
    icon: FileCheck2,
    title: "GST + e-invoice ready",
    body: "GSTR-1, IRP e-invoices and e-way bills generated for you.",
  },
  {
    icon: Truck,
    title: "Logistics on autopilot",
    body: "Shopify orders, Shiprocket shipments and barcode flows in one place.",
  },
  {
    icon: ShieldCheck,
    title: "Free for 14 days",
    body: "Try every feature on the trial — no card, no commitments.",
  },
];

export default function SignUpPage() {
  return (
    <div className="min-h-[100dvh] grid lg:grid-cols-2 bg-background">
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
            Start your 14-day free trial.
          </h1>
          <p className="mt-4 text-base text-white/85 leading-relaxed">
            Spin up a workspace, invite your team and run your full
            stock-to-cash cycle from a single, focused cockpit.
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

          <SignUp
            routing="path"
            path={`${basePath}/sign-up`}
            signInUrl={`${basePath}/sign-in`}
          />
        </div>
      </main>
    </div>
  );
}
