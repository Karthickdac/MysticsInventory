import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useAcceptTeamInvitation } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

export default function AcceptInvitation() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setToken(params.get("token"));
  }, []);

  const accept = useAcceptTeamInvitation({
    mutation: {
      onSuccess: async () => {
        await qc.invalidateQueries();
        toast({ title: "Invitation accepted", description: "Welcome to the team." });
        setLocation("/dashboard");
      },
      onError: (err: unknown) => {
        setErrorMessage(err instanceof Error ? err.message : "Could not accept invitation");
      },
    },
  });

  if (!token) {
    return (
      <div className="max-w-md mx-auto py-10">
        <Card>
          <CardHeader>
            <CardTitle>No invitation token</CardTitle>
            <CardDescription>
              The link you used is missing the invitation token. Please ask for a new link.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto py-10">
      <Card>
        <CardHeader>
          <CardTitle>Accept invitation</CardTitle>
          <CardDescription>Join the workspace you were invited to.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {errorMessage && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              {errorMessage}
            </div>
          )}
          <Button
            className="w-full"
            disabled={accept.isPending}
            onClick={() => accept.mutate({ data: { token } })}
            data-testid="button-accept-invitation"
          >
            {accept.isPending ? "Accepting..." : "Accept invitation"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
