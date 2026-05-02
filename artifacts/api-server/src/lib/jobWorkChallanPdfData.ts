import { and, asc, eq } from "drizzle-orm";
import {
  db,
  jobWorkOrdersTable,
  jobWorkIssuesTable,
  jobWorkIssueLinesTable,
  suppliersTable,
  warehousesTable,
  itemsTable,
} from "@workspace/db";
import { renderJwoChallanPdf } from "./jobWorkChallanPdf";
import { loadOrgForPdf } from "./orgPdfHelpers";

export interface LoadedJwoChallanPdf {
  pdf: Buffer;
  issueNumber: string;
  jwoNumber: string;
}

export async function loadJwoChallanPdf(
  organizationId: number,
  jobWorkOrderId: number,
  issueId: number,
): Promise<LoadedJwoChallanPdf | { notFound: true }> {
  const head = await db
    .select({
      jwo: jobWorkOrdersTable,
      issue: jobWorkIssuesTable,
      supplier: suppliersTable,
      sourceWarehouse: warehousesTable,
      output: itemsTable,
    })
    .from(jobWorkIssuesTable)
    .innerJoin(
      jobWorkOrdersTable,
      eq(jobWorkOrdersTable.id, jobWorkIssuesTable.jobWorkOrderId),
    )
    .innerJoin(
      suppliersTable,
      eq(suppliersTable.id, jobWorkOrdersTable.supplierId),
    )
    .innerJoin(
      warehousesTable,
      eq(warehousesTable.id, jobWorkOrdersTable.sourceWarehouseId),
    )
    .innerJoin(itemsTable, eq(itemsTable.id, jobWorkOrdersTable.outputItemId))
    .where(
      and(
        eq(jobWorkIssuesTable.id, issueId),
        eq(jobWorkIssuesTable.organizationId, organizationId),
        eq(jobWorkIssuesTable.jobWorkOrderId, jobWorkOrderId),
      ),
    )
    .limit(1);
  const row = head[0];
  if (!row) return { notFound: true };

  const orgBundle = await loadOrgForPdf(organizationId);
  if (!orgBundle) return { notFound: true };

  const componentRows = await db
    .select({
      line: jobWorkIssueLinesTable,
      itemName: itemsTable.name,
      sku: itemsTable.sku,
    })
    .from(jobWorkIssueLinesTable)
    .innerJoin(
      itemsTable,
      eq(itemsTable.id, jobWorkIssueLinesTable.componentItemId),
    )
    .where(
      and(
        eq(jobWorkIssueLinesTable.organizationId, organizationId),
        eq(jobWorkIssueLinesTable.jobWorkIssueId, issueId),
      ),
    )
    .orderBy(asc(jobWorkIssueLinesTable.id));

  const pdf = await renderJwoChallanPdf({
    org: orgBundle.docOrg,
    logoBuffer: orgBundle.logoBuffer,
    jobWorker: {
      name: row.supplier.name,
      company: row.supplier.company,
      email: row.supplier.email,
      phone: row.supplier.phone,
      gstNumber: row.supplier.gstNumber,
      address: row.supplier.address,
    },
    fromWarehouse: {
      name: row.sourceWarehouse.name,
      code: row.sourceWarehouse.code,
      addressLine1: row.sourceWarehouse.addressLine1,
      city: row.sourceWarehouse.city,
      state: row.sourceWarehouse.state,
      country: row.sourceWarehouse.country,
    },
    jwo: {
      jwoNumber: row.jwo.jwoNumber,
      outputItemName: row.output.name,
      outputItemSku: row.output.sku,
    },
    issue: {
      issueNumber: row.issue.issueNumber,
      issueDate: row.issue.issueDate,
      notes: row.issue.notes,
    },
    components: componentRows.map((r) => ({
      itemName: r.itemName,
      sku: r.sku,
      quantity: r.line.quantity,
    })),
  });

  return {
    pdf,
    issueNumber: row.issue.issueNumber,
    jwoNumber: row.jwo.jwoNumber,
  };
}
