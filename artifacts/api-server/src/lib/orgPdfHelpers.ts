// Shared "load the org row + its logo buffer" helper used by every
// new PDF endpoint. Returns the bits the design system needs (DocOrg)
// plus the logo bytes (or null when no logo is configured / fetch
// failed).

import { eq } from "drizzle-orm";
import { db, organizationsTable, type Organization } from "@workspace/db";
import { fetchLogoBuffer } from "./orgLogo";
import type { DocOrg } from "./pdfDesign";

export interface OrgForPdf {
  org: Organization;
  docOrg: DocOrg;
  logoBuffer: Buffer | null;
}

export async function loadOrgForPdf(
  organizationId: number,
): Promise<OrgForPdf | null> {
  const rows = await db
    .select()
    .from(organizationsTable)
    .where(eq(organizationsTable.id, organizationId))
    .limit(1);
  const org = rows[0];
  if (!org) return null;
  const logoBuffer = await fetchLogoBuffer(org.logoUrl, organizationId);
  return {
    org,
    docOrg: {
      name: org.name,
      gstNumber: org.gstNumber,
      addressLine1: org.addressLine1,
      addressLine2: org.addressLine2,
      city: org.city,
      state: org.state,
      postalCode: org.postalCode,
      country: org.country,
      logoUrl: org.logoUrl,
      invoiceFooter: org.invoiceFooter,
    },
    logoBuffer,
  };
}
