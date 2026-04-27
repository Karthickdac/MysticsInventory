import { Menu, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { UserMenu } from "./UserMenu";
import { Sidebar } from "./Sidebar";
import { useState } from "react";

export function Topbar() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border/70 bg-background/80 backdrop-blur-md px-4 sm:px-6">
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
          <Sidebar onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>

      {/* Search field — visual lift, focuses on quick navigation */}
      <div className="flex-1 max-w-xl">
        <div className="relative hidden sm:flex items-center">
          <Search className="absolute left-3 h-4 w-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Search items, orders, customers..."
            aria-label="Global search"
            className="h-9 w-full rounded-lg border border-input/70 bg-muted/40 pl-9 pr-12 text-sm placeholder:text-muted-foreground/70 focus:bg-background focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/15 transition-colors"
            data-testid="input-global-search"
          />
          <kbd className="absolute right-3 hidden lg:inline-flex pointer-events-none h-5 select-none items-center gap-1 rounded border border-border bg-muted/80 px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
            ⌘K
          </kbd>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <UserMenu />
      </div>
    </header>
  );
}
