import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { UserMenu } from "./UserMenu";
import { Sidebar } from "./Sidebar";
import { useGetCurrentOrganization } from "@/lib/queryKeys";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";

export function Topbar() {
  const { data: org, isLoading } = useGetCurrentOrganization();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b bg-background px-4 sm:px-6 shadow-sm">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="outline" size="icon" className="shrink-0 md:hidden" data-testid="btn-mobile-menu">
            <Menu className="h-5 w-5" />
            <span className="sr-only">Toggle navigation menu</span>
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="p-0 w-72">
          <Sidebar onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      
      <div className="w-full flex-1">
        <div className="flex items-center gap-2">
          {isLoading ? (
            <Skeleton className="h-5 w-32" />
          ) : (
            <span className="font-semibold text-sm hidden sm:inline-block text-muted-foreground" data-testid="text-org-name">
              {org?.name}
            </span>
          )}
        </div>
      </div>
      
      <div className="flex items-center gap-4 shrink-0">
        <UserMenu />
      </div>
    </header>
  );
}
