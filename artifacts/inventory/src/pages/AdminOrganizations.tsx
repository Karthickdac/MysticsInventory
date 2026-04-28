import { useLocation } from "wouter";
import {
  useListAdminOrganizations,
  useGetAdminPlatformStats,
  useGetMe,
} from "@/lib/queryKeys";
import { setActiveOrgId, getActiveOrgId } from "@/lib/orgContext";
import { queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { ShieldAlert, Building2, Users, Boxes, ShoppingCart } from "lucide-react";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

export default function AdminOrganizations() {
  const [, setLocation] = useLocation();
  const meQuery = useGetMe();
  const orgsQuery = useListAdminOrganizations();
  const statsQuery = useGetAdminPlatformStats();
  const activeOrgId = getActiveOrgId();

  if (meQuery.isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!meQuery.data?.user.isSuperAdmin) {
    return (
      <div className="p-6">
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <ShieldAlert className="h-5 w-5" />
              Super admin access required
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            This page is reserved for platform administrators. Ask
            an existing super admin to add your email to the
            <code className="mx-1 px-1.5 py-0.5 rounded bg-muted">
              SUPER_ADMIN_EMAILS
            </code>
            list and sign in again.
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleViewAs = async (orgId: number) => {
    setActiveOrgId(orgId);
    queryClient.clear();
    setLocation("/dashboard");
  };

  const handleClear = async () => {
    setActiveOrgId(null);
    queryClient.clear();
    setLocation("/dashboard");
  };

  const stats = statsQuery.data;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Platform admin
          </h1>
          <p className="text-sm text-muted-foreground">
            Cross-tenant view of every workspace on Mystics Inventory.
          </p>
        </div>
        {activeOrgId !== null ? (
          <Button
            variant="outline"
            onClick={handleClear}
            data-testid="btn-clear-view-as"
          >
            Exit "view as" mode
          </Button>
        ) : null}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              Organizations
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold" data-testid="stat-org-count">
              {stats?.organizationCount ?? "—"}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Users className="h-4 w-4" />
              Users
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold" data-testid="stat-user-count">
              {stats?.userCount ?? "—"}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <ShoppingCart className="h-4 w-4" />
              Sales orders
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold" data-testid="stat-order-count">
              {stats?.salesOrderCount ?? "—"}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All organizations</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {orgsQuery.isLoading ? (
            <div className="p-6 space-y-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : orgsQuery.data && orgsQuery.data.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead className="text-right">Members</TableHead>
                  <TableHead className="text-right">Items</TableHead>
                  <TableHead className="text-right">Sales orders</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orgsQuery.data.map((org) => (
                  <TableRow
                    key={org.id}
                    data-testid={`row-admin-org-${org.id}`}
                  >
                    <TableCell>
                      <div className="font-medium">{org.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {org.slug}
                        {org.gstNumber ? ` · ${org.gstNumber}` : ""}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="capitalize">
                        {org.plan}
                      </Badge>
                      <div className="mt-1 text-xs text-muted-foreground capitalize">
                        {org.subscriptionStatus.replace("_", " ")}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {org.memberCount}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <span className="inline-flex items-center gap-1">
                        <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
                        {org.itemCount}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {org.salesOrderCount}
                    </TableCell>
                    <TableCell>{formatDate(org.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleViewAs(org.id)}
                        data-testid={`btn-view-as-${org.id}`}
                      >
                        View as
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="p-6 text-sm text-muted-foreground">
              No organizations yet.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
