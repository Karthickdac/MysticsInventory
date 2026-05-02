import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, organizationsTable, shipmentsTable } from "@workspace/db";
import {
  getShiprocketTracking,
  normalizeShiprocketStatus,
  ShiprocketNotConnectedError,
  ShiprocketTokenExpiredError,
} from "./shiprocket";
import { logger } from "./logger";

export interface SyncResult {
  updated: number;
  skipped: number;
  failed: number;
  syncedAt: Date;
  /**
   * Set when the org is unreachable for auth reasons (no creds on
   * file, or stored creds rejected by Shiprocket). Callers can use
   * this to surface a "please reconnect" message.
   */
  authError?: "not_connected" | "token_expired";
}

/**
 * Refresh the tracking status of every active shipment for one
 * organization by hitting Shiprocket's tracking endpoint per AWB.
 *
 * Skips shipments that have already reached a terminal state
 * (delivered / rto / cancelled) so the work each run shrinks over
 * time. Aborts on token-expired so a stale connection doesn't
 * generate hundreds of failing calls.
 *
 * Pure server-side helper — does NOT consult any HTTP request
 * context. Safe to call from a route handler OR an unattended
 * scheduler.
 */
export async function syncShiprocketTrackingForOrg(
  organizationId: number,
): Promise<SyncResult> {
  const rows = await db
    .select({
      id: shipmentsTable.id,
      awb: shipmentsTable.awb,
    })
    .from(shipmentsTable)
    .where(
      and(
        eq(shipmentsTable.organizationId, organizationId),
        isNotNull(shipmentsTable.awb),
        sql`(${shipmentsTable.trackingStatus} IS NULL OR ${shipmentsTable.trackingStatus} NOT IN ('delivered','rto','cancelled'))`,
      ),
    );

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  for (const s of rows) {
    if (!s.awb) {
      skipped += 1;
      continue;
    }
    try {
      const tr = await getShiprocketTracking(organizationId, s.awb);
      const latest = tr.tracking_data?.shipment_track?.[0]?.current_status;
      const next = normalizeShiprocketStatus(latest);
      const courier = tr.tracking_data?.shipment_track?.[0]?.courier_name;
      await db
        .update(shipmentsTable)
        .set({
          trackingStatus: next,
          lastTrackedAt: new Date(),
          ...(courier ? { courierName: courier } : {}),
          ...(tr.tracking_data?.track_url
            ? { trackingUrl: tr.tracking_data.track_url }
            : {}),
        })
        .where(
          and(
            eq(shipmentsTable.organizationId, organizationId),
            eq(shipmentsTable.id, s.id),
          ),
        );
      updated += 1;
    } catch (err) {
      if (err instanceof ShiprocketTokenExpiredError) {
        const syncedAt = new Date();
        return { updated, skipped, failed, syncedAt, authError: "token_expired" };
      }
      if (err instanceof ShiprocketNotConnectedError) {
        const syncedAt = new Date();
        return { updated, skipped, failed, syncedAt, authError: "not_connected" };
      }
      logger.warn(
        { orgId: organizationId, shipmentId: s.id, err },
        "shiprocket: tracking sync failed for one shipment",
      );
      failed += 1;
    }
  }

  const syncedAt = new Date();
  await db
    .update(organizationsTable)
    .set({ shiprocketLastSyncedAt: syncedAt })
    .where(eq(organizationsTable.id, organizationId));

  return { updated, skipped, failed, syncedAt };
}

/**
 * Run the per-org sync for every organization that currently has
 * Shiprocket credentials on file. Errors in one org never abort the
 * sweep for the others. Returns a per-org map of results so the
 * scheduler can log a single summary line.
 */
export async function syncShiprocketTrackingAllOrgs(): Promise<
  Array<{ organizationId: number; result: SyncResult }>
> {
  // Sweep every org that currently has a cached Shiprocket token.
  // Orgs whose token has expired will be picked up by the per-org
  // helper, which records the token_expired auth error so admins can
  // see exactly which connections need a manual reconnect.
  const orgs = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable)
    .where(
      and(
        isNotNull(organizationsTable.shiprocketEmail),
        isNotNull(organizationsTable.shiprocketTokenEncrypted),
      ),
    );
  const results: Array<{ organizationId: number; result: SyncResult }> = [];
  for (const o of orgs) {
    try {
      const result = await syncShiprocketTrackingForOrg(o.id);
      results.push({ organizationId: o.id, result });
    } catch (err) {
      logger.error(
        { orgId: o.id, err },
        "shiprocket: scheduled sync failed for org (continuing with next org)",
      );
    }
  }
  return results;
}

let schedulerHandle: NodeJS.Timeout | null = null;
let initialDelayHandle: NodeJS.Timeout | null = null;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Register a recurring background timer that calls
 * syncShiprocketTrackingAllOrgs once per day. Safe to call multiple
 * times — only the first call wires the timer.
 *
 * Disabled when SHIPROCKET_SYNC_DISABLED is "1"/"true" (useful for
 * tests and ad-hoc dev runs). The first run is delayed by
 * SHIPROCKET_SYNC_INITIAL_DELAY_MS (default 5 minutes after boot) so
 * the server has a chance to settle and so multiple in-flight
 * deploys don't all hammer Shiprocket at the same instant.
 */
export function startShiprocketSyncScheduler(): void {
  if (schedulerHandle) return;
  const disabled =
    process.env["SHIPROCKET_SYNC_DISABLED"] === "1" ||
    process.env["SHIPROCKET_SYNC_DISABLED"] === "true";
  if (disabled) {
    logger.info("shiprocket: scheduler disabled via SHIPROCKET_SYNC_DISABLED");
    return;
  }
  const initialDelayMs =
    Number(process.env["SHIPROCKET_SYNC_INITIAL_DELAY_MS"]) || 5 * 60 * 1000;
  const intervalMs = Number(process.env["SHIPROCKET_SYNC_INTERVAL_MS"]) || DAY_MS;

  const run = async () => {
    const t0 = Date.now();
    try {
      const results = await syncShiprocketTrackingAllOrgs();
      const totals = results.reduce(
        (a, r) => ({
          orgs: a.orgs + 1,
          updated: a.updated + r.result.updated,
          failed: a.failed + r.result.failed,
          authErrors:
            a.authErrors + (r.result.authError ? 1 : 0),
        }),
        { orgs: 0, updated: 0, failed: 0, authErrors: 0 },
      );
      logger.info(
        { ...totals, durationMs: Date.now() - t0 },
        "shiprocket: scheduled tracking sync complete",
      );
    } catch (err) {
      logger.error(
        { err, durationMs: Date.now() - t0 },
        "shiprocket: scheduled tracking sweep crashed",
      );
    }
  };

  initialDelayHandle = setTimeout(() => {
    initialDelayHandle = null;
    void run();
    schedulerHandle = setInterval(() => {
      void run();
    }, intervalMs);
    if (typeof schedulerHandle.unref === "function") {
      // Don't keep the event loop alive solely on the scheduler so
      // process.exit / SIGTERM can shut down cleanly.
      schedulerHandle.unref();
    }
  }, initialDelayMs);
  // Same reason as above — the initial-delay timer must not block
  // process exit either, e.g. for short-lived test processes.
  if (initialDelayHandle && typeof initialDelayHandle.unref === "function") {
    initialDelayHandle.unref();
  }
  logger.info(
    { initialDelayMs, intervalMs },
    "shiprocket: tracking sync scheduler armed",
  );
}

export function stopShiprocketSyncScheduler(): void {
  if (initialDelayHandle) {
    clearTimeout(initialDelayHandle);
    initialDelayHandle = null;
  }
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
}
