import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { customFetch, ApiError } from "@workspace/api-client-react";
import type { AuthAck } from "@workspace/api-client-react";
import { AuthShell } from "@/components/AuthShell";

export default function SignUpPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setSubmitting(true);
    try {
      await customFetch<AuthAck>("/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          email,
          password,
          name: name.trim() || undefined,
        }),
      });
      setDone(true);
    } catch (err) {
      const apiErr = err as ApiError;
      const data = apiErr?.data as { error?: string } | undefined;
      const msg = data?.error ?? "Sign-up failed";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  async function onResend() {
    setError(null);
    try {
      await customFetch("/auth/resend-verification", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
    } catch {
      // Always success-shaped on the backend; ignore.
    }
  }

  if (done) {
    return (
      <AuthShell>
        <div className="space-y-3">
          <h2 className="text-2xl font-semibold tracking-tight">
            Check your email
          </h2>
          <p className="text-sm text-muted-foreground">
            We've sent a verification link to{" "}
            <span className="font-medium text-foreground">{email}</span>. Click
            the link to finish creating your account.
          </p>
          <Button
            variant="secondary"
            onClick={onResend}
            data-testid="btn-resend-verify"
          >
            Resend verification email
          </Button>
          <p className="text-sm">
            <Link href="/sign-in" className="underline">
              Back to sign in
            </Link>
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">
          Create your account
        </h2>
        <p className="text-sm text-muted-foreground">
          Start your 14-day free trial of Mystics Inventory.
        </p>
      </div>
      <form onSubmit={onSubmit} className="mt-8 space-y-4" noValidate>
        {error && (
          <Alert variant="destructive" data-testid="signup-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor="signup-name">Your name (optional)</Label>
          <Input
            id="signup-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="input-signup-name"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="signup-email">Email</Label>
          <Input
            id="signup-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="input-signup-email"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="signup-password">Password</Label>
          <Input
            id="signup-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="input-signup-password"
          />
          <p className="text-xs text-muted-foreground">
            At least 8 characters.
          </p>
        </div>
        <Button
          type="submit"
          className="w-full"
          disabled={submitting}
          data-testid="btn-signup-submit"
        >
          {submitting ? "Creating account…" : "Create account"}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/sign-in" className="font-medium underline" data-testid="link-signin">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
