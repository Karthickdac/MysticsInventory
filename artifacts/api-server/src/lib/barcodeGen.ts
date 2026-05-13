import { and, eq, sql } from "drizzle-orm";
import { db, itemsTable, organizationsTable } from "@workspace/db";

/**
 * The bits of a Drizzle DB / transaction handle we use here. Accepting
 * an executor lets callers pass a `tx` so generation can see rows
 * inserted earlier in the same transaction (critical for bulk-import
 * which auto-generates several barcodes back-to-back inside one txn).
 */
type Executor = Pick<typeof db, "select" | "execute">;

/**
 * Per-org barcode auto-generation. Produces stable, unique values of
 * the form `<PREFIX><PADDED_SEQUENCE>` where the sequence is the
 * highest existing numeric tail for that prefix + 1, scoped to the
 * organization. Falls back to a random suffix on the rare case of a
 * unique-index collision (concurrent inserts).
 *
 * The prefix comes from `organizations.barcode_prefix`; if missing or
 * empty, we derive a sensible default from the org slug (uppercased,
 * non-alphanum stripped, capped at 4 chars). Total value length is
 * always within the 64-char items.barcode column limit.
 */

const SEQUENCE_DIGITS = 8;
const MAX_PREFIX_LEN = 8;
const MAX_BARCODE_LEN = 64;
const MAX_RETRIES = 5;

export function sanitizePrefix(raw: string | null | undefined): string {
  if (!raw) return "";
  return String(raw)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, MAX_PREFIX_LEN);
}

export function defaultPrefixFromSlug(slug: string): string {
  return sanitizePrefix(slug).slice(0, 4) || "ITM";
}

/**
 * Resolve the active prefix for an organization (configured value
 * winning over the slug-derived default). Cached at the call site is
 * fine — values are tiny.
 */
export async function getEffectivePrefix(
  orgId: number,
  executor: Executor = db,
): Promise<string> {
  const rows = await executor
    .select({
      prefix: organizationsTable.barcodePrefix,
      slug: organizationsTable.slug,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId)) // org-scope-allow: PK lookup of own org row
    .limit(1);
  const row = rows[0];
  if (!row) return "ITM";
  const configured = sanitizePrefix(row.prefix);
  return configured || defaultPrefixFromSlug(row.slug);
}

function buildValue(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(SEQUENCE_DIGITS, "0")}`;
}

/**
 * Generate the next barcode value for an org. The caller must use the
 * returned value within the same transaction to insert/update an item
 * row — the generator is free of side effects, so concurrent callers
 * can race. We mitigate that with the unique index + retry-on-collision
 * loop in `generateUniqueBarcode`.
 */
export async function nextSequenceValue(
  orgId: number,
  executor: Executor = db,
): Promise<{
  prefix: string;
  value: string;
  next: number;
}> {
  const prefix = await getEffectivePrefix(orgId, executor);
  // Find the highest existing numeric suffix for this prefix among
  // active rows in the same org. Anchored regex so a longer prefix
  // sharing a leading substring (e.g. "MY" vs "MYS") doesn't bleed.
  // Note: an empty prefix is theoretically possible but `getEffectivePrefix`
  // always returns at least "ITM", so the regex is safe to anchor.
  const pattern = `^${prefix}([0-9]+)$`;
  const rows = await executor.execute(
    sql`
      SELECT COALESCE(MAX((substring(barcode FROM ${pattern}))::bigint), 0) AS max_seq
      FROM items
      WHERE organization_id = ${orgId}
        AND archived_at IS NULL
        AND barcode ~ ${pattern}
    `,
  );
  const r = (rows.rows ?? rows) as Array<{ max_seq: string | number | null }>;
  const max = r[0]?.max_seq;
  const current = max == null ? 0 : Number(max);
  const next = (Number.isFinite(current) ? current : 0) + 1;
  return { prefix, value: buildValue(prefix, next), next };
}

/**
 * Generate a unique barcode for an org, accounting for races. On
 * collision (extremely unlikely with the per-org partial unique
 * index), retry by polling for the new max and bumping again. After
 * MAX_RETRIES we append a short random suffix to break the deadlock —
 * this preserves the prefix for label scanability and keeps the value
 * within the 64-char column.
 *
 * The function does NOT insert anything; the caller persists the
 * value as part of its own transaction so a downstream failure
 * doesn't burn a sequence number permanently.
 */
export async function generateUniqueBarcode(
  orgId: number,
  executor: Executor = db,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { value } = await nextSequenceValue(orgId, executor);
    if (value.length > MAX_BARCODE_LEN) {
      // Shouldn't happen with current digit count + prefix cap, but
      // guard anyway so we never emit a truncated, non-unique value.
      throw new Error("Generated barcode exceeds max length");
    }
    const collision = await executor
      .select({ id: itemsTable.id })
      .from(itemsTable)
      .where(
        and(
          eq(itemsTable.organizationId, orgId),
          eq(itemsTable.barcode, value),
          sql`${itemsTable.archivedAt} IS NULL`,
        ),
      )
      .limit(1);
    if (collision.length === 0) return value;
  }
  // Fall back to a randomized suffix that still carries the prefix so
  // scanned labels remain visually associated with the org.
  const prefix = await getEffectivePrefix(orgId, executor);
  const rand = Math.floor(Math.random() * 1_000_000_000)
    .toString()
    .padStart(9, "0");
  return `${prefix}-${rand}`.slice(0, MAX_BARCODE_LEN);
}

/**
 * Look up which item already owns a given barcode in the org (used to
 * build a friendly 409 message). Returns null when free.
 */
export async function findBarcodeOwner(
  orgId: number,
  barcode: string,
  excludeItemId?: number,
): Promise<{ id: number; sku: string; name: string } | null> {
  const rows = await db
    .select({
      id: itemsTable.id,
      sku: itemsTable.sku,
      name: itemsTable.name,
    })
    .from(itemsTable)
    .where(
      and(
        eq(itemsTable.organizationId, orgId),
        eq(itemsTable.barcode, barcode),
        sql`${itemsTable.archivedAt} IS NULL`,
      ),
    )
    .limit(2);
  for (const r of rows) {
    if (excludeItemId !== undefined && r.id === excludeItemId) continue;
    return r;
  }
  return null;
}

/**
 * Recognise a Postgres unique-violation surfaced by the partial
 * `items_org_barcode_unique_idx` so route handlers can translate it
 * into a 409 with a useful hint.
 */
export function isBarcodeUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | undefined;
  if (!e || e.code !== "23505") return false;
  return (e.constraint ?? "").includes("items_org_barcode_unique_idx");
}
