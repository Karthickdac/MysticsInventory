import { SignUp } from "@clerk/react";
import { Boxes, Check } from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

const trialPerks = [
  "Unlimited items, orders & invoices",
  "GSTR-1, e-invoice (IRP) & e-way bills",
  "Shopify + Shiprocket integrations",
  "No card required for 14 days",
];

export default function SignUpPage() {
  return (
    <div className="min-h-[100dvh] grid lg:grid-cols-[1.05fr_1fr] bg-[#0a0a0f]">
      <aside className="relative hidden lg:flex flex-col justify-between overflow-hidden px-14 py-14 text-white">
        <div
          aria-hidden
          className="absolute inset-0 bg-[radial-gradient(ellipse_120%_80%_at_20%_0%,#3b1f6b_0%,transparent_55%),radial-gradient(ellipse_80%_60%_at_85%_25%,#5b2eb8_0%,transparent_55%),radial-gradient(ellipse_100%_70%_at_30%_100%,#1e103f_0%,transparent_60%),linear-gradient(180deg,#0a0a0f_0%,#0a0a0f_100%)]"
        />
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.07] mix-blend-overlay"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.5'/></svg>\")",
          }}
        />
        <div
          aria-hidden
          className="absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-white/20 to-transparent"
        />

        <div className="relative z-10 flex items-center gap-2.5">
          <div className="h-9 w-9 rounded-[10px] bg-white/10 ring-1 ring-white/15 backdrop-blur-sm flex items-center justify-center">
            <Boxes className="h-[18px] w-[18px]" strokeWidth={2.25} />
          </div>
          <div className="leading-tight">
            <div className="text-[15px] font-semibold tracking-tight">
              Mystics
            </div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-white/50">
              Inventory
            </div>
          </div>
        </div>

        <div className="relative z-10 max-w-xl">
          <p className="text-[11px] uppercase tracking-[0.24em] text-white/55 mb-6">
            Start free · 14-day trial
          </p>
          <h1
            className="text-[56px] leading-[1.02] tracking-[-0.02em] font-normal text-white"
            style={{ fontFamily: "'Instrument Serif', Georgia, serif" }}
          >
            A workspace for the way{" "}
            <span className="italic text-white/95">modern Indian SMBs</span>{" "}
            actually run.
          </h1>

          <ul className="mt-12 space-y-3.5 max-w-md">
            {trialPerks.map((perk) => (
              <li key={perk} className="flex items-start gap-3">
                <span className="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-white/10 ring-1 ring-white/15 flex items-center justify-center">
                  <Check className="h-3 w-3 text-white" strokeWidth={3} />
                </span>
                <span className="text-[15px] text-white/85 leading-snug">
                  {perk}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative z-10">
          <div className="flex items-center gap-3 max-w-md rounded-xl border border-white/10 bg-white/[0.04] backdrop-blur-md px-4 py-3">
            <div className="flex -space-x-2">
              {[
                "from-amber-300 to-rose-400",
                "from-cyan-300 to-blue-500",
                "from-emerald-300 to-teal-500",
              ].map((cls, i) => (
                <div
                  key={i}
                  className={`h-7 w-7 rounded-full bg-gradient-to-br ${cls} ring-2 ring-[#0a0a0f]`}
                />
              ))}
            </div>
            <div className="text-[12px] text-white/70 leading-snug">
              Joined by{" "}
              <span className="text-white font-medium">42 founders</span>{" "}
              this week
            </div>
          </div>
          <div className="mt-6 text-[11px] text-white/35">
            © {new Date().getFullYear()} Mystics Inventory · Made in India
          </div>
        </div>
      </aside>

      <main className="relative flex items-center justify-center px-4 py-12 sm:px-8 bg-background">
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.4] dark:opacity-[0.6] pointer-events-none"
          style={{
            backgroundImage:
              "radial-gradient(circle 600px at 50% 0%, hsl(var(--primary) / 0.08), transparent 70%)",
          }}
        />
        <div className="relative w-full max-w-md flex flex-col items-center">
          <div className="lg:hidden mb-8 flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-[10px] bg-gradient-to-br from-primary to-[hsl(262_75%_58%)] flex items-center justify-center shadow-sm">
              <Boxes
                className="h-[18px] w-[18px] text-primary-foreground"
                strokeWidth={2.25}
              />
            </div>
            <div className="leading-tight">
              <div className="text-[15px] font-semibold tracking-tight text-foreground">
                Mystics
              </div>
              <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                Inventory
              </div>
            </div>
          </div>

          <SignUp
            routing="path"
            path={`${basePath}/sign-up`}
            signInUrl={`${basePath}/sign-in`}
          />

          <p className="mt-6 text-center text-[11px] text-muted-foreground/70 max-w-xs">
            Protected by Clerk · By continuing you agree to our terms of
            service and privacy policy.
          </p>
        </div>
      </main>
    </div>
  );
}
