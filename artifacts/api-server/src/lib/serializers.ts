import type {
  Organization,
  Warehouse,
  Item,
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
    plan: o.plan,
    subscriptionStatus: o.subscriptionStatus,
    currentPeriodEnd: o.currentPeriodEnd ? o.currentPeriodEnd.toISOString() : null,
    onboardingCompletedAt: o.onboardingCompletedAt
      ? o.onboardingCompletedAt.toISOString()
      : null,
    createdAt: o.createdAt.toISOString(),
  };
}

export function serializeWarehouse(w: Warehouse) {
  return {
    id: w.id,
    name: w.name,
    code: w.code,
    addressLine1: w.addressLine1,
    city: w.city,
    state: w.state,
    country: w.country,
    isDefault: w.isDefault,
    shopifyLocationId: w.shopifyLocationId,
    shopifyLocationName: w.shopifyLocationName,
    createdAt: w.createdAt.toISOString(),
  };
}

export function serializeItem(i: Item, totalStock: number | string = 0) {
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
    taxRate: toNum(i.taxRate),
    reorderLevel: toNum(i.reorderLevel),
    totalStock: toNum(totalStock),
    imageUrl: i.imageUrl,
    createdAt: i.createdAt.toISOString(),
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
    outstandingPayable: toNum(s.outstandingPayable),
    createdAt: s.createdAt.toISOString(),
  };
}

export function serializeStockMovement(
  m: StockMovement,
  itemName: string,
  warehouseName: string,
) {
  return {
    id: m.id,
    itemId: m.itemId,
    itemName,
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
) {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    customerId: o.customerId,
    customerName,
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
    createdAt: o.createdAt.toISOString(),
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
) {
  const isSalesLine = "quantityShipped" in l;
  const isPurchaseLine = "quantityReceived" in l;
  return {
    id: l.id,
    itemId: l.itemId,
    itemName,
    sku,
    quantity: toNum(l.quantity),
    quantityShipped: isSalesLine ? toNum(l.quantityShipped) : 0,
    quantityReceived: isPurchaseLine ? toNum(l.quantityReceived) : 0,
    unitPrice: toNum(l.unitPrice),
    taxRate: toNum(l.taxRate),
    lineSubtotal: toNum(l.lineSubtotal),
    lineTax: toNum(l.lineTax),
    lineTotal: toNum(l.lineTotal),
    description: l.description,
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
