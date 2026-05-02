import { describe, it, expect } from "vitest";
import { renderSalesOrderAckPdf } from "../../src/lib/salesOrderPdf";

const baseOrg = {
  name: "Automystics Technologies",
  gstNumber: "29ABCDE1234F1Z5",
  addressLine1: "12 MG Road",
  addressLine2: null,
  city: "Bengaluru",
  state: "Karnataka",
  postalCode: "560001",
  country: "IN",
  logoUrl: null,
  invoiceFooter: null,
};

const baseCustomer = {
  name: "Naveen",
  company: null,
  email: null,
  phone: null,
  gstNumber: null,
  billingAddress: null,
  shippingAddress: null,
  placeOfSupply: null,
};

const baseOrder = {
  orderNumber: "SO-260502-9351",
  status: "confirmed",
  orderDate: "2026-05-02",
  expectedShipDate: null,
  notes: null,
  subtotal: "20",
  taxTotal: "4",
  total: "24",
};

const baseLine = {
  itemName: "Sample Item",
  sku: "SKU-1",
  description: null,
  hsnCode: null,
  quantity: "1",
  unitPrice: "20",
  taxRate: "20",
  lineSubtotal: "20",
  lineTax: "4",
  lineTotal: "24",
};

describe("renderSalesOrderAckPdf", () => {
  it("renders a minimal sales-order ack PDF", async () => {
    const buf = await renderSalesOrderAckPdf({
      org: baseOrg,
      customer: baseCustomer,
      order: baseOrder,
      lines: [baseLine],
      logoBuffer: null,
    });
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 4).toString("ascii")).toBe("%PDF");
  });

  it("renders with no lines (empty order)", async () => {
    const buf = await renderSalesOrderAckPdf({
      org: baseOrg,
      customer: baseCustomer,
      order: baseOrder,
      lines: [],
      logoBuffer: null,
    });
    expect(buf.subarray(0, 4).toString("ascii")).toBe("%PDF");
  });

  it("renders with notes + footer + many lines (multi-page)", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => ({
      ...baseLine,
      itemName: `Item ${i + 1}`,
      sku: `SKU-${i + 1}`,
    }));
    const buf = await renderSalesOrderAckPdf({
      org: { ...baseOrg, invoiceFooter: "Thanks for your business." },
      customer: {
        ...baseCustomer,
        billingAddress: "1\n2\n3",
        shippingAddress: "1\n2\n3",
      },
      order: { ...baseOrder, notes: "Please deliver before Friday." },
      lines,
      logoBuffer: null,
    });
    expect(buf.subarray(0, 4).toString("ascii")).toBe("%PDF");
  });

  it("renders draft + cancelled status (stamp branch)", async () => {
    for (const status of ["draft", "cancelled", "shipped"]) {
      const buf = await renderSalesOrderAckPdf({
        org: baseOrg,
        customer: baseCustomer,
        order: { ...baseOrder, status },
        lines: [baseLine],
        logoBuffer: null,
      });
      expect(buf.subarray(0, 4).toString("ascii")).toBe("%PDF");
    }
  });
});
