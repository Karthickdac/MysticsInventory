import { useState } from "react";
import {
  useListTeamMembers,
  useListTeamInvitations,
  useCreateTeamInvitation,
  useRevokeTeamInvitation,
  useUpdateTeamMemberRole,
  useRemoveTeamMember,
  getListTeamMembersQueryKey,
  getListTeamInvitationsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Copy, Trash2 } from "lucide-react";

const ROLE_OPTIONS = ["member", "admin", "owner"] as const;

export default function Team() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const membersQuery = useListTeamMembers();
  const invitationsQuery = useListTeamInvitations();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<(typeof ROLE_OPTIONS)[number]>("member");

  const invalidateAll = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: getListTeamMembersQueryKey() }),
      qc.invalidateQueries({ queryKey: getListTeamInvitationsQueryKey() }),
    ]);
  };

  const createInvitation = useCreateTeamInvitation({
    mutation: {
      onSuccess: async () => {
        setEmail("");
        await invalidateAll();
        toast({ title: "Invitation sent", description: "Share the link with your teammate." });
      },
      onError: (err: unknown) =>
        toast({
          title: "Could not invite",
          description: err instanceof Error ? err.message : "Try again",
          variant: "destructive",
        }),
    },
  });

  const revoke = useRevokeTeamInvitation({
    mutation: { onSuccess: invalidateAll },
  });

  const updateRole = useUpdateTeamMemberRole({
    mutation: {
      onSuccess: async () => {
        await invalidateAll();
        toast({ title: "Role updated" });
      },
    },
  });

  const removeMember = useRemoveTeamMember({
    mutation: {
      onSuccess: async () => {
        await invalidateAll();
        toast({ title: "Member removed" });
      },
      onError: (err: unknown) =>
        toast({
          title: "Could not remove",
          description: err instanceof Error ? err.message : "Try again",
          variant: "destructive",
        }),
    },
  });

  function buildInviteLink(token: string) {
    const origin = window.location.origin;
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    return `${origin}${base}/accept-invitation?token=${encodeURIComponent(token)}`;
  }

  function submitInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    createInvitation.mutate({
      data: { email: email.trim(), role },
    });
  }

  return (
    <div className="space-y-6" data-testid="page-team">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
        <p className="text-sm text-muted-foreground">
          Invite teammates and manage roles for your workspace.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Invite a teammate</CardTitle>
          <CardDescription>Owners can invite others. Invitations expire after 14 days.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={submitInvite}
            className="flex flex-col sm:flex-row gap-3 items-end"
            data-testid="form-invite"
          >
            <div className="flex-1 space-y-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@example.com"
                data-testid="input-invite-email"
                required
              />
            </div>
            <div className="space-y-2 sm:w-40">
              <Label htmlFor="invite-role">Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as typeof role)}>
                <SelectTrigger id="invite-role" data-testid="select-invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={createInvitation.isPending} data-testid="button-send-invite">
              {createInvitation.isPending ? "Sending..." : "Send invite"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {membersQuery.data?.map((m) => (
                <TableRow key={m.id} data-testid={`row-member-${m.id}`}>
                  <TableCell>{m.email}</TableCell>
                  <TableCell>{m.name ?? "—"}</TableCell>
                  <TableCell>
                    <Select
                      value={m.role}
                      onValueChange={(v) =>
                        updateRole.mutate({ id: m.id, data: { role: v } })
                      }
                    >
                      <SelectTrigger className="w-32" data-testid={`select-role-${m.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLE_OPTIONS.map((r) => (
                          <SelectItem key={r} value={r}>
                            {r}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        if (confirm(`Remove ${m.email}?`)) {
                          removeMember.mutate({ id: m.id });
                        }
                      }}
                      data-testid={`button-remove-${m.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {(!membersQuery.data || membersQuery.data.length === 0) && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    No members yet
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pending invitations</CardTitle>
          <CardDescription>
            Share the link with the invitee. They must sign in with the matching email.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Link</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitationsQuery.data?.map((inv) => {
                const link = buildInviteLink(inv.token);
                return (
                  <TableRow key={inv.id} data-testid={`row-invitation-${inv.id}`}>
                    <TableCell>{inv.email}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{inv.role}</Badge>
                    </TableCell>
                    <TableCell>
                      {new Date(inv.expiresAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          navigator.clipboard.writeText(link);
                          toast({ title: "Copied link" });
                        }}
                        data-testid={`button-copy-${inv.id}`}
                      >
                        <Copy className="h-3 w-3 mr-1" /> Copy
                      </Button>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => revoke.mutate({ id: inv.id })}
                        data-testid={`button-revoke-${inv.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {(!invitationsQuery.data || invitationsQuery.data.length === 0) && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    No pending invitations
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
