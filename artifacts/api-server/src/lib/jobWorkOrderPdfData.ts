import { and, asc, eq } from "drizzle-orm";
import {
  db,
  jobWorkOrdersTable,
  jobWorkOrderComponentsTable,
  suppliersTable,
  warehousesTable,
  itemsTable,
} from "@workspace/db";
import { renderJwoOrderPdf } from "./jobWorkOrderPdf";
import { loadOrgForPdf } from "./orgPdfHelpers";
import { toNum } from "./numeric";

export interface LoadedJwoOrderPdf {
  pdf: Buffer;
  jwoNumber: string;
}

export async function loadJwoOrderPdf(
  organizationId: number,
  jobWorkOrderId: number,
): Promise<LoadedJwoOrderPdf | { notFound: true }> {
  const head = await db
    .select({
      jwo: jobWorkOrdersTable,
      supplier: suppliersTable,
      sourceWarehouse: warehousesTable,
      output: itemsTable,
    })
    .from(jobWorkOrdersTable)
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
        eq(jobWorkOrdersTable.id, jobWorkOrderId),
        eq(jobWorkOrdersTable.organizationId, organizationId),
      ),
    )
    .limit(1);
  const row = head[0];
  if (!row) return { notFound: true };

  const destWarehouseRows = await db
    .select({ id: warehousesTable.id, name: warehousesTable.name, code: warehousesTable.code, addressLine1: warehousesTable.addressLine1, city: warehousesTable.city, state: warehousesTable.state, country: warehousesTable.country })
    .from(warehousesTable)
    .where(
      and(
        eq(warehousesTable.organizationId, organizationId),
        eq(warehousesTable.id, row.jwo.destWarehouseId),
      ),
    )
    .limit(1);
  const destWarehouse = destWarehouseRows[0];

  const orgBundle = await loadOrgForPdf(organizationId);
  if (!orgBundle) return { notFound: true };

  const componentRows = await db
    .select({
      comp: jobWorkOrderComponentsTable,
      itemName: itemsTable.name,
      sku: itemsTable.sku,
    })
    .from(jobWorkOrderComponentsTable)
    .innerJoin(
      itemsTable,
      eq(itemsTable.id, jobWorkOrderComponentsTable.componentItemId),
    )
    .where(
      and(
        eq(jobWorkOrderComponentsTable.organizationId, organizationId),
        eq(jobWorkOrderComponentsTable.jobWorkOrderId, jobWorkOrderId),
      ),
    )
    .orderBy(asc(jobWorkOrderComponentsTable.id));

  const pdf = await renderJwoOrderPdf({
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
    sourceWarehouse: {
      name: row.sourceWarehouse.name,
      code: row.sourceWarehouse.code,
      addressLine1: row.sourceWarehouse.addressLine1,
      city: row.sourceWarehouse.city,
      state: row.sourceWarehouse.state,
      country: row.sourceWarehouse.country,
    },
    destWarehouse: destWarehouse
      ? {
          name: destWarehouse.name,
          code: destWarehouse.code,
          addressLine1: destWarehouse.addressLine1,
          city: destWarehouse.city,
          state: destWarehouse.state,
          country: destWarehouse.country,
        }
      : {
          name: "—",
          code: null,
          addressLine1: null,
          city: null,
          state: null,
          country: null,
        },
    jwo: {
      jwoNumber: row.jwo.jwoNumber,
      outputItemName: row.output.name,
      outputItemSku: row.output.sku,
      outputQuantity: toNum(row.jwo.outputQuantity),
      jobChargeRate: toNum(row.jwo.jobChargeRate),
      status: row.jwo.status,
      createdAt: row.jwo.createdAt.toISOString(),
      expectedReturnDate: row.jwo.expectedReturnDate ?? null,
      notes: row.jwo.notes ?? null,
    },
    components: componentRows.map((r) => ({
      itemName: r.itemName,
      sku: r.sku,
      quantityPerOutput: r.comp.quantityPerOutput,
      totalQuantity: r.comp.totalQuantity,
    })),
  });

  return {
    pdf,
    jwoNumber: row.jwo.jwoNumber,
  };
}
