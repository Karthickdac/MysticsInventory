import { and, asc, eq, sql } from "drizzle-orm";
import {
  db,
  stockTransfersTable,
  stockTransferLinesTable,
  warehousesTable,
  itemsTable,
} from "@workspace/db";
import { renderStockTransferPdf } from "./stockTransferPdf";
import { loadOrgForPdf } from "./orgPdfHelpers";

export interface LoadedStockTransferPdf {
  pdf: Buffer;
  transferNumber: string;
}

const FROM_WH = "from_wh";
const TO_WH = "to_wh";

export async function loadStockTransferPdf(
  organizationId: number,
  transferId: number,
): Promise<LoadedStockTransferPdf | { notFound: true }> {
  const rows = await db
    .select({
      transfer: stockTransfersTable,
      fromName: sql<string>`${sql.identifier(FROM_WH)}.name`,
      fromCode: sql<string | null>`${sql.identifier(FROM_WH)}.code`,
      fromAddress1: sql<string | null>`${sql.identifier(FROM_WH)}.address_line1`,
      fromCity: sql<string | null>`${sql.identifier(FROM_WH)}.city`,
      fromState: sql<string | null>`${sql.identifier(FROM_WH)}.state`,
      fromCountry: sql<string | null>`${sql.identifier(FROM_WH)}.country`,
      toName: sql<string>`${sql.identifier(TO_WH)}.name`,
      toCode: sql<string | null>`${sql.identifier(TO_WH)}.code`,
      toAddress1: sql<string | null>`${sql.identifier(TO_WH)}.address_line1`,
      toCity: sql<string | null>`${sql.identifier(TO_WH)}.city`,
      toState: sql<string | null>`${sql.identifier(TO_WH)}.state`,
      toCountry: sql<string | null>`${sql.identifier(TO_WH)}.country`,
    })
    .from(stockTransfersTable)
    .innerJoin(
      sql`${warehousesTable} AS ${sql.identifier(FROM_WH)}`,
      sql`${sql.identifier(FROM_WH)}.id = ${stockTransfersTable.fromWarehouseId}`,
    )
    .innerJoin(
      sql`${warehousesTable} AS ${sql.identifier(TO_WH)}`,
      sql`${sql.identifier(TO_WH)}.id = ${stockTransfersTable.toWarehouseId}`,
    )
    .where(
      and(
        eq(stockTransfersTable.id, transferId),
        eq(stockTransfersTable.organizationId, organizationId),
      ),
    )
    .limit(1);
  const head = rows[0];
  if (!head) return { notFound: true };

  const orgBundle = await loadOrgForPdf(organizationId);
  if (!orgBundle) return { notFound: true };

  const lineRows = await db
    .select({
      line: stockTransferLinesTable,
      itemName: itemsTable.name,
      sku: itemsTable.sku,
      variantOptions: itemsTable.variantOptions,
    })
    .from(stockTransferLinesTable)
    .innerJoin(itemsTable, eq(itemsTable.id, stockTransferLinesTable.itemId))
    .where(
      and(
        eq(stockTransferLinesTable.organizationId, organizationId),
        eq(stockTransferLinesTable.stockTransferId, transferId),
      ),
    )
    .orderBy(asc(stockTransferLinesTable.id));

  const pdf = await renderStockTransferPdf({
    org: orgBundle.docOrg,
    logoBuffer: orgBundle.logoBuffer,
    transfer: {
      transferNumber: head.transfer.transferNumber,
      transferDate: head.transfer.transferDate,
      status: head.transfer.status,
      notes: head.transfer.notes,
    },
    fromWarehouse: {
      name: head.fromName,
      code: head.fromCode,
      addressLine1: head.fromAddress1,
      city: head.fromCity,
      state: head.fromState,
      country: head.fromCountry,
    },
    toWarehouse: {
      name: head.toName,
      code: head.toCode,
      addressLine1: head.toAddress1,
      city: head.toCity,
      state: head.toState,
      country: head.toCountry,
    },
    lines: lineRows.map((r) => ({
      itemName: r.itemName,
      sku: r.sku,
      variantOptions:
        (r.variantOptions as Record<string, string> | null) ?? null,
      quantity: r.line.quantity,
    })),
  });

  return { pdf, transferNumber: head.transfer.transferNumber };
}
