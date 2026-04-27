import { ReactNode } from "react";
import { useLocation, Redirect } from "wouter";
import { useGetMe } from "@workspace/api-client-react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { RequireSignedIn } from "./RequireSignedIn";

interface AppShellProps {
  children: ReactNode;
}

const ONBOARDING_BYPASS = new Set([
  "/onboarding",
  "/accept-invitation",
]);

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
        <div className="flex min-h-screen w-full bg-muted/20">
          <div className="hidden md:flex md:w-64 md:flex-col md:fixed md:inset-y-0 z-40">
            <Sidebar />
          </div>
          <div className="flex flex-col flex-1 md:pl-64">
            <Topbar />
            <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto w-full">
              {children}
            </main>
          </div>
        </div>
      </OnboardingGate>
    </RequireSignedIn>
  );
}
