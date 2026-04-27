import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Package, BarChart3, Users, Zap, Shield, Globe } from "lucide-react";

export default function Landing() {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

  return (
    <div className="min-h-screen bg-background flex flex-col selection:bg-primary/20">
      <header className="container mx-auto px-4 h-16 flex items-center justify-between border-b">
        <div className="flex items-center gap-2">
          <div className="bg-primary/10 p-1.5 rounded-lg">
            <Package className="h-6 w-6 text-primary" />
          </div>
          <span className="text-xl font-bold tracking-tight text-foreground">Mystics Inv</span>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/sign-in" className="text-sm font-medium hover:text-primary transition-colors">
            Log in
          </Link>
          <Link href="/sign-up" className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90">
            Start Free Trial
          </Link>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero Section */}
        <section className="container mx-auto px-4 py-24 md:py-32 flex flex-col items-center text-center">
          <div className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80 mb-8">
            Built for ambitious Indian SMBs
          </div>
          <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight max-w-3xl text-balance text-foreground mb-6">
            Inventory management with <span className="text-primary">calm precision.</span>
          </h1>
          <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mb-10 text-balance">
            Ditch the bloated ERPs. Mystics Inventory gives you total control over your stock, sales, and purchases in a blazing fast, focused cockpit.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 w-full sm:w-auto">
            <Link href="/sign-up" className="inline-flex h-12 items-center justify-center rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 w-full sm:w-auto">
              Get Started
            </Link>
            <Button variant="outline" size="lg" className="w-full sm:w-auto h-12">
              Book a Demo
            </Button>
          </div>
        </section>

        {/* Features Section */}
        <section className="bg-muted/50 py-24">
          <div className="container mx-auto px-4">
            <div className="text-center mb-16">
              <h2 className="text-3xl font-bold tracking-tight mb-4">Everything you need, nothing you don't.</h2>
              <p className="text-muted-foreground text-lg">Designed to stay out of your way so you can focus on growing your business.</p>
            </div>

            <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
              <div className="bg-card p-6 rounded-xl shadow-sm border">
                <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                  <Package className="h-5 w-5 text-primary" />
                </div>
                <h3 className="text-xl font-semibold mb-2">Real-time Stock</h3>
                <p className="text-muted-foreground">Track inventory across multiple warehouses instantly. Never oversell again.</p>
              </div>
              <div className="bg-card p-6 rounded-xl shadow-sm border">
                <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                  <BarChart3 className="h-5 w-5 text-primary" />
                </div>
                <h3 className="text-xl font-semibold mb-2">Actionable Reports</h3>
                <p className="text-muted-foreground">GST-ready valuation and low stock alerts. Make decisions based on data, not gut feeling.</p>
              </div>
              <div className="bg-card p-6 rounded-xl shadow-sm border">
                <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                  <Zap className="h-5 w-5 text-primary" />
                </div>
                <h3 className="text-xl font-semibold mb-2">Keyboard First</h3>
                <p className="text-muted-foreground">Navigate the entire app without lifting your hands off the keyboard. Built for speed.</p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t py-12 bg-card">
        <div className="container mx-auto px-4 flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-2">
            <Package className="h-5 w-5 text-primary" />
            <span className="font-semibold">Mystics Inventory</span>
          </div>
          <p className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} Mystics Technologies. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
