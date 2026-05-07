import { and, eq } from "drizzle-orm";
import { db, customersTable } from "@workspace/db";

const WALK_IN_NAME = "Walk-in Customer";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Look up — or, on first POS sale, create — the per-org "Walk-in
 * Customer" row. Sales orders require a customerId (FK constraint), so
 * the POS can't sell to "no one"; instead every org gets a single
 * dedicated walk-in row that anonymous tender hits.
 *
 * Safe to call inside a transaction. The lookup is org-scoped + name
 * exact-match so a real customer happening to be named "Walk-in
 * Customer" is still respected (we'd just reuse their row).
 */
export async function getOrCreateWalkInCustomerId(
  tx: Tx | typeof db,
  organizationId: number,
): Promise<number> {
  const existing = await tx
    .select({ id: customersTable.id })
    .from(customersTable)
    .where(
      and(
        eq(customersTable.organizationId, organizationId),
        eq(customersTable.name, WALK_IN_NAME),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0].id;
  const inserted = await tx
    .insert(customersTable)
    .values({
      organizationId,
      name: WALK_IN_NAME,
      notes: "Auto-created for POS walk-in sales",
    })
    .returning({ id: customersTable.id });
  return inserted[0]!.id;
}

export const WALK_IN_CUSTOMER_NAME = WALK_IN_NAME;
