import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Package,
  Users,
  Truck,
  Warehouse,
  ArrowLeftRight,
  Repeat,
  ShoppingCart,
  ShoppingBag,
  IndianRupee,
  BarChart3,
  Blocks,
  Settings,
  UserCog,
  Boxes,
  CreditCard,
  ChevronsLeft,
  ChevronsRight,
  ChevronRight,
  ShieldCheck,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useGetCurrentOrganization, useGetMe } from "@/lib/queryKeys";
import { Skeleton } from "@/components/ui/skeleton";
import type { LucideIcon } from "lucide-react";
import { useOptionalSidebarCollapse } from "./SidebarContext";

interface SidebarProps {
  className?: string;
  onNavigate?: () => void;
  /**
   * When false, the sidebar always renders in expanded mode and ignores the
   * shared collapse state (used by the mobile sheet). Defaults to true.
   */
  collapsible?: boolean;
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

const platformSection: NavSection = {
  label: "Platform",
  items: [{ name: "Admin", href: "/admin", icon: ShieldCheck }],
};

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
      { name: "Stock Transfers", href: "/transfers", icon: Repeat },
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
      { name: "Supplier Payments", href: "/supplier-payments", icon: IndianRupee },
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

const COLLAPSED_SECTIONS_KEY = "mystics.sidebar.collapsedSections";

function loadCollapsedSections(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(COLLAPSED_SECTIONS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function saveCollapsedSections(value: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      COLLAPSED_SECTIONS_KEY,
      JSON.stringify([...value]),
    );
  } catch {
    /* ignore quota / privacy errors */
  }
}

function useCollapsedSections(location: string) {
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() =>
    loadCollapsedSections(),
  );

  // Persist whenever the set changes — keeping side effects out of the state
  // updater so concurrent renders stay safe.
  useEffect(() => {
    saveCollapsedSections(collapsedSections);
  }, [collapsedSections]);

  // Auto-expand any section that currently contains the active route so the
  // user never loses sight of where they are.
  useEffect(() => {
    setCollapsedSections((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const section of navSections) {
        if (
          next.has(section.label) &&
          section.items.some((it) => isActivePath(location, it.href))
        ) {
          next.delete(section.label);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [location]);

  const toggleSection = useCallback((label: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  }, []);

  return { collapsedSections, toggleSection };
}

export function Sidebar({
  className,
  onNavigate,
  collapsible = true,
}: SidebarProps) {
  const [location] = useLocation();
  const { data: org, isLoading: orgLoading } = useGetCurrentOrganization();
  const { data: me } = useGetMe();
  const ctx = useOptionalSidebarCollapse();
  const collapsed = collapsible && ctx ? ctx.collapsed : false;
  const toggle = ctx?.toggle;
  const { collapsedSections, toggleSection } = useCollapsedSections(location);

  return (
    <TooltipProvider delayDuration={120} disableHoverableContent>
      <div
        className={cn(
          "flex h-full flex-col bg-sidebar border-r border-sidebar-border",
          className,
        )}
        data-collapsed={collapsed ? "true" : "false"}
      >
        {/* Brand */}
        <div
          className={cn(
            "flex h-16 items-center border-b border-sidebar-border shrink-0",
            collapsed ? "justify-center px-2" : "px-5",
          )}
        >
          <Link
            href="/dashboard"
            onClick={onNavigate}
            className={cn(
              "flex items-center group",
              collapsed ? "justify-center" : "gap-2.5",
            )}
            data-testid="link-logo"
          >
            <div className="relative h-8 w-8 rounded-lg bg-gradient-to-br from-primary to-[hsl(262_75%_58%)] flex items-center justify-center shadow-sm ring-1 ring-primary/20">
              <Boxes className="h-4 w-4 text-primary-foreground" strokeWidth={2.5} />
            </div>
            {!collapsed && (
              <div className="flex flex-col leading-tight">
                <span className="text-[15px] font-semibold tracking-tight text-sidebar-foreground">
                  Mystics
                </span>
                <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-medium">
                  Inventory
                </span>
              </div>
            )}
          </Link>
        </div>

        {/* Nav sections */}
        <ScrollArea className="flex-1">
          <nav
            className={cn(
              "py-4",
              collapsed ? "px-2 space-y-2" : "px-3 space-y-2",
            )}
          >
            {navSections.map((section, sectionIdx) => {
              const sectionHasActive = section.items.some((it) =>
                isActivePath(location, it.href),
              );
              const sectionOpen =
                !collapsedSections.has(section.label) || sectionHasActive;
              const items = section.items.map((item) => {
                const active = isActivePath(location, item.href);
                const link = (
                  <Link
                    key={item.name}
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    aria-label={collapsed ? item.name : undefined}
                    data-testid={`link-nav-${item.name
                      .toLowerCase()
                      .replace(/\s+/g, "-")}`}
                    className={cn(
                      "group relative flex items-center rounded-md text-sm font-medium transition-all duration-150",
                      collapsed
                        ? "h-10 w-10 mx-auto justify-center"
                        : "gap-3 px-3 py-2",
                      active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                    )}
                  >
                    {active && !collapsed && (
                      <span
                        aria-hidden
                        className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-primary"
                      />
                    )}
                    {active && collapsed && (
                      <span
                        aria-hidden
                        className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r-full bg-primary"
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
                    {!collapsed && (
                      <span className="truncate">{item.name}</span>
                    )}
                  </Link>
                );
                if (!collapsed) return link;
                return (
                  <Tooltip key={item.name}>
                    <TooltipTrigger asChild>{link}</TooltipTrigger>
                    <TooltipContent side="right" sideOffset={8}>
                      {item.name}
                    </TooltipContent>
                  </Tooltip>
                );
              });

              if (collapsed) {
                // Icon-only mode: keep flat list with thin dividers between sections.
                return (
                  <div key={section.label}>
                    {sectionIdx > 0 && (
                      <div
                        aria-hidden
                        className="mx-2 mb-2 h-px bg-sidebar-border/70"
                      />
                    )}
                    <div className="space-y-0.5">{items}</div>
                  </div>
                );
              }

              return (
                <Collapsible
                  key={section.label}
                  open={sectionOpen}
                  onOpenChange={() => toggleSection(section.label)}
                  className="space-y-1"
                >
                  <CollapsibleTrigger
                    data-testid={`btn-sidebar-section-${section.label
                      .toLowerCase()
                      .replace(/\s+/g, "-")}`}
                    className="group flex w-full items-center justify-between rounded-md px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80 hover:text-sidebar-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-expanded={sectionOpen}
                    aria-controls={`sidebar-section-${section.label
                      .toLowerCase()
                      .replace(/\s+/g, "-")}`}
                  >
                    <span>{section.label}</span>
                    <ChevronRight
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 transition-transform duration-200",
                        sectionOpen && "rotate-90",
                      )}
                      strokeWidth={2.25}
                      aria-hidden
                    />
                  </CollapsibleTrigger>
                  <CollapsibleContent
                    id={`sidebar-section-${section.label
                      .toLowerCase()
                      .replace(/\s+/g, "-")}`}
                    className="space-y-0.5"
                  >
                    {items}
                  </CollapsibleContent>
                </Collapsible>
              );
            })}

            {/* Platform admin — only rendered for super admins */}
            {me?.user.isSuperAdmin
              ? (() => {
                  const section = platformSection;
                  const sectionHasActive = section.items.some((it) =>
                    isActivePath(location, it.href),
                  );
                  const sectionOpen =
                    !collapsedSections.has(section.label) || sectionHasActive;
                  const items = section.items.map((item) => {
                    const active = isActivePath(location, item.href);
                    const link = (
                      <Link
                        key={item.name}
                        href={item.href}
                        onClick={onNavigate}
                        aria-current={active ? "page" : undefined}
                        aria-label={collapsed ? item.name : undefined}
                        data-testid={`link-nav-${item.name
                          .toLowerCase()
                          .replace(/\s+/g, "-")}`}
                        className={cn(
                          "group relative flex items-center rounded-md text-sm font-medium transition-all duration-150",
                          collapsed
                            ? "h-10 w-10 mx-auto justify-center"
                            : "gap-3 px-3 py-2",
                          active
                            ? "bg-sidebar-accent text-sidebar-accent-foreground"
                            : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                        )}
                      >
                        {active && (
                          <span
                            aria-hidden
                            className={cn(
                              "absolute left-0 top-1.5 bottom-1.5 rounded-r-full bg-primary",
                              collapsed ? "w-[2px]" : "w-[3px]",
                            )}
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
                        {!collapsed && (
                          <span className="truncate">{item.name}</span>
                        )}
                      </Link>
                    );
                    if (!collapsed) return link;
                    return (
                      <Tooltip key={item.name}>
                        <TooltipTrigger asChild>{link}</TooltipTrigger>
                        <TooltipContent side="right" sideOffset={8}>
                          {item.name}
                        </TooltipContent>
                      </Tooltip>
                    );
                  });

                  if (collapsed) {
                    return (
                      <div key={section.label}>
                        <div
                          aria-hidden
                          className="mx-2 mb-2 h-px bg-sidebar-border/70"
                        />
                        <div className="space-y-0.5">{items}</div>
                      </div>
                    );
                  }

                  return (
                    <Collapsible
                      key={section.label}
                      open={sectionOpen}
                      onOpenChange={() => toggleSection(section.label)}
                      className="space-y-1"
                    >
                      <CollapsibleTrigger
                        data-testid={`btn-sidebar-section-${section.label
                          .toLowerCase()
                          .replace(/\s+/g, "-")}`}
                        className="group flex w-full items-center justify-between rounded-md px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80 hover:text-sidebar-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-expanded={sectionOpen}
                      >
                        <span>{section.label}</span>
                        <ChevronRight
                          className={cn(
                            "h-3.5 w-3.5 shrink-0 transition-transform duration-200",
                            sectionOpen && "rotate-90",
                          )}
                          strokeWidth={2.25}
                          aria-hidden
                        />
                      </CollapsibleTrigger>
                      <CollapsibleContent className="space-y-0.5">
                        {items}
                      </CollapsibleContent>
                    </Collapsible>
                  );
                })()
              : null}
          </nav>
        </ScrollArea>

        {/* Collapse toggle (desktop only) */}
        {collapsible && toggle && (
          <div
            className={cn(
              "border-t border-sidebar-border",
              collapsed ? "p-2" : "px-3 py-2",
            )}
          >
            {collapsed ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={toggle}
                    aria-label="Expand sidebar"
                    aria-expanded={false}
                    data-testid="btn-sidebar-toggle"
                    className="flex h-9 w-9 mx-auto items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground transition-colors"
                  >
                    <ChevronsRight className="h-4 w-4" strokeWidth={2.25} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  Expand sidebar
                </TooltipContent>
              </Tooltip>
            ) : (
              <button
                type="button"
                onClick={toggle}
                aria-label="Collapse sidebar"
                aria-expanded={true}
                data-testid="btn-sidebar-toggle"
                className="flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground transition-colors"
              >
                <ChevronsLeft className="h-4 w-4" strokeWidth={2.25} />
                <span>Collapse sidebar</span>
              </button>
            )}
          </div>
        )}

        {/* Workspace footer */}
        <div
          className={cn(
            "border-t border-sidebar-border",
            collapsed ? "p-2" : "p-3",
          )}
        >
          {collapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className="h-9 w-9 mx-auto rounded-md bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center text-primary text-xs font-semibold ring-1 ring-primary/15"
                  data-testid="text-sidebar-org-name"
                >
                  {orgLoading ? "·" : (org?.name?.[0]?.toUpperCase() ?? "·")}
                </div>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                <div className="flex flex-col leading-tight">
                  <span className="font-semibold">
                    {org?.name ?? "Workspace"}
                  </span>
                  <span className="text-[10px] opacity-80">
                    {org?.subscriptionStatus === "active"
                      ? "Pro plan"
                      : org?.subscriptionStatus === "trialing"
                        ? "Trial"
                        : "Free plan"}
                  </span>
                </div>
              </TooltipContent>
            </Tooltip>
          ) : (
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
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
