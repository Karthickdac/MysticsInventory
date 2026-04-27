import { ReactNode } from "react";
import { useLocation, Redirect } from "wouter";
import { useGetMe } from "@workspace/api-client-react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { RequireSignedIn } from "./RequireSignedIn";
import { CommandPaletteProvider } from "./CommandPalette";

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

export function AppShell({ children }: AppShellProps) {
  return (
    <RequireSignedIn>
      <OnboardingGate>
        <CommandPaletteProvider>
          <div className="flex min-h-screen w-full bg-background">
            <aside className="hidden md:flex md:w-[260px] md:flex-col md:fixed md:inset-y-0 z-40">
              <Sidebar />
            </aside>
            <div className="flex flex-col flex-1 md:pl-[260px] min-w-0">
              <Topbar />
              <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
                <div className="mx-auto w-full max-w-[1600px]">{children}</div>
              </main>
            </div>
          </div>
        </CommandPaletteProvider>
      </OnboardingGate>
    </RequireSignedIn>
  );
}
