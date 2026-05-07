import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { customFetch, ApiError } from "@workspace/api-client-react";
import type { AuthSession } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { AuthShell } from "@/components/AuthShell";

export default function VerifyEmailPage() {
  const [, setLocation] = useLocation();
  const { refresh } = useAuth();
  const [status, setStatus] = useState<"verifying" | "ok" | "error">(
    "verifying",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      setStatus("error");
      setError("Verification link is missing the token.");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        await customFetch<AuthSession>("/api/auth/verify-email", {
          method: "POST",
          body: JSON.stringify({ token }),
        });
        if (cancelled) return;
        await refresh();
        setStatus("ok");
        setTimeout(() => setLocation("/dashboard"), 1200);
      } catch (err) {
        if (cancelled) return;
        const apiErr = err as ApiError;
        const data = apiErr?.data as { error?: string } | undefined;
        const msg = data?.error ?? "Could not verify your email.";
        setError(msg);
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh, setLocation]);

  return (
    <AuthShell>
      {status === "verifying" && (
        <>
          <h2 className="text-2xl font-semibold tracking-tight">
            Verifying your email…
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">One moment.</p>
        </>
      )}
      {status === "ok" && (
        <>
          <h2 className="text-2xl font-semibold tracking-tight text-green-600">
            Email verified
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Taking you to your dashboard…
          </p>
        </>
      )}
      {status === "error" && (
        <>
          <h2 className="text-2xl font-semibold tracking-tight text-destructive">
            Verification failed
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <div className="mt-6 flex gap-2">
            <Button asChild>
              <Link href="/sign-in">Back to sign in</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/sign-up">Create a new account</Link>
            </Button>
          </div>
        </>
      )}
    </AuthShell>
  );
}
