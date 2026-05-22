import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import type { AuthSession, User } from "@workspace/api-client-react";
import { setActiveOrgId } from "./orgContext";

interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const SESSION_KEY = ["auth", "session"] as const;

async function fetchSession(): Promise<AuthSession> {
  return customFetch<AuthSession>("/api/auth/session", { method: "GET" });
}

async function postLogout(): Promise<void> {
  await customFetch("/api/auth/logout", { method: "POST" });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: SESSION_KEY,
    queryFn: fetchSession,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // When the signed-in user identity changes (e.g. login → logout, or
  // a sign-in as a different account), clear all cached tenant data
  // and drop any "view as" override so the new identity doesn't see
  // the old user's workspace.
  const prevUserIdRef = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (sessionQuery.isLoading) return;
    const userId = sessionQuery.data?.user?.id ?? null;
    if (
      prevUserIdRef.current !== undefined &&
      prevUserIdRef.current !== userId
    ) {
      qc.removeQueries({
        predicate: (q) => {
          const k = q.queryKey;
          return Array.isArray(k) && k[0] !== "auth";
        },
      });
      setActiveOrgId(null);
    }
    prevUserIdRef.current = userId;
  }, [sessionQuery.data?.user?.id, sessionQuery.isLoading, qc]);

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: SESSION_KEY });
  }, [qc]);

  const logout = useCallback(async () => {
    await postLogout();
    qc.removeQueries({
      predicate: (q) => {
        const k = q.queryKey;
        return Array.isArray(k) && k[0] !== "auth";
      },
    });
    setActiveOrgId(null);
    await qc.invalidateQueries({ queryKey: SESSION_KEY });
  }, [qc]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: sessionQuery.data?.user ?? null,
      // Also block navigation while a re-fetch is in-flight with no user yet
      // (e.g. immediately after login before the session refetch completes).
      isLoading:
        sessionQuery.isLoading ||
        (sessionQuery.isFetching && !sessionQuery.data?.user),
      refresh,
      logout,
    }),
    [sessionQuery.data, sessionQuery.isLoading, sessionQuery.isFetching, refresh, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}

export const AUTH_SESSION_QUERY_KEY = SESSION_KEY;
