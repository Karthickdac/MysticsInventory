import { useState } from "react";
import {
  useListTeamMembers,
  useListTeamInvitations,
  useCreateTeamInvitation,
  useCreateTeamUser,
  useRevokeTeamInvitation,
  useUpdateTeamMemberRole,
  useRemoveTeamMember,
  getListTeamMembersQueryKey,
  getListTeamInvitationsQueryKey,
} from "@workspace/api-client-react";
import { ROLE_VALUES, ROLE_LABELS, normalizeRole, type Role } from "@/lib/permissions";
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

const ROLE_OPTIONS = ROLE_VALUES;

export default function Team() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const membersQuery = useListTeamMembers();
  const invitationsQuery = useListTeamInvitations();
  const meQuery = useGetMe();
  const me = meQuery.data;
  const myRole = me?.role ?? null;
  const myRoleNormalized = normalizeRole(myRole);
  const canManage = myRoleNormalized === "owner" || myRoleNormalized === "admin";
  const isOwner = myRoleNormalized === "owner";
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  // Create-user form state
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserName, setNewUserName] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserRole, setNewUserRole] = useState<Role>("viewer");

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

  const createUser = useCreateTeamUser({
    mutation: {
      onSuccess: async () => {
        setNewUserEmail("");
        setNewUserName("");
        setNewUserPassword("");
        setNewUserRole("viewer");
        await invalidateAll();
        toast({
          title: "User created",
          description: "They can sign in immediately with the password you set.",
        });
      },
      onError: (err: unknown) =>
        toast({
          title: "Could not create user",
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

  function submitCreateUser(e: React.FormEvent) {
    e.preventDefault();
    const cleanEmail = newUserEmail.trim();
    const cleanName = newUserName.trim();
    if (!cleanEmail || !cleanName) return;
    if (newUserPassword.length < 8) {
      toast({
        title: "Password too short",
        description: "Use at least 8 characters.",
        variant: "destructive",
      });
      return;
    }
    createUser.mutate({
      data: {
        email: cleanEmail,
        name: cleanName,
        password: newUserPassword,
        role: newUserRole,
      },
    });
  }

  const ownerCount =
    membersQuery.data?.filter((m) => m.role === "owner").length ?? 0;

  // What roles can the current viewer assign?
  // - owner: any role (including another owner)
  // - admin: anything below owner — they can promote up to admin but
  //   not above themselves
  // - everyone else: shouldn't be on this page at all (route guard
  //   will have already redirected them)
  const assignableRoles: ReadonlyArray<Role> = isOwner
    ? ROLE_OPTIONS
    : (ROLE_OPTIONS.filter((r) => r !== "owner") as Role[]);

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
            <CardTitle>Create a user</CardTitle>
            <CardDescription>
              Create the account directly with a password — they can sign
              in immediately. Use this when you want to skip the email
              invitation step.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={submitCreateUser}
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end"
              data-testid="form-create-user"
            >
              <div className="space-y-2 lg:col-span-1">
                <Label htmlFor="new-user-name">Full name</Label>
                <Input
                  id="new-user-name"
                  type="text"
                  value={newUserName}
                  onChange={(e) => setNewUserName(e.target.value)}
                  placeholder="Anita Sharma"
                  data-testid="input-new-user-name"
                  required
                />
              </div>
              <div className="space-y-2 lg:col-span-1">
                <Label htmlFor="new-user-email">Email</Label>
                <Input
                  id="new-user-email"
                  type="email"
                  value={newUserEmail}
                  onChange={(e) => setNewUserEmail(e.target.value)}
                  placeholder="anita@example.com"
                  data-testid="input-new-user-email"
                  required
                />
              </div>
              <div className="space-y-2 lg:col-span-1">
                <Label htmlFor="new-user-password">Password</Label>
                <Input
                  id="new-user-password"
                  type="password"
                  value={newUserPassword}
                  onChange={(e) => setNewUserPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  minLength={8}
                  data-testid="input-new-user-password"
                  required
                />
              </div>
              <div className="space-y-2 lg:col-span-1">
                <Label htmlFor="new-user-role">Role</Label>
                <Select
                  value={
                    assignableRoles.includes(newUserRole)
                      ? newUserRole
                      : "viewer"
                  }
                  onValueChange={(v) => setNewUserRole(v as Role)}
                >
                  <SelectTrigger id="new-user-role" data-testid="select-new-user-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {assignableRoles.map((r) => (
                      <SelectItem key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="submit"
                disabled={createUser.isPending}
                data-testid="button-create-user"
                className="lg:col-span-1"
              >
                {createUser.isPending ? "Creating..." : "Create user"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>Invite a teammate</CardTitle>
            <CardDescription>
              {isOwner
                ? "Send an email invitation instead. Invitations expire after 14 days."
                : "Admins can invite teammates as anything below owner. Invitations expire after 14 days."}
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
                  value={assignableRoles.includes(role) ? role : "viewer"}
                  onValueChange={(v) => setRole(v as Role)}
                >
                  <SelectTrigger id="invite-role" data-testid="select-invite-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {assignableRoles.map((r) => (
                      <SelectItem key={r} value={r}>
                        {ROLE_LABELS[r]}
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
                const optionsForRow: ReadonlyArray<Role> = isOwner
                  ? ROLE_OPTIONS
                  : (ROLE_OPTIONS.filter((r) => r !== "owner") as Role[]);
                // The current row's role might be a legacy value (e.g.
                // "member") that isn't in the option list — surface it
                // as an extra option so the dropdown renders correctly
                // until it's changed.
                const rowOptions: ReadonlyArray<string> = optionsForRow.includes(
                  m.role as Role,
                )
                  ? optionsForRow
                  : [...optionsForRow, m.role];
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
                          {rowOptions.map((r) => (
                            <SelectItem key={r} value={r}>
                              {ROLE_LABELS[r as Role] ?? r}
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
