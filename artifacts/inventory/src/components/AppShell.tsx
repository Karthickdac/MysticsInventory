import { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { RequireSignedIn } from "./RequireSignedIn";

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    <RequireSignedIn>
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
    </RequireSignedIn>
  );
}
