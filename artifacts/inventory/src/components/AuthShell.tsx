import { type ReactNode } from "react";
import { Boxes } from "lucide-react";

const stats = [
  { value: "₹50Cr+", label: "invoices generated" },
  { value: "1,200+", label: "workspaces" },
  { value: "99.95%", label: "uptime" },
];

/**
 * Shared two-pane layout for sign-in / sign-up / forgot / reset /
 * verify-email pages. The left pane is a fixed editorial brand panel;
 * the right pane is whatever form `children` renders.
 */
export function AuthShell({
  children,
  rightFooter,
}: {
  children: ReactNode;
  rightFooter?: ReactNode;
}) {
  return (
    <div className="min-h-[100dvh] grid lg:grid-cols-[1.05fr_1fr] bg-[#0d0a07]">
      <aside className="relative hidden lg:flex flex-col justify-between overflow-hidden px-14 py-14 text-white">
        <div
          aria-hidden
          className="absolute inset-0 bg-[radial-gradient(ellipse_120%_80%_at_20%_0%,#3a2818_0%,transparent_55%),radial-gradient(ellipse_80%_60%_at_85%_25%,#5e4220_0%,transparent_55%),radial-gradient(ellipse_100%_70%_at_30%_100%,#1a1410_0%,transparent_60%),linear-gradient(180deg,#0d0a07_0%,#0d0a07_100%)]"
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
            <div className="text-[15px] font-semibold tracking-tight">Mystics</div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-white/50">
              Inventory
            </div>
          </div>
        </div>
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
        </div>
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
      <main className="relative flex items-center justify-center px-4 py-12 sm:px-8 bg-background">
        <div className="relative w-full max-w-md flex flex-col">
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
          {children}
          {rightFooter}
        </div>
      </main>
    </div>
  );
}
