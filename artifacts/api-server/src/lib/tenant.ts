import type { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { eq, and, inArray, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  organizationsTable,
  organizationMembersTable,
  warehousesTable,
  itemsTable,
  customersTable,
  suppliersTable,
} from "@workspace/db";

export interface TenantInfo {
  userId: number;
  organizationId: number;
  role: string;
  clerkUserId: string;
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

export async function ensureTenant(
  clerkUserId: string,
  requestedOrganizationId?: number,
): Promise<TenantInfo> {
  const existingUserRows = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clerkUserId, clerkUserId))
    .limit(1);

  let userRow = existingUserRows[0];

  if (!userRow) {
    const clerkUser = await clerkClient.users.getUser(clerkUserId);
    const email =
      clerkUser.emailAddresses.find(
        (e) => e.id === clerkUser.primaryEmailAddressId,
      )?.emailAddress ??
      clerkUser.emailAddresses[0]?.emailAddress ??
      `${clerkUserId}@unknown.local`;
    const fullName =
      [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ").trim() ||
      null;
    const inserted = await db
      .insert(usersTable)
      .values({ clerkUserId, email, name: fullName })
      .returning();
    userRow = inserted[0]!;
  }

  const memberRows = await db
    .select()
    .from(organizationMembersTable)
    .where(eq(organizationMembersTable.userId, userRow.id))
    .orderBy(organizationMembersTable.id);

  if (memberRows.length > 0) {
    let chosen = memberRows[0]!;
    if (requestedOrganizationId !== undefined) {
      const match = memberRows.find(
        (m) => m.organizationId === requestedOrganizationId,
      );
      if (!match) {
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
      clerkUserId,
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
    clerkUserId,
  };
}

export async function tenantMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const auth = getAuth(req);
    if (!auth.userId) {
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
    req.tenant = await ensureTenant(auth.userId, requestedOrgId);
    next();
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 403) {
      res.status(403).json({ error: e.message });
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
  const rows = await db
    .select({ c: sql<string>`COUNT(*)` })
    .from(table)
    .where(
      and(eq(table.organizationId, organizationId), inArray(table.id, unique)),
    );
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

/**
 * Ensure none of the supplied item ids are "parent" items (items with
 * `hasVariants = true`). Parents can't appear on order/transfer/adjust
 * lines — clients must pick a leaf variant instead. Returns the names
 * of the offending parents (if any) so the API can produce a helpful
 * error message.
 */
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
