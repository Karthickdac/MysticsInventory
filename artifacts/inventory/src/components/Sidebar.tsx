import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Package,
  Users,
  Truck,
  Warehouse,
  ArrowLeftRight,
  ShoppingCart,
  ShoppingBag,
  IndianRupee,
  BarChart3,
  Blocks,
  Settings,
  UserCog,
  Boxes,
  CreditCard,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useGetCurrentOrganization } from "@/lib/queryKeys";
import { Skeleton } from "@/components/ui/skeleton";
import type { LucideIcon } from "lucide-react";

interface SidebarProps {
  className?: string;
  onNavigate?: () => void;
}

interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

const navSections: NavSection[] = [
  {
    label: "Overview",
    items: [{ name: "Dashboard", href: "/dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Inventory",
    items: [
      { name: "Items", href: "/items", icon: Package },
      { name: "Stock Movements", href: "/stock", icon: ArrowLeftRight },
      { name: "Warehouses", href: "/warehouses", icon: Warehouse },
    ],
  },
  {
    label: "Sales",
    items: [
      { name: "Sales Orders", href: "/sales-orders", icon: ShoppingCart },
      { name: "Payments", href: "/payments", icon: IndianRupee },
      { name: "Customers", href: "/customers", icon: Users },
    ],
  },
  {
    label: "Purchasing",
    items: [
      { name: "Purchase Orders", href: "/purchase-orders", icon: ShoppingBag },
      { name: "Suppliers", href: "/suppliers", icon: Truck },
    ],
  },
  {
    label: "Insights",
    items: [{ name: "Reports", href: "/reports", icon: BarChart3 }],
  },
  {
    label: "Workspace",
    items: [
      { name: "Team", href: "/team", icon: UserCog },
      { name: "Integrations", href: "/integrations", icon: Blocks },
      { name: "Billing", href: "/billing", icon: CreditCard },
      { name: "Settings", href: "/settings", icon: Settings },
    ],
  },
];

function isActivePath(location: string, href: string): boolean {
  if (href === "/dashboard") return location === "/dashboard";
  return location === href || location.startsWith(href + "/");
}

export function Sidebar({ className, onNavigate }: SidebarProps) {
  const [location] = useLocation();
  const { data: org, isLoading: orgLoading } = useGetCurrentOrganization();

  return (
    <div
      className={cn(
        "flex h-full flex-col bg-sidebar border-r border-sidebar-border",
        className,
      )}
    >
      {/* Brand */}
      <div className="flex h-16 items-center border-b border-sidebar-border px-5 shrink-0">
        <Link
          href="/dashboard"
          onClick={onNavigate}
          className="flex items-center gap-2.5 group"
          data-testid="link-logo"
        >
          <div className="relative h-8 w-8 rounded-lg bg-gradient-to-br from-primary to-[hsl(262_75%_58%)] flex items-center justify-center shadow-sm ring-1 ring-primary/20">
            <Boxes className="h-4 w-4 text-primary-foreground" strokeWidth={2.5} />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-[15px] font-semibold tracking-tight text-sidebar-foreground">
              Mystics
            </span>
            <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-medium">
              Inventory
            </span>
          </div>
        </Link>
      </div>

      {/* Nav sections */}
      <ScrollArea className="flex-1">
        <nav className="px-3 py-4 space-y-5">
          {navSections.map((section) => (
            <div key={section.label}>
              <div className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
                {section.label}
              </div>
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const active = isActivePath(location, item.href);
                  return (
                    <Link
                      key={item.name}
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      data-testid={`link-nav-${item.name
                        .toLowerCase()
                        .replace(/\s+/g, "-")}`}
                      className={cn(
                        "group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all duration-150",
                        active
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                      )}
                    >
                      {active && (
                        <span
                          aria-hidden
                          className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-primary"
                        />
                      )}
                      <item.icon
                        className={cn(
                          "h-[17px] w-[17px] shrink-0 transition-colors",
                          active
                            ? "text-primary"
                            : "text-muted-foreground group-hover:text-sidebar-foreground",
                        )}
                        strokeWidth={active ? 2.25 : 2}
                      />
                      <span className="truncate">{item.name}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </ScrollArea>

      {/* Workspace footer */}
      <div className="border-t border-sidebar-border p-3">
        <div className="flex items-center gap-2.5 rounded-md px-2.5 py-2 bg-sidebar-accent/40">
          <div className="h-8 w-8 rounded-md bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center text-primary text-xs font-semibold ring-1 ring-primary/15">
            {orgLoading ? "·" : (org?.name?.[0]?.toUpperCase() ?? "·")}
          </div>
          <div className="min-w-0 flex-1">
            {orgLoading ? (
              <Skeleton className="h-3.5 w-24" />
            ) : (
              <p
                className="text-xs font-semibold text-sidebar-foreground truncate"
                data-testid="text-sidebar-org-name"
              >
                {org?.name ?? "Workspace"}
              </p>
            )}
            <p className="text-[10px] text-muted-foreground truncate">
              {org?.subscriptionStatus === "active"
                ? "Pro plan"
                : org?.subscriptionStatus === "trialing"
                  ? "Trial"
                  : "Free plan"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
