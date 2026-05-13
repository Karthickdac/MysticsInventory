import type {
  Organization,
  Warehouse,
  Item,
  ItemBatch,
  Customer,
  Supplier,
  StockMovement,
  SalesOrder,
  SalesOrderLine,
  PurchaseOrder,
  PurchaseOrderLine,
  CustomerPayment,
  CustomerPaymentAllocation,
  SupplierPayment,
  SupplierPaymentAllocation,
  Shipment,
  ShipmentLine,
  GoodsReceipt,
  GoodsReceiptLine,
  StockTransfer,
  StockTransferLine,
  EmailLog,
  PaymentLink,
} from "@workspace/db";
import { toNum } from "./numeric";

export function serializeOrganization(o: Organization) {
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    currency: o.currency,
    timezone: o.timezone,
    gstNumber: o.gstNumber,
    addressLine1: o.addressLine1,
    addressLine2: o.addressLine2,
    city: o.city,
    state: o.state,
    postalCode: o.postalCode,
    country: o.country,
    logoUrl: o.logoUrl,
    invoiceFooter: o.invoiceFooter,
    plan: o.plan,
    subscriptionStatus: o.subscriptionStatus,
    currentPeriodEnd: o.currentPeriodEnd ? o.currentPeriodEnd.toISOString() : null,
    onboardingCompletedAt: o.onboardingCompletedAt
      ? o.onboardingCompletedAt.toISOString()
      : null,
    barcodePrefix:
      (o as unknown as { barcodePrefix?: string | null }).barcodePrefix ?? null,
    barcodeFormat:
      (o as unknown as { barcodeFormat?: string | null }).barcodeFormat ??
      "code128",
    createdAt: o.createdAt.toISOString(),
  };
}

export function serializeWarehouse(w: Warehouse & { isVirtual?: boolean | null; jobWorkerSupplierId?: number | null }) {
  return {
    id: w.id,
    name: w.name,
    code: w.code,
    addressLine1: w.addressLine1,
    city: w.city,
    state: w.state,
    country: w.country,
    isDefault: w.isDefault,
    isVirtual: w.isVirtual ?? false,
    jobWorkerSupplierId: w.jobWorkerSupplierId ?? null,
    shopifyLocationId: w.shopifyLocationId,
    shopifyLocationName: w.shopifyLocationName,
    createdAt: w.createdAt.toISOString(),
  };
}

export function serializeItem(
  i: Item,
  totalStock: number | string = 0,
  stockAtWarehouse?: number | string,
  variantCount?: number,
  warehouseStock?: Array<{
    warehouseId: number;
    warehouseName: string;
    quantity: number | string;
  }> | null,
) {
  return {
    id: i.id,
    sku: i.sku,
    name: i.name,
    description: i.description,
    category: i.category,
    unit: i.unit,
    salePrice: toNum(i.salePrice),
    purchasePrice: toNum(i.purchasePrice),
    hsnCode: i.hsnCode,
    barcode: i.barcode,
    barcodeSource: ((i as unknown as { barcodeSource?: string | null })
      .barcodeSource ?? null) as "auto" | "manual" | null,
    taxRate: toNum(i.taxRate),
    reorderLevel: toNum(i.reorderLevel),
    totalStock: toNum(totalStock),
    stockAtWarehouse:
      stockAtWarehouse === undefined ? null : toNum(stockAtWarehouse),
    warehouseStock:
      warehouseStock === undefined || warehouseStock === null
        ? null
        : warehouseStock.map((w) => ({
            warehouseId: w.warehouseId,
            warehouseName: w.warehouseName,
            quantity: toNum(w.quantity),
          })),
    imageUrl: i.imageUrl,
    parentItemId: i.parentItemId ?? null,
    hasVariants: i.hasVariants,
    isBundle: i.isBundle,
    trackBatches: i.trackBatches,
    variantOptions: (i.variantOptions ?? null) as Record<string, unknown> | null,
    variantCount: variantCount ?? 0,
    createdAt: i.createdAt.toISOString(),
  };
}

export function serializeItemBatch(b: ItemBatch) {
  return {
    id: b.id,
    itemId: b.itemId,
    batchNumber: b.batchNumber,
    mfgDate: b.mfgDate,
    expiryDate: b.expiryDate,
    costPrice: b.costPrice == null ? null : toNum(b.costPrice),
    createdAt: b.createdAt.toISOString(),
  };
}

export function serializeCustomer(c: Customer) {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone,
    company: c.company,
    gstNumber: c.gstNumber,
    billingAddress: c.billingAddress,
    shippingAddress: c.shippingAddress,
    placeOfSupply: c.placeOfSupply,
    notes: c.notes,
    outstandingBalance: toNum(c.outstandingBalance),
    createdAt: c.createdAt.toISOString(),
  };
}

export function serializeSupplier(s: Supplier) {
  return {
    id: s.id,
    name: s.name,
    email: s.email,
    phone: s.phone,
    company: s.company,
    gstNumber: s.gstNumber,
    address: s.address,
    notes: s.notes,
    isJobWorker: s.isJobWorker,
    outstandingPayable: toNum(s.outstandingPayable),
    createdAt: s.createdAt.toISOString(),
  };
}

export function serializeStockMovement(
  m: StockMovement,
  itemName: string,
  warehouseName: string,
  itemSku: string | null = null,
  itemBarcode: string | null = null,
  itemCategory: string | null = null,
) {
  return {
    id: m.id,
    itemId: m.itemId,
    itemName,
    itemSku,
    itemBarcode,
    itemCategory,
    warehouseId: m.warehouseId,
    warehouseName,
    movementType: m.movementType,
    quantity: toNum(m.quantity),
    referenceType: m.referenceType,
    referenceId: m.referenceId,
    notes: m.notes,
    createdAt: m.createdAt.toISOString(),
  };
}

export function serializeSalesOrder(
  o: SalesOrder,
  customerName: string,
  warehouseName: string,
  customerGstNumber: string | null = null,
) {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    customerId: o.customerId,
    customerName,
    customerGstNumber,
    warehouseId: o.warehouseId,
    warehouseName,
    status: o.status,
    orderDate: o.orderDate,
    expectedShipDate: o.expectedShipDate,
    subtotal: toNum(o.subtotal),
    taxTotal: toNum(o.taxTotal),
    total: toNum(o.total),
    amountPaid: toNum(o.amountPaid),
    balanceDue: toNum(o.balanceDue),
    notes: o.notes,
    ewb: serializeSalesOrderEwb(o),
    einvoice: serializeSalesOrderEinvoice(o),
    createdAt: o.createdAt.toISOString(),
  };
}

function serializeSalesOrderEinvoice(o: SalesOrder) {
  // We expose the e-invoice block only when an attempt has been made
  // (so that B2C orders that never get reported don't carry a noisy
  // "not yet" object). The presence of the irpStatus field is the
  // canonical signal that the auto-hook fired.
  if (!o.irpStatus && !o.irn) return null;
  const ackDate = o.irpAckDate;
  // The IRP cancellation window is exactly 24h from acknowledgement.
  const cancellable =
    o.irpStatus === "active" &&
    ackDate != null &&
    Date.now() - ackDate.getTime() < 24 * 60 * 60 * 1000;
  return {
    irn: o.irn,
    status: o.irpStatus,
    ackNumber: o.irpAckNumber,
    ackDate: ackDate ? ackDate.toISOString() : null,
    qrPayload: o.irpQrPayload,
    error: o.irpError,
    // Machine-readable code for the most recent failure. Drives the
    // structured "What to fix" panel on the SalesOrderDetail page.
    errorCode: o.irpErrorCode,
    // Optional structured context for the failure (currently only
    // used by `invalid_hsn` to pin the failing item).
    errorContext:
      o.irpErrorContext &&
      typeof o.irpErrorContext === "object" &&
      !Array.isArray(o.irpErrorContext)
        ? (o.irpErrorContext as Record<string, unknown>)
        : null,
    cancelledAt: o.irpCancelledAt ? o.irpCancelledAt.toISOString() : null,
    cancelReason: o.irpCancelReason,
    cancellable,
  };
}

function serializeSalesOrderEwb(o: SalesOrder) {
  if (!o.ewbNumber) return null;
  const validUntil = o.ewbValidUntil;
  const isExpired =
    o.ewbStatus === "active" &&
    validUntil != null &&
    validUntil.getTime() < Date.now();
  return {
    number: o.ewbNumber,
    status: o.ewbStatus,
    date: o.ewbDate ? o.ewbDate.toISOString() : null,
    validUntil: validUntil ? validUntil.toISOString() : null,
    isExpired,
    qrPayload: o.ewbQrPayload,
    vehicleNumber: o.ewbVehicleNumber,
    transportMode: o.ewbTransportMode,
    transporterName: o.ewbTransporterName,
    transporterId: o.ewbTransporterId,
    distanceKm: o.ewbDistanceKm,
    cancelledAt: o.ewbCancelledAt ? o.ewbCancelledAt.toISOString() : null,
    cancelReason: o.ewbCancelReason,
  };
}

export function serializeCustomerPayment(
  p: CustomerPayment,
  customerName: string,
) {
  return {
    id: p.id,
    customerId: p.customerId,
    customerName,
    paymentDate: p.paymentDate,
    amount: toNum(p.amount),
    mode: p.mode,
    referenceNumber: p.referenceNumber,
    notes: p.notes,
    bankAccountLabel: p.bankAccountLabel,
    createdAt: p.createdAt.toISOString(),
  };
}

export function serializeCustomerPaymentAllocation(
  a: CustomerPaymentAllocation,
  orderNumber: string,
  orderTotal: number | string,
  orderBalanceDue: number | string,
) {
  return {
    id: a.id,
    paymentId: a.paymentId,
    salesOrderId: a.salesOrderId,
    salesOrderNumber: orderNumber,
    salesOrderTotal: toNum(orderTotal),
    salesOrderBalanceDue: toNum(orderBalanceDue),
    amount: toNum(a.amount),
  };
}

export function serializePurchaseOrder(
  o: PurchaseOrder,
  supplierName: string,
  warehouseName: string,
  jobWorkLink: {
    jobWorkOrderId: number;
    jwoNumber: string;
  } | null = null,
) {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    supplierId: o.supplierId,
    supplierName,
    warehouseId: o.warehouseId,
    warehouseName,
    status: o.status,
    orderDate: o.orderDate,
    expectedDeliveryDate: o.expectedDeliveryDate,
    subtotal: toNum(o.subtotal),
    taxTotal: toNum(o.taxTotal),
    total: toNum(o.total),
    amountPaid: toNum(o.amountPaid),
    balanceDue: toNum(o.balanceDue),
    notes: o.notes,
    // Auto-bills generated by /job-work-orders/:id/receive carry a
    // link back to the originating receipt + JWO so the supplier
    // ledger can deep-link into the job-work flow.
    jobWorkReceiptId: o.jobWorkReceiptId ?? null,
    jobWorkOrderId: jobWorkLink?.jobWorkOrderId ?? null,
    jwoNumber: jobWorkLink?.jwoNumber ?? null,
    createdAt: o.createdAt.toISOString(),
  };
}

export function serializeSupplierPayment(
  p: SupplierPayment,
  supplierName: string,
) {
  return {
    id: p.id,
    supplierId: p.supplierId,
    supplierName,
    paymentDate: p.paymentDate,
    amount: toNum(p.amount),
    mode: p.mode,
    referenceNumber: p.referenceNumber,
    notes: p.notes,
    bankAccountLabel: p.bankAccountLabel,
    createdAt: p.createdAt.toISOString(),
  };
}

export function serializeSupplierPaymentAllocation(
  a: SupplierPaymentAllocation,
  orderNumber: string,
  orderTotal: number | string,
  orderBalanceDue: number | string,
) {
  return {
    id: a.id,
    paymentId: a.paymentId,
    purchaseOrderId: a.purchaseOrderId,
    purchaseOrderNumber: orderNumber,
    purchaseOrderTotal: toNum(orderTotal),
    purchaseOrderBalanceDue: toNum(orderBalanceDue),
    amount: toNum(a.amount),
  };
}

export function serializeOrderLine(
  l: SalesOrderLine | PurchaseOrderLine,
  itemName: string,
  sku: string,
  variantOptions: Record<string, string> | null = null,
  trackBatches = false,
) {
  const isSalesLine = "quantityShipped" in l;
  const isPurchaseLine = "quantityReceived" in l;
  return {
    id: l.id,
    itemId: l.itemId,
    itemName,
    sku,
    variantOptions,
    quantity: toNum(l.quantity),
    quantityShipped: isSalesLine ? toNum(l.quantityShipped) : 0,
    quantityReceived: isPurchaseLine ? toNum(l.quantityReceived) : 0,
    unitPrice: toNum(l.unitPrice),
    taxRate: toNum(l.taxRate),
    lineSubtotal: toNum(l.lineSubtotal),
    lineTax: toNum(l.lineTax),
    lineTotal: toNum(l.lineTotal),
    description: l.description,
    trackBatches,
  };
}

export function serializeShipment(s: Shipment) {
  return {
    id: s.id,
    salesOrderId: s.salesOrderId,
    shipmentNumber: s.shipmentNumber,
    shipDate: s.shipDate,
    status: s.status,
    notes: s.notes,
    shiprocketOrderId: s.shiprocketOrderId,
    shiprocketShipmentId: s.shiprocketShipmentId,
    awb: s.awb,
    courierName: s.courierName,
    labelUrl: s.labelUrl,
    trackingUrl: s.trackingUrl,
    trackingStatus: s.trackingStatus,
    lastTrackedAt: s.lastTrackedAt ? s.lastTrackedAt.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
  };
}

export function serializeShipmentLine(
  l: ShipmentLine,
  itemName: string,
  sku: string,
  salesOrderLineId: number,
) {
  return {
    id: l.id,
    shipmentId: l.shipmentId,
    salesOrderLineId,
    itemName,
    sku,
    quantity: toNum(l.quantity),
  };
}

export function serializeGoodsReceipt(r: GoodsReceipt) {
  return {
    id: r.id,
    purchaseOrderId: r.purchaseOrderId,
    receiptNumber: r.receiptNumber,
    receivedDate: r.receivedDate,
    status: r.status,
    notes: r.notes,
    createdAt: r.createdAt.toISOString(),
  };
}

export function serializeGoodsReceiptLine(
  l: GoodsReceiptLine,
  itemName: string,
  sku: string,
  purchaseOrderLineId: number,
) {
  return {
    id: l.id,
    goodsReceiptId: l.goodsReceiptId,
    purchaseOrderLineId,
    itemName,
    sku,
    quantity: toNum(l.quantity),
  };
}

export function serializeStockTransfer(
  t: StockTransfer,
  fromWarehouseName: string,
  toWarehouseName: string,
) {
  return {
    id: t.id,
    transferNumber: t.transferNumber,
    fromWarehouseId: t.fromWarehouseId,
    fromWarehouseName,
    toWarehouseId: t.toWarehouseId,
    toWarehouseName,
    transferDate: t.transferDate,
    status: t.status,
    notes: t.notes,
    createdAt: t.createdAt.toISOString(),
  };
}

export function serializeStockTransferLine(
  l: StockTransferLine,
  itemName: string,
  sku: string,
  variantOptions: Record<string, string> | null = null,
  trackBatches = false,
) {
  return {
    id: l.id,
    stockTransferId: l.stockTransferId,
    itemId: l.itemId,
    itemName,
    sku,
    variantOptions,
    quantity: toNum(l.quantity),
    trackBatches,
  };
}

export function serializePaymentLink(p: PaymentLink) {
  return {
    id: p.id,
    salesOrderId: p.salesOrderId,
    razorpayLinkId: p.razorpayLinkId,
    shortUrl: p.shortUrl,
    amount: toNum(p.amount),
    currency: p.currency,
    status: p.status,
    description: p.description,
    razorpayPaymentId: p.razorpayPaymentId,
    expiresAt: p.expiresAt ? p.expiresAt.toISOString() : null,
    paidAt: p.paidAt ? p.paidAt.toISOString() : null,
    cancelledAt: p.cancelledAt ? p.cancelledAt.toISOString() : null,
    createdAt: p.createdAt.toISOString(),
  };
}

export function serializeEmailLog(e: EmailLog) {
  return {
    id: e.id,
    salesOrderId: e.salesOrderId,
    kind: e.kind,
    recipient: e.recipient,
    subject: e.subject,
    status: e.status,
    errorMessage: e.errorMessage,
    sentAt: e.sentAt.toISOString(),
  };
}
