import type { Request, Response, NextFunction } from "express";
import { eq, and, inArray, sql, isNull, gt } from "drizzle-orm";
import {
  db,
  usersTable,
  organizationsTable,
  organizationMembersTable,
  teamInvitationsTable,
  warehousesTable,
  itemsTable,
  customersTable,
  suppliersTable,
} from "@workspace/db";
import { checkRolePolicy, normalizeRole } from "./permissions";

export interface TenantInfo {
  userId: number;
  organizationId: number;
  role: string;
  isSuperAdmin: boolean;
}

/**
 * Returns the lowercase set of emails that should be promoted to
 * super-admin. Configured at runtime via the `SUPER_ADMIN_EMAILS`
 * env var (comma-separated). Empty / missing var → no super admins.
 */
function superAdminEmailSet(): Set<string> {
  const raw = process.env.SUPER_ADMIN_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: TenantInfo;
    }
  }
}

function slugify(input: string, fallback: string): string {
  const base = (input || fallback)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
  return base || fallback;
}

async function uniqueSlug(seed: string): Promise<string> {
  let slug = seed;
  let i = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await db
      .select({ id: organizationsTable.id })
      .from(organizationsTable)
      .where(eq(organizationsTable.slug, slug))
      .limit(1);
    if (existing.length === 0) return slug;
    i += 1;
    slug = `${seed}-${i}`;
  }
}

/**
 * Resolve which org the caller is operating against. The user is now
 * looked up by local primary key (from req.session.userId) instead of
 * by Clerk user id, so the user MUST already exist (they're created
 * by /auth/signup or by the legacy Clerk import). This function will
 * NOT auto-create the user row.
 */
export async function ensureTenant(
  userId: number,
  requestedOrganizationId?: number,
): Promise<TenantInfo> {
  const userRows = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  let userRow = userRows[0];
  if (!userRow) {
    const err = new Error("User not found") as Error & { status?: number };
    err.status = 401;
    throw err;
  }

  // Re-evaluate super-admin status on every request so administrators
  // can grant / revoke the role purely by editing SUPER_ADMIN_EMAILS.
  const shouldBeSuper = superAdminEmailSet().has(userRow.email.toLowerCase());
  if (shouldBeSuper !== userRow.isSuperAdmin) {
    const updated = await db
      .update(usersTable)
      .set({ isSuperAdmin: shouldBeSuper })
      .where(eq(usersTable.id, userRow.id))
      .returning();
    userRow = updated[0]!;
  }

  let memberRows = await db
    .select()
    // org-scope-allow: auth bootstrap. We don't yet know the user's org —
    // we're about to derive it from their memberships.
    .from(organizationMembersTable)
    .where(eq(organizationMembersTable.userId, userRow.id))
    .orderBy(organizationMembersTable.id);

  // If the user has no memberships yet, look for pending team invitations
  // addressed to their email and auto-accept all of them BEFORE we fall
  // through to the "create a fresh workspace" branch below.
  if (memberRows.length === 0) {
    const pendingInvites = await db
      .select()
      // org-scope-allow: cross-org invitation lookup by user's email is the
      // whole point — we're matching invites that target this user.
      .from(teamInvitationsTable)
      .where(
        and(
          sql`lower(${teamInvitationsTable.email}) = lower(${userRow.email})`,
          isNull(teamInvitationsTable.acceptedAt),
          gt(teamInvitationsTable.expiresAt, new Date()),
        ),
      );
    if (pendingInvites.length > 0) {
      const acceptedAt = new Date();
      for (const inv of pendingInvites) {
        await db
          .insert(organizationMembersTable)
          .values({
            userId: userRow.id,
            organizationId: inv.organizationId,
            role: inv.role,
          })
          .onConflictDoNothing();
        await db
          // org-scope-allow: auth bootstrap, marking the just-loaded invitation
          // (looked up by user email above) as accepted.
          .update(teamInvitationsTable)
          .set({ acceptedAt })
          .where(eq(teamInvitationsTable.id, inv.id));
      }
      memberRows = await db
        .select()
        // org-scope-allow: auth bootstrap re-read after auto-accepting invites.
        .from(organizationMembersTable)
        .where(eq(organizationMembersTable.userId, userRow.id))
        .orderBy(organizationMembersTable.id);
    }
  }

  if (memberRows.length > 0) {
    let chosen = memberRows[0]!;
    if (requestedOrganizationId !== undefined) {
      const match = memberRows.find(
        (m) => m.organizationId === requestedOrganizationId,
      );
      if (!match) {
        // Super admins may "view as" any organization, even one they
        // are not a member of.
        if (userRow.isSuperAdmin) {
          const orgExists = await db
            .select({ id: organizationsTable.id })
            .from(organizationsTable)
            .where(eq(organizationsTable.id, requestedOrganizationId))
            .limit(1);
          if (orgExists.length === 0) {
            const err = new Error("Organization not found") as Error & {
              status?: number;
            };
            err.status = 404;
            throw err;
          }
          return {
            userId: userRow.id,
            organizationId: requestedOrganizationId,
            role: "super_admin",
            isSuperAdmin: true,
          };
        }
        const err = new Error(
          "You are not a member of the requested organization",
        ) as Error & { status?: number };
        err.status = 403;
        throw err;
      }
      chosen = match;
    }
    return {
      userId: userRow.id,
      organizationId: chosen.organizationId,
      role: chosen.role,
      isSuperAdmin: userRow.isSuperAdmin,
    };
  }

  if (requestedOrganizationId !== undefined && userRow.isSuperAdmin) {
    const orgExists = await db
      .select({ id: organizationsTable.id })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, requestedOrganizationId))
      .limit(1);
    if (orgExists.length === 0) {
      const err = new Error("Organization not found") as Error & {
        status?: number;
      };
      err.status = 404;
      throw err;
    }
    return {
      userId: userRow.id,
      organizationId: requestedOrganizationId,
      role: "super_admin",
      isSuperAdmin: true,
    };
  }

  const orgName = userRow.name ? `${userRow.name}'s Workspace` : "My Workspace";
  const slugSeed = slugify(userRow.name ?? userRow.email.split("@")[0]!, "workspace");
  const slug = await uniqueSlug(slugSeed);
  const trialEnds = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  const orgInserted = await db
    .insert(organizationsTable)
    .values({
      name: orgName,
      slug,
      trialEndsAt: trialEnds,
    })
    .returning();
  const org = orgInserted[0]!;

  await db.insert(organizationMembersTable).values({
    userId: userRow.id,
    organizationId: org.id,
    role: "owner",
  });

  await db.insert(warehousesTable).values({
    organizationId: org.id,
    name: "Main Warehouse",
    code: "MAIN",
    isDefault: true,
    country: "India",
  });

  return {
    userId: userRow.id,
    organizationId: org.id,
    role: "owner",
    isSuperAdmin: userRow.isSuperAdmin ?? false,
  };
}

/**
 * Read the caller's user id from either:
 *   - the active session cookie (browser users), OR
 *   - the `x-test-user-id` / `x-test-org-id` test bypass (test harness)
 *
 * Returns null if the request is unauthenticated.
 */
function readSessionUserId(req: Request): number | null {
  // Test harness bypass: tests inject either a user id or an org id
  // header. Honoured only when NODE_ENV is "test" so production
  // requests can never spoof it.
  if (process.env.NODE_ENV === "test") {
    const tu = req.header("x-test-user-id");
    if (tu) {
      const n = Number(tu);
      if (Number.isInteger(n) && n > 0) return n;
    }
  }
  const sid = (req.session as { userId?: number } | undefined)?.userId;
  return typeof sid === "number" && Number.isInteger(sid) && sid > 0 ? sid : null;
}

export async function tenantMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = readSessionUserId(req);
    if (userId == null) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const headerVal = req.header("x-organization-id");
    let requestedOrgId: number | undefined;
    if (headerVal) {
      const n = Number(headerVal);
      if (!Number.isInteger(n) || n <= 0) {
        res.status(400).json({ error: "Invalid X-Organization-Id header" });
        return;
      }
      requestedOrgId = n;
    }
    req.tenant = await ensureTenant(userId, requestedOrgId);

    // Role gate. Super admins bypass entirely (they're impersonating
    // an org and need unrestricted access). Otherwise, check the
    // request method+path against the central policy table; any
    // explicit deny short-circuits with a 403 before the route
    // handler runs.
    if (!req.tenant.isSuperAdmin) {
      const role = normalizeRole(req.tenant.role);
      const decision = checkRolePolicy(req.method, req.path, role);
      if (!decision.allowed) {
        res.status(403).json({
          error: `Your role (${role}) does not allow this action.`,
        });
        return;
      }
    }

    next();
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 401) {
      res.status(401).json({ error: e.message });
      return;
    }
    if (e.status === 403) {
      res.status(403).json({ error: e.message });
      return;
    }
    if (e.status === 404) {
      res.status(404).json({ error: e.message });
      return;
    }
    next(err);
  }
}

async function countOwned(
  ids: number[],
  organizationId: number,
  table:
    | typeof warehousesTable
    | typeof itemsTable
    | typeof customersTable
    | typeof suppliersTable,
): Promise<number> {
  if (ids.length === 0) return 0;
  const unique = Array.from(new Set(ids));
  const conds = [
    eq(table.organizationId, organizationId),
    inArray(table.id, unique),
  ];
  if (table === itemsTable) {
    conds.push(sql`${itemsTable.archivedAt} IS NULL`);
  }
  const rows = await db
    .select({ c: sql<string>`COUNT(*)` })
    .from(table)
    .where(and(...conds));
  return Number(rows[0]?.c ?? 0);
}

export async function assertOwnership(opts: {
  organizationId: number;
  warehouseIds?: number[];
  itemIds?: number[];
  customerIds?: number[];
  supplierIds?: number[];
}): Promise<{ ok: true } | { ok: false; missing: string }> {
  const { organizationId } = opts;
  const groups: Array<{ label: string; ids: number[]; table: Parameters<typeof countOwned>[2] }> = [];
  if (opts.warehouseIds?.length) groups.push({ label: "warehouse", ids: opts.warehouseIds, table: warehousesTable });
  if (opts.itemIds?.length) groups.push({ label: "item", ids: opts.itemIds, table: itemsTable });
  if (opts.customerIds?.length) groups.push({ label: "customer", ids: opts.customerIds, table: customersTable });
  if (opts.supplierIds?.length) groups.push({ label: "supplier", ids: opts.supplierIds, table: suppliersTable });

  for (const g of groups) {
    const expected = new Set(g.ids).size;
    const actual = await countOwned(g.ids, organizationId, g.table);
    if (actual !== expected) return { ok: false, missing: g.label };
  }
  return { ok: true };
}

export async function findParentItems(
  organizationId: number,
  itemIds: number[],
): Promise<Array<{ id: number; name: string; sku: string }>> {
  if (itemIds.length === 0) return [];
  const rows = await db
    .select({
      id: itemsTable.id,
      name: itemsTable.name,
      sku: itemsTable.sku,
    })
    .from(itemsTable)
    .where(
      and(
        eq(itemsTable.organizationId, organizationId),
        inArray(itemsTable.id, itemIds),
        eq(itemsTable.hasVariants, true),
      ),
    );
  return rows;
}

export async function findBundleItems(
  organizationId: number,
  itemIds: number[],
): Promise<Array<{ id: number; name: string; sku: string }>> {
  if (itemIds.length === 0) return [];
  const rows = await db
    .select({
      id: itemsTable.id,
      name: itemsTable.name,
      sku: itemsTable.sku,
    })
    .from(itemsTable)
    .where(
      and(
        eq(itemsTable.organizationId, organizationId),
        inArray(itemsTable.id, itemIds),
        eq(itemsTable.isBundle, true),
      ),
    );
  return rows;
}

export async function getDefaultWarehouseId(
  organizationId: number,
): Promise<number> {
  const rows = await db
    .select({ id: warehousesTable.id })
    .from(warehousesTable)
    .where(
      and(
        eq(warehousesTable.organizationId, organizationId),
        eq(warehousesTable.isDefault, true),
      ),
    )
    .limit(1);
  if (rows[0]) return rows[0].id;
  const any = await db
    .select({ id: warehousesTable.id })
    .from(warehousesTable)
    .where(eq(warehousesTable.organizationId, organizationId))
    .limit(1);
  if (any[0]) return any[0].id;
  const inserted = await db
    .insert(warehousesTable)
    .values({
      organizationId,
      name: "Main Warehouse",
      code: "MAIN",
      isDefault: true,
      country: "India",
    })
    .returning({ id: warehousesTable.id });
  return inserted[0]!.id;
}
