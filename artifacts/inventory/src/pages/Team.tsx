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
import { useGetMe } from "@/lib/queryKeys";
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
  const meQuery = useGetMe();
  const me = meQuery.data;
  const myRole = me?.role ?? null;
  const canManage = myRole === "owner" || myRole === "admin";
  const isOwner = myRole === "owner";
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
    mutation: {
      onSuccess: async () => {
        await invalidateAll();
        toast({ title: "Invitation revoked" });
      },
      onError: (err: unknown) =>
        toast({
          title: "Could not revoke invitation",
          description: err instanceof Error ? err.message : "Try again",
          variant: "destructive",
        }),
    },
  });

  const updateRole = useUpdateTeamMemberRole({
    mutation: {
      onSuccess: async () => {
        await invalidateAll();
        toast({ title: "Role updated" });
      },
      onError: async (err: unknown) => {
        // The dropdown has already moved to the new value optimistically;
        // refetch to snap it back to the server's truth, then surface
        // the reason so the user understands why nothing happened.
        await invalidateAll();
        toast({
          title: "Could not update role",
          description: err instanceof Error ? err.message : "Try again",
          variant: "destructive",
        });
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

  const ownerCount =
    membersQuery.data?.filter((m) => m.role === "owner").length ?? 0;

  // What roles can the current viewer assign?
  // - owner: any role
  // - admin: only member <-> admin (no owner)
  // - member / unknown: shouldn't be calling at all
  const assignableRoles: ReadonlyArray<(typeof ROLE_OPTIONS)[number]> = isOwner
    ? ROLE_OPTIONS
    : (["member", "admin"] as const);

  return (
    <div className="space-y-6" data-testid="page-team">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
          <p className="text-sm text-muted-foreground">
            Invite teammates and manage roles for your workspace.
          </p>
        </div>
        {me && (
          <div
            className="text-sm text-muted-foreground rounded-md border border-border/60 px-3 py-2 bg-muted/30"
            data-testid="text-signed-in-as"
          >
            Signed in as{" "}
            <span className="font-medium text-foreground">
              {me.user.name ?? me.user.email}
            </span>
            <span className="ml-2">
              <Badge variant="outline" data-testid="badge-my-role">
                {myRole ?? "unknown"}
              </Badge>
            </span>
          </div>
        )}
      </div>

      {meQuery.isSuccess && !canManage && (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            You're signed in as <span className="font-medium">{myRole}</span>.
            Only owners and admins can invite teammates or change roles. Ask
            an owner to upgrade your role if you need to manage the team.
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>Invite a teammate</CardTitle>
            <CardDescription>
              {isOwner
                ? "Owners and admins can invite others. Invitations expire after 14 days."
                : "Admins can invite members and other admins. Invitations expire after 14 days."}
            </CardDescription>
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
                <Select
                  value={assignableRoles.includes(role) ? role : "member"}
                  onValueChange={(v) => setRole(v as typeof role)}
                >
                  <SelectTrigger id="invite-role" data-testid="select-invite-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {assignableRoles.map((r) => (
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
      )}

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
              {membersQuery.data?.map((m) => {
                const isMe = me?.user.id === m.userId;
                // The dropdown is interactive only if the viewer can manage
                // and isn't being asked to do something the server will refuse.
                // Specifically: an admin can't touch an owner's role; the
                // last-owner can't be demoted; you can always view your own
                // role but can't promote-to-owner unless you're an owner.
                const editable =
                  canManage &&
                  !(m.role === "owner" && !isOwner) &&
                  !(m.role === "owner" && ownerCount <= 1);
                // Restrict the option list per viewer; also drop "owner"
                // if this would leave us 0 owners after a demote (handled
                // server-side too — this just hides the trap).
                const optionsForRow: ReadonlyArray<(typeof ROLE_OPTIONS)[number]> =
                  isOwner ? ROLE_OPTIONS : (["member", "admin"] as const);
                const canRemove =
                  canManage &&
                  !isMe &&
                  !(m.role === "owner" && !isOwner) &&
                  !(m.role === "owner" && ownerCount <= 1);
                return (
                  <TableRow key={m.id} data-testid={`row-member-${m.id}`}>
                    <TableCell>
                      {m.email}
                      {isMe && (
                        <Badge variant="secondary" className="ml-2 text-xs">
                          you
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{m.name ?? "—"}</TableCell>
                    <TableCell>
                      <Select
                        value={m.role}
                        disabled={!editable}
                        onValueChange={(v) =>
                          updateRole.mutate({ id: m.id, data: { role: v } })
                        }
                      >
                        <SelectTrigger className="w-32" data-testid={`select-role-${m.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {optionsForRow.map((r) => (
                            <SelectItem key={r} value={r}>
                              {r}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      {canRemove && (
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
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
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
