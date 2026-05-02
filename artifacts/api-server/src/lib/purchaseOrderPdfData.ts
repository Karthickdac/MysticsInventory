import { and, asc, eq } from "drizzle-orm";
import {
  db,
  purchaseOrdersTable,
  purchaseOrderLinesTable,
  suppliersTable,
  warehousesTable,
  itemsTable,
} from "@workspace/db";
import { renderPurchaseOrderPdf } from "./purchaseOrderPdf";
import { loadOrgForPdf } from "./orgPdfHelpers";

export interface LoadedPurchaseOrderPdf {
  pdf: Buffer;
  orderNumber: string;
}

export async function loadPurchaseOrderPdf(
  organizationId: number,
  orderId: number,
): Promise<LoadedPurchaseOrderPdf | { notFound: true }> {
  const orderRows = await db
    .select({
      order: purchaseOrdersTable,
      supplier: suppliersTable,
      warehouse: warehousesTable,
    })
    .from(purchaseOrdersTable)
    .innerJoin(
      suppliersTable,
      eq(suppliersTable.id, purchaseOrdersTable.supplierId),
    )
    .innerJoin(
      warehousesTable,
      eq(warehousesTable.id, purchaseOrdersTable.warehouseId),
    )
    .where(
      and(
        eq(purchaseOrdersTable.id, orderId),
        eq(purchaseOrdersTable.organizationId, organizationId),
      ),
    )
    .limit(1);
  const head = orderRows[0];
  if (!head) return { notFound: true };

  const orgBundle = await loadOrgForPdf(organizationId);
  if (!orgBundle) return { notFound: true };

  const lineRows = await db
    .select({
      line: purchaseOrderLinesTable,
      itemName: itemsTable.name,
      sku: itemsTable.sku,
      hsnCode: itemsTable.hsnCode,
    })
    .from(purchaseOrderLinesTable)
    .innerJoin(itemsTable, eq(itemsTable.id, purchaseOrderLinesTable.itemId))
    .where(eq(purchaseOrderLinesTable.purchaseOrderId, orderId))
    .orderBy(asc(purchaseOrderLinesTable.id));

  const pdf = await renderPurchaseOrderPdf({
    org: orgBundle.docOrg,
    logoBuffer: orgBundle.logoBuffer,
    supplier: {
      name: head.supplier.name,
      company: head.supplier.company,
      email: head.supplier.email,
      phone: head.supplier.phone,
      gstNumber: head.supplier.gstNumber,
      address: head.supplier.address,
    },
    shipTo: {
      name: head.warehouse.name,
      addressLine1: head.warehouse.addressLine1,
      city: head.warehouse.city,
      state: head.warehouse.state,
      country: head.warehouse.country,
    },
    order: {
      orderNumber: head.order.orderNumber,
      status: head.order.status,
      orderDate: head.order.orderDate,
      expectedDeliveryDate: head.order.expectedDeliveryDate,
      notes: head.order.notes,
      subtotal: head.order.subtotal,
      taxTotal: head.order.taxTotal,
      total: head.order.total,
    },
    lines: lineRows.map((r) => ({
      itemName: r.itemName,
      sku: r.sku,
      description: r.line.description,
      hsnCode: r.hsnCode,
      quantity: r.line.quantity,
      unitPrice: r.line.unitPrice,
      taxRate: r.line.taxRate,
      lineSubtotal: r.line.lineSubtotal,
      lineTax: r.line.lineTax,
      lineTotal: r.line.lineTotal,
    })),
  });

  return { pdf, orderNumber: head.order.orderNumber };
}
