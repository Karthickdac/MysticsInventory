import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import {
  db,
  organizationsTable,
  organizationMembersTable,
  itemsTable,
  salesOrdersTable,
  usersTable,
} from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";

const router: IRouter = Router();

router.use("/admin", tenantMiddleware, (req, res, next) => {
  if (req.tenant?.isSuperAdmin) {
    next();
    return;
  }
  res.status(403).json({ error: "Super admin access required" });
});

router.get("/admin/organizations", async (_req, res, next) => {
  try {
    const memberCounts = db
      .select({
        organizationId: organizationMembersTable.organizationId,
        count: sql<number>`COUNT(*)::int`.as("member_count"),
      })
      .from(organizationMembersTable)
      .groupBy(organizationMembersTable.organizationId)
      .as("member_counts");

    const itemCounts = db
      .select({
        organizationId: itemsTable.organizationId,
        count: sql<number>`COUNT(*)::int`.as("item_count"),
      })
      .from(itemsTable)
      .groupBy(itemsTable.organizationId)
      .as("item_counts");

    const orderCounts = db
      .select({
        organizationId: salesOrdersTable.organizationId,
        count: sql<number>`COUNT(*)::int`.as("order_count"),
      })
      .from(salesOrdersTable)
      .groupBy(salesOrdersTable.organizationId)
      .as("order_counts");

    const rows = await db
      .select({
        id: organizationsTable.id,
        name: organizationsTable.name,
        slug: organizationsTable.slug,
        plan: organizationsTable.plan,
        subscriptionStatus: organizationsTable.subscriptionStatus,
        currency: organizationsTable.currency,
        gstNumber: organizationsTable.gstNumber,
        createdAt: organizationsTable.createdAt,
        trialEndsAt: organizationsTable.trialEndsAt,
        memberCount: sql<number>`COALESCE(${memberCounts.count}, 0)`,
        itemCount: sql<number>`COALESCE(${itemCounts.count}, 0)`,
        salesOrderCount: sql<number>`COALESCE(${orderCounts.count}, 0)`,
      })
      .from(organizationsTable)
      .leftJoin(
        memberCounts,
        eq(memberCounts.organizationId, organizationsTable.id),
      )
      .leftJoin(
        itemCounts,
        eq(itemCounts.organizationId, organizationsTable.id),
      )
      .leftJoin(
        orderCounts,
        eq(orderCounts.organizationId, organizationsTable.id),
      )
      .orderBy(organizationsTable.createdAt);

    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        plan: r.plan,
        subscriptionStatus: r.subscriptionStatus,
        currency: r.currency,
        gstNumber: r.gstNumber,
        createdAt: r.createdAt.toISOString(),
        trialEndsAt: r.trialEndsAt ? r.trialEndsAt.toISOString() : null,
        memberCount: Number(r.memberCount ?? 0),
        itemCount: Number(r.itemCount ?? 0),
        salesOrderCount: Number(r.salesOrderCount ?? 0),
      })),
    );
  } catch (err) {
    next(err);
  }
});

router.get("/admin/stats", async (_req, res, next) => {
  try {
    const [orgCount] = await db
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(organizationsTable);
    const [userCount] = await db
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(usersTable);
    const [orderCount] = await db
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(salesOrdersTable);
    res.json({
      organizationCount: Number(orgCount?.c ?? 0),
      userCount: Number(userCount?.c ?? 0),
      salesOrderCount: Number(orderCount?.c ?? 0),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
