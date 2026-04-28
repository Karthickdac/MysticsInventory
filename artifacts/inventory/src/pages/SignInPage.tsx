import { SignIn } from "@clerk/react";
import { Boxes } from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

const stats = [
  { value: "₹50Cr+", label: "invoices generated" },
  { value: "1,200+", label: "workspaces" },
  { value: "99.95%", label: "uptime" },
];

export default function SignInPage() {
  return (
    <div className="min-h-[100dvh] grid lg:grid-cols-[1.05fr_1fr] bg-[#0d0a07]">
      {/* Left: editorial brand panel */}
      <aside className="relative hidden lg:flex flex-col justify-between overflow-hidden px-14 py-14 text-white">
        {/* Aurora mesh gradient */}
        <div
          aria-hidden
          className="absolute inset-0 bg-[radial-gradient(ellipse_120%_80%_at_20%_0%,#3a2818_0%,transparent_55%),radial-gradient(ellipse_80%_60%_at_85%_25%,#5e4220_0%,transparent_55%),radial-gradient(ellipse_100%_70%_at_30%_100%,#1a1410_0%,transparent_60%),linear-gradient(180deg,#0d0a07_0%,#0d0a07_100%)]"
        />
        {/* Fine grain noise overlay */}
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.07] mix-blend-overlay"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.5'/></svg>\")",
          }}
        />
        {/* Subtle highlight at the seam */}
        <div
          aria-hidden
          className="absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-white/20 to-transparent"
        />

        {/* Wordmark */}
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

        {/* Editorial headline + testimonial */}
        <div className="relative z-10 max-w-xl">
          <p className="text-[11px] uppercase tracking-[0.24em] text-white/55 mb-6">
            Inventory · GST · Logistics
          </p>
          <h1
            className="text-[56px] leading-[1.02] tracking-[-0.02em] font-normal text-white"
            style={{ fontFamily: "'Instrument Serif', Georgia, serif" }}
          >
            Run your stock-to-cash cycle with{" "}
            <span className="italic text-white/95">calm precision</span>.
          </h1>

          <div className="mt-12 max-w-md">
            <div className="relative rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-md px-6 py-5 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.6)]">
              <div
                aria-hidden
                className="absolute -top-3 left-6 text-5xl leading-none text-white/30 select-none"
                style={{ fontFamily: "'Instrument Serif', Georgia, serif" }}
              >
                “
              </div>
              <p className="text-[15px] leading-relaxed text-white/85">
                We replaced two legacy tools and a spreadsheet with Mystics
                in a weekend. GSTR‑1 filing went from a two-day chore to a
                ten-minute review.
              </p>
              <div className="mt-4 flex items-center gap-3">
                <div className="h-9 w-9 rounded-full bg-gradient-to-br from-amber-300 to-rose-400 ring-1 ring-white/20 flex items-center justify-center text-[12px] font-semibold text-[#0d0a07]">
                  RA
                </div>
                <div className="leading-tight">
                  <div className="text-[13px] font-medium text-white">
                    Rohan Agarwal
                  </div>
                  <div className="text-[12px] text-white/55">
                    Founder · Saanvi Textiles, Surat
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Stats footer */}
        <div className="relative z-10">
          <div className="grid grid-cols-3 gap-4 max-w-md">
            {stats.map((s) => (
              <div key={s.label}>
                <div
                  className="text-[26px] tracking-tight text-white"
                  style={{ fontFamily: "'Instrument Serif', Georgia, serif" }}
                >
                  {s.value}
                </div>
                <div className="text-[11px] uppercase tracking-[0.14em] text-white/45 mt-0.5">
                  {s.label}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-8 text-[11px] text-white/35">
            © {new Date().getFullYear()} Mystics Inventory · Made in India
          </div>
        </div>
      </aside>

      {/* Right: sign-in surface */}
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
            <div className="h-9 w-9 rounded-[10px] bg-gradient-to-br from-primary to-[hsl(38_70%_55%)] flex items-center justify-center shadow-sm">
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

          <SignIn
            routing="path"
            path={`${basePath}/sign-in`}
            signUpUrl={`${basePath}/sign-up`}
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
