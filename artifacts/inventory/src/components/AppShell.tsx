import { ReactNode } from "react";
import { useLocation, Redirect } from "wouter";
import { useGetMe } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { RequireSignedIn } from "./RequireSignedIn";
import { CommandPaletteProvider } from "./CommandPalette";
import { SidebarProvider, useSidebarCollapse } from "./SidebarContext";

interface AppShellProps {
  children: ReactNode;
}

const ONBOARDING_BYPASS = new Set(["/onboarding", "/accept-invitation"]);

function OnboardingGate({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const meQuery = useGetMe();
  if (meQuery.isLoading || !meQuery.data) {
    return <>{children}</>;
  }
  const needsOnboarding = !meQuery.data.organization.onboardingCompletedAt;
  if (needsOnboarding && !ONBOARDING_BYPASS.has(location)) {
    return <Redirect to="/onboarding" />;
  }
  return <>{children}</>;
}

function ShellLayout({ children }: { children: ReactNode }) {
  const { collapsed } = useSidebarCollapse();
  return (
    <div className="flex min-h-screen w-full bg-background">
      <aside
        className={cn(
          "hidden md:flex md:flex-col md:fixed md:inset-y-0 z-40 transition-[width] duration-200 ease-out",
          collapsed ? "md:w-[68px]" : "md:w-[260px]",
        )}
      >
        <Sidebar />
      </aside>
      <div
        className={cn(
          "flex flex-col flex-1 min-w-0 transition-[padding] duration-200 ease-out",
          collapsed ? "md:pl-[68px]" : "md:pl-[260px]",
        )}
      >
        <Topbar />
        <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
          <div className="mx-auto w-full max-w-[1600px]">{children}</div>
        </main>
      </div>
    </div>
  );
}

export function AppShell({ children }: AppShellProps) {
  return (
    <RequireSignedIn>
      <OnboardingGate>
        <CommandPaletteProvider>
          <SidebarProvider>
            <ShellLayout>{children}</ShellLayout>
          </SidebarProvider>
        </CommandPaletteProvider>
      </OnboardingGate>
    </RequireSignedIn>
  );
}
