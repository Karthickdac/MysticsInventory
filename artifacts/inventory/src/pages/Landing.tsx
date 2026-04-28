import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Boxes,
  ArrowRight,
  ArrowUpRight,
  Check,
  ScanBarcode,
  Receipt,
  Truck,
  ShoppingBag,
  Sparkles,
  ShieldCheck,
  Zap,
  ChartLine,
  Search,
  Bell,
  TrendingUp,
  TrendingDown,
} from "lucide-react";

const SERIF = "'Instrument Serif', Georgia, serif";

const features = [
  {
    icon: Boxes,
    title: "Multi-warehouse stock",
    body: "One source of truth across godowns, retail floors and consignment partners. Real-time updates, never oversell.",
  },
  {
    icon: Receipt,
    title: "GST that just works",
    body: "GSTR-1 reconciliation, IRP e-invoices and signed e-way bills generated automatically with the right HSN and place-of-supply.",
  },
  {
    icon: ShoppingBag,
    title: "Shopify in 2 clicks",
    body: "Two-way sync of products, inventory and orders. Stock levels stay accurate even on a flash sale.",
  },
  {
    icon: Truck,
    title: "Shiprocket built-in",
    body: "Print labels, push manifests and track shipments without leaving the order. Returns flow back into stock automatically.",
  },
  {
    icon: ScanBarcode,
    title: "Barcode-first warehouse",
    body: "Receive purchase orders, pick sales orders and run cycle counts on a phone. No fragile USB scanners required.",
  },
  {
    icon: Zap,
    title: "Keyboard-native cockpit",
    body: "Cmd-K everywhere, sub-200ms page loads, and a dense, calm interface that respects how operators actually work.",
  },
];

const stats = [
  { value: "₹50Cr+", label: "Invoices generated" },
  { value: "1,200+", label: "Active workspaces" },
  { value: "99.95%", label: "Uptime over 12 months" },
  { value: "<200ms", label: "Median page load" },
];

const testimonials = [
  {
    quote:
      "We replaced two legacy tools and a spreadsheet with Mystics in a weekend. GSTR-1 filing went from a two-day chore to a ten-minute review.",
    name: "Rohan Agarwal",
    role: "Founder · Saanvi Textiles, Surat",
    initials: "RA",
    grad: "from-amber-300 to-rose-400",
  },
  {
    quote:
      "The barcode flow on a phone is genuinely faster than our old scanner. Receiving a 200-line PO now takes one person, not three.",
    name: "Priya Menon",
    role: "Ops Lead · Coral & Co. Jewellery",
    initials: "PM",
    grad: "from-emerald-300 to-teal-500",
  },
  {
    quote:
      "We sell on three Shopify storefronts and a B2B portal. Nothing else gave us one inventory truth without a developer in the loop.",
    name: "Aman Khurana",
    role: "Co-founder · Nordsk Apparel",
    initials: "AK",
    grad: "from-cyan-300 to-blue-500",
  },
];

function BrandMark({ tone = "light" }: { tone?: "light" | "dark" }) {
  return (
    <Link
      href="/"
      className="flex items-center gap-2.5 group"
      data-testid="link-brand"
    >
      <div
        className={
          tone === "light"
            ? "h-9 w-9 rounded-[10px] bg-gradient-to-br from-primary to-[hsl(262_75%_58%)] flex items-center justify-center shadow-sm ring-1 ring-primary/20"
            : "h-9 w-9 rounded-[10px] bg-white/10 ring-1 ring-white/15 backdrop-blur-sm flex items-center justify-center"
        }
      >
        <Boxes
          className={
            tone === "light"
              ? "h-[18px] w-[18px] text-primary-foreground"
              : "h-[18px] w-[18px] text-white"
          }
          strokeWidth={2.25}
        />
      </div>
      <div className="leading-tight">
        <div
          className={
            tone === "light"
              ? "text-[15px] font-semibold tracking-tight text-foreground"
              : "text-[15px] font-semibold tracking-tight text-white"
          }
        >
          Mystics
        </div>
        <div
          className={
            tone === "light"
              ? "text-[10px] uppercase tracking-[0.22em] text-muted-foreground"
              : "text-[10px] uppercase tracking-[0.22em] text-white/55"
          }
        >
          Inventory
        </div>
      </div>
    </Link>
  );
}

function AuroraBg() {
  return (
    <>
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(ellipse_120%_80%_at_15%_-10%,#3b1f6b_0%,transparent_55%),radial-gradient(ellipse_80%_60%_at_85%_15%,#5b2eb8_0%,transparent_55%),radial-gradient(ellipse_100%_70%_at_50%_100%,#1e103f_0%,transparent_60%),linear-gradient(180deg,#0a0a0f_0%,#0a0a0f_100%)] pointer-events-none"
      />
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.07] mix-blend-overlay pointer-events-none"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.5'/></svg>\")",
        }}
      />
    </>
  );
}

function DashboardPreview() {
  return (
    <div className="relative mx-auto w-full max-w-5xl">
      {/* Glow */}
      <div
        aria-hidden
        className="absolute -inset-x-10 -top-10 -bottom-10 -z-10 bg-[radial-gradient(ellipse_80%_60%_at_50%_30%,rgba(155,93,255,0.35),transparent_70%)] blur-2xl"
      />
      <div className="rounded-2xl border border-white/10 bg-[#0d0d14]/90 backdrop-blur-xl shadow-[0_60px_120px_-40px_rgba(0,0,0,0.6)] overflow-hidden">
        {/* Window chrome */}
        <div className="flex items-center gap-2 px-4 h-9 border-b border-white/5 bg-white/[0.02]">
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <div className="ml-3 flex items-center gap-1.5 text-[11px] text-white/40">
            <span className="font-mono">app.mystics.in</span>
            <span className="text-white/25">/dashboard</span>
          </div>
          <div className="ml-auto flex items-center gap-2 text-white/40">
            <Search className="h-3.5 w-3.5" />
            <Bell className="h-3.5 w-3.5" />
          </div>
        </div>

        {/* Body */}
        <div className="grid grid-cols-[180px_1fr] min-h-[420px]">
          {/* Sidebar mock */}
          <div className="border-r border-white/5 bg-white/[0.02] p-3 space-y-1.5">
            <div className="px-3 py-1 text-[9px] uppercase tracking-[0.16em] text-white/30">
              Overview
            </div>
            <div className="flex items-center gap-2.5 px-3 py-2 rounded-md bg-white/[0.06] text-white text-[12px] font-medium">
              <ChartLine className="h-3.5 w-3.5 text-[hsl(262_75%_70%)]" />
              Dashboard
            </div>
            <div className="px-3 py-1 mt-3 text-[9px] uppercase tracking-[0.16em] text-white/30">
              Inventory
            </div>
            {[
              { icon: Boxes, label: "Items" },
              { icon: ScanBarcode, label: "Stock movements" },
              { icon: ShoppingBag, label: "Sales orders" },
              { icon: Receipt, label: "Invoices" },
              { icon: Truck, label: "Shipments" },
            ].map((it) => (
              <div
                key={it.label}
                className="flex items-center gap-2.5 px-3 py-1.5 rounded-md text-white/55 text-[12px]"
              >
                <it.icon className="h-3.5 w-3.5" />
                {it.label}
              </div>
            ))}
          </div>

          {/* Main content mock */}
          <div className="p-6">
            <div className="flex items-end justify-between mb-5">
              <div>
                <div className="text-[11px] text-white/40 uppercase tracking-[0.16em]">
                  This month
                </div>
                <div
                  className="text-2xl text-white"
                  style={{ fontFamily: SERIF }}
                >
                  Stock-to-cash overview
                </div>
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-white/50">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                Live
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3 mb-5">
              {[
                {
                  label: "Sales",
                  value: "₹38.2L",
                  delta: "+18.4%",
                  up: true,
                },
                {
                  label: "Orders",
                  value: "1,284",
                  delta: "+12.1%",
                  up: true,
                },
                {
                  label: "Stockouts",
                  value: "7",
                  delta: "-3",
                  up: false,
                  good: true,
                },
              ].map((kpi) => (
                <div
                  key={kpi.label}
                  className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3"
                >
                  <div className="text-[10px] uppercase tracking-[0.14em] text-white/40">
                    {kpi.label}
                  </div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <div className="text-xl font-semibold text-white tracking-tight">
                      {kpi.value}
                    </div>
                    <div
                      className={`flex items-center gap-0.5 text-[11px] ${
                        kpi.up || kpi.good
                          ? "text-emerald-400"
                          : "text-rose-400"
                      }`}
                    >
                      {kpi.up ? (
                        <TrendingUp className="h-3 w-3" />
                      ) : (
                        <TrendingDown className="h-3 w-3" />
                      )}
                      {kpi.delta}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Sparkline-ish chart mock */}
            <div className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-4 mb-4">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[12px] text-white/70 font-medium">
                  Daily revenue
                </div>
                <div className="text-[10px] text-white/40">
                  Last 30 days
                </div>
              </div>
              <svg viewBox="0 0 400 80" className="w-full h-16">
                <defs>
                  <linearGradient id="g" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0" stopColor="rgb(155,93,255)" stopOpacity="0.55" />
                    <stop offset="1" stopColor="rgb(155,93,255)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path
                  d="M0,60 L20,55 L40,58 L60,46 L80,50 L100,40 L120,42 L140,32 L160,36 L180,28 L200,30 L220,22 L240,28 L260,18 L280,24 L300,14 L320,18 L340,10 L360,16 L380,8 L400,12 L400,80 L0,80 Z"
                  fill="url(#g)"
                />
                <path
                  d="M0,60 L20,55 L40,58 L60,46 L80,50 L100,40 L120,42 L140,32 L160,36 L180,28 L200,30 L220,22 L240,28 L260,18 L280,24 L300,14 L320,18 L340,10 L360,16 L380,8 L400,12"
                  stroke="rgb(155,93,255)"
                  strokeWidth="1.5"
                  fill="none"
                />
              </svg>
            </div>

            {/* Recent rows */}
            <div className="rounded-xl border border-white/5 bg-white/[0.02]">
              <div className="px-4 py-2.5 text-[12px] text-white/70 font-medium border-b border-white/5">
                Recent invoices
              </div>
              {[
                { id: "INV-2042", customer: "Anand Mehta", amt: "₹84,200", st: "Paid" },
                { id: "INV-2041", customer: "Vyom Industries", amt: "₹1,12,400", st: "Sent" },
                { id: "INV-2040", customer: "Surya Hardware", amt: "₹38,750", st: "Paid" },
              ].map((r) => (
                <div
                  key={r.id}
                  className="flex items-center px-4 py-2.5 text-[12px] text-white/70 border-b border-white/5 last:border-0"
                >
                  <span className="font-mono text-white/55 w-24">{r.id}</span>
                  <span className="flex-1">{r.customer}</span>
                  <span className="font-semibold text-white tabular-nums w-24 text-right">
                    {r.amt}
                  </span>
                  <span
                    className={`ml-3 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      r.st === "Paid"
                        ? "bg-emerald-400/10 text-emerald-300"
                        : "bg-amber-400/10 text-amber-300"
                    }`}
                  >
                    {r.st}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Landing() {
  return (
    <div className="min-h-screen bg-background flex flex-col selection:bg-primary/20">
      {/* Hero panel (dark) */}
      <section className="relative overflow-hidden text-white">
        <AuroraBg />
        {/* Header */}
        <header className="relative z-10">
          <div className="mx-auto max-w-7xl px-6 lg:px-10 h-18 flex items-center justify-between py-5">
            <BrandMark tone="dark" />
            <nav className="hidden md:flex items-center gap-8 text-[13px] text-white/70">
              <a href="#features" className="hover:text-white transition-colors">
                Product
              </a>
              <a href="#gst" className="hover:text-white transition-colors">
                GST &amp; compliance
              </a>
              <a
                href="#customers"
                className="hover:text-white transition-colors"
              >
                Customers
              </a>
              <a href="#pricing" className="hover:text-white transition-colors">
                Pricing
              </a>
            </nav>
            <div className="flex items-center gap-3">
              <Link
                href="/sign-in"
                className="text-[13px] text-white/80 hover:text-white transition-colors"
                data-testid="link-signin"
              >
                Sign in
              </Link>
              <Link
                href="/sign-up"
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-white text-[#0a0a0f] px-3.5 text-[13px] font-semibold shadow-sm hover:bg-white/90 transition-colors"
                data-testid="link-cta-header"
              >
                Start free
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>
        </header>

        {/* Hero */}
        <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-10 pt-12 pb-24 lg:pt-20 lg:pb-32 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] backdrop-blur-md px-3 py-1 text-[11px] text-white/80">
            <Sparkles className="h-3 w-3 text-[hsl(262_75%_75%)]" />
            <span>New: e-invoice (IRP) and e-way bills, automated</span>
          </div>

          <h1
            className="mt-6 text-5xl md:text-7xl lg:text-[88px] leading-[0.98] tracking-[-0.022em] text-white max-w-5xl mx-auto"
            style={{ fontFamily: SERIF }}
          >
            Inventory management with{" "}
            <span className="italic text-white/95">calm precision</span>.
          </h1>

          <p className="mt-7 max-w-2xl mx-auto text-base md:text-lg text-white/70 leading-relaxed">
            The focused cockpit Indian SMBs use to run stock, sales,
            purchases and GST — without the bloat of legacy ERPs. Built for
            operators, not consultants.
          </p>

          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              href="/sign-up"
              className="inline-flex h-12 items-center gap-2 rounded-md bg-white text-[#0a0a0f] px-6 text-sm font-semibold shadow-[0_10px_30px_-10px_rgba(255,255,255,0.4)] hover:bg-white/90 transition-colors"
              data-testid="link-cta-primary"
            >
              Start your free 14-day trial
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Button
              variant="ghost"
              size="lg"
              className="h-12 text-white/85 hover:text-white hover:bg-white/10 px-5"
              data-testid="btn-book-demo"
            >
              Book a demo
              <ArrowUpRight className="ml-1.5 h-4 w-4" />
            </Button>
          </div>

          <p className="mt-4 text-[12px] text-white/45">
            No credit card required · Cancel anytime · Made in India
          </p>
        </div>

        {/* Product preview */}
        <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-10 pb-20 lg:pb-28">
          <DashboardPreview />
        </div>
      </section>

      {/* Trust bar */}
      <section className="border-y border-border/60 bg-muted/30 py-10">
        <div className="mx-auto max-w-7xl px-6 lg:px-10">
          <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground text-center mb-7">
            Trusted by 1,200+ Indian businesses, from D2C brands to
            multi-godown distributors
          </p>
          <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4 text-[15px] font-semibold tracking-tight text-muted-foreground/70">
            <span style={{ fontFamily: SERIF }}>Saanvi&nbsp;Textiles</span>
            <span className="font-mono">CORAL&amp;CO.</span>
            <span style={{ fontFamily: SERIF }} className="italic">
              Nordsk
            </span>
            <span className="uppercase tracking-[0.22em] text-[12px]">
              Surya · Hardware
            </span>
            <span style={{ fontFamily: SERIF }}>Vyom Industries</span>
            <span className="font-mono">RIDGEWELL</span>
            <span style={{ fontFamily: SERIF }} className="italic">
              Anand &amp; Co.
            </span>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-24 lg:py-32">
        <div className="mx-auto max-w-7xl px-6 lg:px-10">
          <div className="max-w-3xl">
            <p className="text-[11px] uppercase tracking-[0.22em] text-primary mb-4">
              Everything in one cockpit
            </p>
            <h2
              className="text-4xl md:text-5xl tracking-[-0.02em] text-foreground"
              style={{ fontFamily: SERIF }}
            >
              The focused workspace your{" "}
              <span className="italic">ops team</span> has been waiting for.
            </h2>
            <p className="mt-5 text-muted-foreground text-lg leading-relaxed max-w-2xl">
              Stock, sales, purchases, GST and logistics — designed to feel
              like one product, not seven bolted together.
            </p>
          </div>

          <div className="mt-16 grid sm:grid-cols-2 lg:grid-cols-3 gap-px bg-border rounded-2xl overflow-hidden border">
            {features.map((f) => (
              <div
                key={f.title}
                className="bg-card p-7 hover:bg-accent/40 transition-colors group"
              >
                <div className="h-10 w-10 rounded-lg bg-primary/10 ring-1 ring-primary/15 flex items-center justify-center mb-5 group-hover:bg-primary/15 transition-colors">
                  <f.icon className="h-5 w-5 text-primary" strokeWidth={2} />
                </div>
                <h3 className="text-[17px] font-semibold tracking-tight text-foreground">
                  {f.title}
                </h3>
                <p className="mt-2 text-[14px] text-muted-foreground leading-relaxed">
                  {f.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* GST compliance highlight */}
      <section
        id="gst"
        className="relative py-24 lg:py-32 bg-gradient-to-b from-muted/40 to-background"
      >
        <div className="mx-auto max-w-7xl px-6 lg:px-10 grid lg:grid-cols-[1.1fr_1fr] gap-12 lg:gap-20 items-center">
          <div>
            <p className="text-[11px] uppercase tracking-[0.22em] text-primary mb-4">
              GST &amp; compliance
            </p>
            <h2
              className="text-4xl md:text-5xl tracking-[-0.02em] text-foreground"
              style={{ fontFamily: SERIF }}
            >
              Compliance that{" "}
              <span className="italic">disappears into the workflow</span>.
            </h2>
            <p className="mt-5 text-muted-foreground text-lg leading-relaxed">
              We were built in India, for Indian rules. GSTR-1, IRP
              e-invoices, signed e-way bills, HSN-aware tax tables and
              place-of-supply logic are part of the core — not a paid add-on.
            </p>
            <ul className="mt-8 space-y-3">
              {[
                "Auto-generate IRN + signed QR the moment an order is invoiced",
                "One-click GSTR-1 reconciliation against the GSTN portal",
                "E-way bills with Part-A and Part-B, plus 10-day extension flow",
                "Audit-trail every change, every user — for every workspace",
              ].map((line) => (
                <li
                  key={line}
                  className="flex items-start gap-3 text-[15px] text-foreground"
                >
                  <span className="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-primary/10 ring-1 ring-primary/20 flex items-center justify-center">
                    <Check className="h-3 w-3 text-primary" strokeWidth={3} />
                  </span>
                  <span className="leading-snug">{line}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* GST mock card */}
          <div className="relative">
            <div
              aria-hidden
              className="absolute -inset-6 -z-10 bg-[radial-gradient(ellipse_70%_60%_at_50%_50%,hsl(var(--primary)/0.12),transparent_70%)] blur-2xl"
            />
            <div className="rounded-2xl border bg-card shadow-[0_30px_80px_-30px_rgba(0,0,0,0.18)] overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 border-b bg-muted/30">
                <div className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                  <ShieldCheck className="h-4 w-4 text-primary" />
                  E-invoice (IRP)
                </div>
                <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[11px] font-semibold">
                  Active
                </span>
              </div>
              <div className="p-5 space-y-4 text-[13px]">
                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                      IRN
                    </div>
                    <div className="font-mono text-foreground mt-1 truncate">
                      8a4f7c9b3e1d…2941
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                      Ack #
                    </div>
                    <div className="font-mono text-foreground mt-1">
                      112120410001234
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                      Ack date
                    </div>
                    <div className="text-foreground mt-1">
                      28 Apr 2026, 10:42
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                      Invoice value
                    </div>
                    <div className="text-foreground mt-1 font-semibold">
                      ₹84,200
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-4 pt-3 border-t">
                  {/* Faux QR */}
                  <div className="h-20 w-20 shrink-0 rounded-md bg-foreground p-1.5">
                    <div className="grid grid-cols-7 gap-px h-full">
                      {Array.from({ length: 49 }).map((_, i) => (
                        <div
                          key={i}
                          className={`rounded-[1px] ${
                            [0,1,5,7,8,12,14,15,19,21,22,28,30,32,33,40,42,46,47,48].includes(i)
                              ? "bg-background"
                              : ""
                          }`}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="text-[12px] text-muted-foreground leading-snug">
                    Signed by GSTN. The QR encodes seller GSTIN, invoice
                    number, IRN and the digital signature — verifiable
                    offline.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Stats */}
      <section className="relative py-20 border-y bg-muted/30">
        <div className="mx-auto max-w-7xl px-6 lg:px-10 grid grid-cols-2 lg:grid-cols-4 gap-y-10 gap-x-8">
          {stats.map((s) => (
            <div key={s.label} className="text-center lg:text-left">
              <div
                className="text-4xl md:text-5xl text-foreground tracking-tight"
                style={{ fontFamily: SERIF }}
              >
                {s.value}
              </div>
              <div className="mt-2 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Testimonials */}
      <section id="customers" className="py-24 lg:py-32">
        <div className="mx-auto max-w-7xl px-6 lg:px-10">
          <div className="max-w-3xl mb-14">
            <p className="text-[11px] uppercase tracking-[0.22em] text-primary mb-4">
              From the people who run it
            </p>
            <h2
              className="text-4xl md:text-5xl tracking-[-0.02em] text-foreground"
              style={{ fontFamily: SERIF }}
            >
              Stories from operators who switched.
            </h2>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            {testimonials.map((t) => (
              <figure
                key={t.name}
                className="relative rounded-2xl border bg-card p-7 shadow-[0_20px_50px_-30px_rgba(0,0,0,0.15)]"
              >
                <span
                  aria-hidden
                  className="absolute -top-3 left-6 text-5xl leading-none text-primary/30 select-none"
                  style={{ fontFamily: SERIF }}
                >
                  “
                </span>
                <blockquote className="text-[15px] leading-relaxed text-foreground">
                  {t.quote}
                </blockquote>
                <figcaption className="mt-6 flex items-center gap-3 pt-5 border-t">
                  <div
                    className={`h-9 w-9 rounded-full bg-gradient-to-br ${t.grad} ring-1 ring-foreground/10 flex items-center justify-center text-[12px] font-semibold text-[#0a0a0f]`}
                  >
                    {t.initials}
                  </div>
                  <div className="leading-tight">
                    <div className="text-[13px] font-medium text-foreground">
                      {t.name}
                    </div>
                    <div className="text-[12px] text-muted-foreground">
                      {t.role}
                    </div>
                  </div>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section id="pricing" className="px-6 lg:px-10 pb-24">
        <div className="relative mx-auto max-w-7xl rounded-3xl overflow-hidden border border-white/10">
          <AuroraBg />
          <div className="relative z-10 px-8 py-20 lg:px-16 lg:py-24 text-center text-white">
            <p className="text-[11px] uppercase tracking-[0.22em] text-white/55 mb-5">
              Ready when you are
            </p>
            <h2
              className="text-4xl md:text-6xl tracking-[-0.02em] max-w-3xl mx-auto leading-[1.02]"
              style={{ fontFamily: SERIF }}
            >
              Run a calmer, faster, more{" "}
              <span className="italic">accountable</span> business.
            </h2>
            <p className="mt-6 max-w-xl mx-auto text-white/70 text-base md:text-lg leading-relaxed">
              Spin up a workspace in two minutes. Invite your team. Move
              your first PO in under an hour. No credit card needed.
            </p>
            <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
              <Link
                href="/sign-up"
                className="inline-flex h-12 items-center gap-2 rounded-md bg-white text-[#0a0a0f] px-6 text-sm font-semibold shadow-[0_10px_30px_-10px_rgba(255,255,255,0.4)] hover:bg-white/90 transition-colors"
                data-testid="link-cta-final"
              >
                Start your free 14-day trial
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/sign-in"
                className="inline-flex h-12 items-center gap-1.5 rounded-md text-white/85 hover:text-white px-5 text-sm font-medium hover:bg-white/10 transition-colors"
              >
                Sign in to your workspace
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t bg-card/50">
        <div className="mx-auto max-w-7xl px-6 lg:px-10 py-12 flex flex-col md:flex-row justify-between items-center gap-5">
          <BrandMark tone="light" />
          <div className="flex items-center gap-6 text-[12px] text-muted-foreground">
            <a href="#" className="hover:text-foreground transition-colors">
              Terms
            </a>
            <a href="#" className="hover:text-foreground transition-colors">
              Privacy
            </a>
            <a href="#" className="hover:text-foreground transition-colors">
              Security
            </a>
            <a href="#" className="hover:text-foreground transition-colors">
              Contact
            </a>
          </div>
          <p className="text-[12px] text-muted-foreground">
            © {new Date().getFullYear()} Mystics Technologies · Made in India
          </p>
        </div>
      </footer>
    </div>
  );
}
