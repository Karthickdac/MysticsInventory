import { useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { customFetch, ApiError } from "@workspace/api-client-react";
import type { AuthSession } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { AuthShell } from "@/components/AuthShell";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function SignInPage() {
  const [, setLocation] = useLocation();
  const { refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [needsVerify, setNeedsVerify] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNeedsVerify(false);
    setSubmitting(true);
    try {
      await customFetch<AuthSession>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      await refresh();
      setLocation("/dashboard");
    } catch (err) {
      const apiErr = err as ApiError;
      const data = apiErr?.data as
        | { error?: string; code?: string }
        | undefined;
      const msg = data?.error ?? "Sign-in failed";
      const code = data?.code;
      if (code === "email_not_verified") setNeedsVerify(true);
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell>
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">Welcome back</h2>
        <p className="text-sm text-muted-foreground">
          Sign in to your Mystics Inventory cockpit.
        </p>
      </div>
      <form onSubmit={onSubmit} className="mt-8 space-y-4" noValidate>
        {error && (
          <Alert variant="destructive" data-testid="signin-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {needsVerify && (
          <Alert>
            <AlertDescription>
              <Link
                href="/sign-up"
                className="underline font-medium"
                data-testid="link-resend-verification"
              >
                Resend verification email
              </Link>
            </AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor="signin-email">Email</Label>
          <Input
            id="signin-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="input-signin-email"
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="signin-password">Password</Label>
            <Link
              href="/forgot-password"
              className="text-xs text-muted-foreground hover:text-foreground"
              data-testid="link-forgot-password"
            >
              Forgot password?
            </Link>
          </div>
          <Input
            id="signin-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="input-signin-password"
          />
        </div>
        <Button
          type="submit"
          className="w-full"
          disabled={submitting}
          data-testid="btn-signin-submit"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        Don't have an account?{" "}
        <Link href="/sign-up" className="font-medium underline" data-testid="link-signup">
          Create one
        </Link>
      </p>
      <p className="mt-6 text-center text-[11px] text-muted-foreground/70">
        By continuing you agree to our terms of service and privacy policy.
      </p>
    </AuthShell>
  );
}

// Suppress unused warning — basePath kept for future per-base redirects.
void basePath;
