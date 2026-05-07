import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { customFetch, ApiError } from "@workspace/api-client-react";
import type { AuthSession } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { AuthShell } from "@/components/AuthShell";

export default function ResetPasswordPage() {
  const [, setLocation] = useLocation();
  const { refresh } = useAuth();
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setToken(params.get("token") ?? "");
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setSubmitting(true);
    try {
      await customFetch<AuthSession>("/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      });
      await refresh();
      setLocation("/dashboard");
    } catch (err) {
      const apiErr = err as ApiError;
      const data = apiErr?.data as { error?: string } | undefined;
      const msg = data?.error ?? "Password reset failed";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell>
      <h2 className="text-2xl font-semibold tracking-tight">
        Set a new password
      </h2>
      <form onSubmit={onSubmit} className="mt-8 space-y-4" noValidate>
        {error && (
          <Alert variant="destructive" data-testid="reset-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor="reset-password">New password</Label>
          <Input
            id="reset-password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="input-reset-password"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="reset-confirm">Confirm password</Label>
          <Input
            id="reset-confirm"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            data-testid="input-reset-confirm"
          />
        </div>
        <Button
          type="submit"
          className="w-full"
          disabled={submitting || !token}
          data-testid="btn-reset-submit"
        >
          {submitting ? "Saving…" : "Set password and sign in"}
        </Button>
        {!token && (
          <p className="text-sm text-destructive">
            Reset token is missing. Please use the link from your email.
          </p>
        )}
      </form>
      <p className="mt-6 text-center text-sm">
        <Link href="/sign-in" className="underline">
          Back to sign in
        </Link>
      </p>
    </AuthShell>
  );
}
