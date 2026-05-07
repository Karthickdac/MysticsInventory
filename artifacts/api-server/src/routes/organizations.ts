import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, organizationsTable } from "@workspace/db";
import { tenantMiddleware } from "../lib/tenant";
import { serializeOrganization } from "../lib/serializers";
import {
  ObjectStorageService,
  ObjectNotFoundError,
} from "../lib/objectStorage";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

const ORG_LOGO_OWNER_PREFIX = "org:";

/**
 * Claim ownership of a freshly-uploaded logo object for this organization.
 *
 * Returns the normalized object path on success. Throws if the object is
 * already owned by a different organization (prevents one tenant from
 * pointing at another tenant's stored object).
 */
async function claimOrgLogoObject(
  rawPath: string,
  organizationId: number,
): Promise<string> {
  const normalized = objectStorageService.normalizeObjectEntityPath(rawPath);
  if (!normalized.startsWith("/objects/")) {
    return normalized;
  }
  const obj = await objectStorageService.getObjectEntityFile(normalized);
  const expectedOwner = `${ORG_LOGO_OWNER_PREFIX}${organizationId}`;
  const existing = await objectStorageService.getAclPolicy(obj);
  if (existing && existing.owner && existing.owner !== expectedOwner) {
    const err = new Error("Logo object belongs to a different organization");
    (err as { status?: number }).status = 403;
    throw err;
  }
  if (!existing || existing.owner !== expectedOwner) {
    await objectStorageService.setAclPolicy(obj, {
      owner: expectedOwner,
      visibility: "public",
    });
  }
  return normalized;
}

router.use(tenantMiddleware);

router.get("/organizations/current", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const rows = await db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, t.organizationId))
      .limit(1);
    res.json(serializeOrganization(rows[0]!));
  } catch (err) {
    next(err);
  }
});

router.patch("/organizations/current", async (req, res, next) => {
  try {
    const t = req.tenant!;
    const body = req.body ?? {};
    const updates: Record<string, unknown> = {};
    for (const k of [
      "name",
      "currency",
      "timezone",
      "gstNumber",
      "addressLine1",
      "addressLine2",
      "city",
      "state",
      "postalCode",
      "country",
      "logoUrl",
      "invoiceFooter",
    ]) {
      if (k in body) updates[k] = body[k];
    }
    // Tenant-isolation guard for uploaded logos: any /objects/... path that the
    // admin sets here must either be unowned (a fresh upload) or already owned
    // by this org. Pointing logoUrl at another tenant's object is rejected.
    if (typeof updates.logoUrl === "string" && updates.logoUrl.length > 0) {
      const candidate = updates.logoUrl;
      try {
        if (candidate.startsWith("/objects/")) {
          updates.logoUrl = await claimOrgLogoObject(
            candidate,
            t.organizationId,
          );
        }
      } catch (err) {
        if (err instanceof ObjectNotFoundError) {
          res.status(400).json({ error: "Uploaded logo not found in storage" });
          return;
        }
        const status = (err as { status?: number }).status;
        if (status === 403) {
          res.status(403).json({
            error: "That logo image belongs to another workspace.",
          });
          return;
        }
        throw err;
      }
    }
    const updated = await db
      .update(organizationsTable)
      .set(updates)
      .where(eq(organizationsTable.id, t.organizationId))
      .returning();
    res.json(serializeOrganization(updated[0]!));
  } catch (err) {
    next(err);
  }
});

export default router;
