// Cross-tenant isolation tests for the public invoice PDF endpoint.
//
// The route is unauthenticated — access is gated by an HMAC-signed
// share link of the form
//   /api/public/invoices/:id.pdf?org=…&exp=…&token=…
// The token signs `${orgId}|${salesOrderId}|${exp}` with
// INVOICE_SIGNING_SECRET, so flipping any of those parameters
// invalidates the HMAC. These tests confirm:
//   * Missing / forged / tampered tokens are rejected with 403.
//   * A valid token signed for org A cannot fetch org B's invoice
//     (loadInvoiceForOrder is invoked with the *signed* org id, so
//     the underlying org-scoped query yields notFound).
//   * A valid token returns the PDF for the signed (org, salesOrder)
//     pair only.

import crypto from "node:crypto";

process.env.INVOICE_SIGNING_SECRET = "test_invoice_secret";

import { describe, it, expect, beforeEach, vi } from "vitest";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";

// Minimal in-memory store of (orgId, salesOrderId) → invoice. Used
// by the mocked loadInvoiceForOrder so we can assert the route hands
// the *signed* orgId to it (and therefore an A-signed token can't
// reach B's data).
interface FakeInvoice {
  orgId: number;
  salesOrderId: number;
  orderNumber: string;
}
const invoices: FakeInvoice[] = [];

const { loadInvoiceForOrderMock } = vi.hoisted(() => ({
  loadInvoiceForOrderMock: vi.fn(),
}));

vi.mock("../../src/lib/invoiceData", () => ({
  loadInvoiceForOrder: loadInvoiceForOrderMock,
}));

import publicInvoicesRouter from "../../src/routes/publicInvoices";

const ORG_A = 1001;
const ORG_B = 2002;
const SO_A = 7001;
const SO_B = 8001;

function sign(orgId: number, salesOrderId: number, exp: number): string {
  return crypto
    .createHmac("sha256", process.env.INVOICE_SIGNING_SECRET!)
    .update(`${orgId}|${salesOrderId}|${exp}`)
    .digest("hex");
}

function buildApp(): Express {
  const app = express();
  app.use(publicInvoicesRouter);
  app.use(
    (err: Error, _req: Request, res: Response, _next: NextFunction): void => {
      res.status(500).json({ error: err.message });
    },
  );
  return app;
}

describe("public invoices cross-tenant isolation", () => {
  let app: Express;

  beforeEach(() => {
    invoices.length = 0;
    invoices.push(
      { orgId: ORG_A, salesOrderId: SO_A, orderNumber: "SO-A-1" },
      { orgId: ORG_B, salesOrderId: SO_B, orderNumber: "SO-B-1" },
    );
    loadInvoiceForOrderMock.mockReset();
    loadInvoiceForOrderMock.mockImplementation(
      async (orgId: number, salesOrderId: number) => {
        const inv = invoices.find(
          (i) => i.orgId === orgId && i.salesOrderId === salesOrderId,
        );
        if (!inv) return { notFound: true as const };
        return {
          pdf: Buffer.from(`PDF_${orgId}_${salesOrderId}`),
          orderNumber: inv.orderNumber,
          customerEmail: null,
          customerName: "Cust",
          status: "shipped",
          total: 100,
        };
      },
    );
    app = buildApp();
  });

  describe("token validation", () => {
    it("missing token → 403", async () => {
      const res = await request(app).get(`/public/invoices/${SO_A}.pdf`);
      expect(res.status).toBe(403);
      expect(loadInvoiceForOrderMock).not.toHaveBeenCalled();
    });

    it("forged token → 403", async () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const res = await request(app)
        .get(`/public/invoices/${SO_A}.pdf`)
        .query({
          org: String(ORG_A),
          exp: String(exp),
          token: "deadbeef".repeat(8),
        });
      expect(res.status).toBe(403);
      expect(loadInvoiceForOrderMock).not.toHaveBeenCalled();
    });

    it("tampering with org id (re-using A's HMAC for B) → 403", async () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const tokenForA = sign(ORG_A, SO_A, exp);
      // Same token, but org param swapped to ORG_B. HMAC won't match.
      const res = await request(app)
        .get(`/public/invoices/${SO_A}.pdf`)
        .query({ org: String(ORG_B), exp: String(exp), token: tokenForA });
      expect(res.status).toBe(403);
      expect(loadInvoiceForOrderMock).not.toHaveBeenCalled();
    });

    it("expired token → 403", async () => {
      const exp = Math.floor(Date.now() / 1000) - 60;
      const token = sign(ORG_A, SO_A, exp);
      const res = await request(app)
        .get(`/public/invoices/${SO_A}.pdf`)
        .query({ org: String(ORG_A), exp: String(exp), token });
      expect(res.status).toBe(403);
      expect(loadInvoiceForOrderMock).not.toHaveBeenCalled();
    });
  });

  describe("cross-tenant access via valid tokens", () => {
    it("ORG_A's signed token cannot fetch ORG_B's invoice (404)", async () => {
      // A token validly signed for (ORG_A, SO_B) is theoretically
      // possible if A's secret holder asked for it — but
      // loadInvoiceForOrder filters by orgId, so SO_B (which lives
      // under ORG_B) is unreachable through an ORG_A query.
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const token = sign(ORG_A, SO_B, exp);
      const res = await request(app)
        .get(`/public/invoices/${SO_B}.pdf`)
        .query({ org: String(ORG_A), exp: String(exp), token });
      expect(res.status).toBe(404);
      expect(loadInvoiceForOrderMock).toHaveBeenCalledWith(ORG_A, SO_B);
    });

    it("a valid ORG_A token returns ORG_A's invoice (and only that)", async () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const token = sign(ORG_A, SO_A, exp);
      const res = await request(app)
        .get(`/public/invoices/${SO_A}.pdf`)
        .query({ org: String(ORG_A), exp: String(exp), token });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("application/pdf");
      expect(res.body.toString("utf8")).toBe(`PDF_${ORG_A}_${SO_A}`);
      expect(loadInvoiceForOrderMock).toHaveBeenCalledWith(ORG_A, SO_A);
    });
  });
});
