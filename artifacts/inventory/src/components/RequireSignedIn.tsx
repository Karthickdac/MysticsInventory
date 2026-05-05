import { Redirect } from "wouter";
import { useAuth } from "@/lib/auth";
import { RouteFallback } from "./RouteFallback";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function RequireSignedIn({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return <RouteFallback />;
  if (!user) return <Redirect to={`${basePath}/sign-in`} />;
  return <>{children}</>;
}
