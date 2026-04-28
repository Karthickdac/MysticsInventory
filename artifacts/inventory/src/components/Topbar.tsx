import { Menu, Search, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { UserMenu } from "./UserMenu";
import { Sidebar } from "./Sidebar";
import { ThemeToggle } from "./ThemeToggle";
import { useCommandPalette } from "./CommandPalette";
import { useEffect, useState } from "react";
import { useGetMe } from "@/lib/queryKeys";
import { setActiveOrgId } from "@/lib/orgContext";
import { queryClient } from "@/lib/queryClient";

function useCommandShortcutLabel() {
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    if (typeof navigator !== "undefined") {
      const ua = navigator.userAgent.toLowerCase();
      setIsMac(/mac|iphone|ipad|ipod/.test(ua));
    }
  }, []);
  return isMac ? "⌘K" : "Ctrl K";
}

export function Topbar() {
  const [open, setOpen] = useState(false);
  const { openPalette } = useCommandPalette();
  const shortcut = useCommandShortcutLabel();
  const { data: me } = useGetMe();
  const isViewingAs = me?.role === "super_admin";

  const exitViewAs = () => {
    setActiveOrgId(null);
    queryClient.clear();
    if (typeof window !== "undefined") window.location.reload();
  };

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border/70 bg-background/80 backdrop-blur-md px-4 sm:px-6 lg:px-10">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 md:hidden h-9 w-9"
            data-testid="btn-mobile-menu"
          >
            <Menu className="h-5 w-5" />
            <span className="sr-only">Toggle navigation menu</span>
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="p-0 w-[280px] border-r border-sidebar-border">
          <Sidebar onNavigate={() => setOpen(false)} collapsible={false} />
        </SheetContent>
      </Sheet>

      {/* Super-admin "view as" indicator (only when looking at a non-member org) */}
      {isViewingAs && me?.organization ? (
        <div
          className="hidden md:inline-flex items-center gap-2 rounded-md border border-amber-400/40 bg-amber-100/60 dark:bg-amber-500/10 dark:border-amber-500/30 px-2.5 h-8 text-xs font-medium text-amber-900 dark:text-amber-200"
          data-testid="badge-viewing-as"
        >
          <ShieldCheck className="h-3.5 w-3.5" />
          <span>
            Viewing as{" "}
            <span className="font-semibold">{me.organization.name}</span>
          </span>
          <button
            type="button"
            onClick={exitViewAs}
            aria-label="Exit super-admin view"
            className="ml-1 rounded p-0.5 hover:bg-amber-200/50 dark:hover:bg-amber-500/20"
            data-testid="btn-exit-view-as"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {/* Right-aligned cluster: search trigger, theme toggle, avatar */}
      <div className="ml-auto flex items-center gap-2 shrink-0 w-full sm:w-auto">
        <div className="flex-1 sm:flex-none sm:w-80 lg:w-[28rem]">
          <button
            type="button"
            onClick={openPalette}
            onFocus={openPalette}
            aria-label="Open command palette"
            data-testid="btn-open-command-palette"
            className="group hidden sm:flex w-full items-center h-9 rounded-lg border border-input/70 bg-muted/40 pl-9 pr-3 text-left text-sm text-muted-foreground/90 hover:bg-background hover:border-border transition-colors relative focus:outline-none focus:ring-2 focus:ring-ring/30"
          >
            <Search className="absolute left-3 h-4 w-4 text-muted-foreground pointer-events-none" />
            <span className="truncate">Search items, orders, customers...</span>
            <kbd className="ml-auto hidden lg:inline-flex pointer-events-none h-5 select-none items-center gap-1 rounded border border-border bg-muted/80 px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
              {shortcut}
            </kbd>
          </button>

          {/* Mobile: compact icon-only trigger */}
          <Button
            variant="ghost"
            size="icon"
            onClick={openPalette}
            aria-label="Open command palette"
            data-testid="btn-open-command-palette-mobile"
            className="sm:hidden h-9 w-9 ml-auto"
          >
            <Search className="h-4 w-4" />
          </Button>
        </div>
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
