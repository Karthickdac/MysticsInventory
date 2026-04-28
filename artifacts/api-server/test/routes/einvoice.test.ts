import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { createDbModuleMock, drizzleOrmMock } from "../helpers/mockModules";

// ──────────────────────────────────────────────────────────────────────
// Module mocks. These must come before any code that imports the
// einvoice route or its transitive dependencies. The `@workspace/db`
// and `drizzle-orm` mocks come from the shared `mockModules` helper
// so every new route test file picks up the same surface (table
// sentinels, expression helpers) for free.
// ──────────────────────────────────────────────────────────────────────
vi.mock("@workspace/db", () => createDbModuleMock());
vi.mock("drizzle-orm", () => drizzleOrmMock);
vi.mock("../../src/lib/tenant", () => ({
  tenantMiddleware: (req: Request, _res: Response, next: NextFunction) => {
    req.tenant = {
      userId: 1,
      organizationId: 1,
      role: "owner",
      clerkUserId: "user_test",
      isSuperAdmin: false,
    };
    next();
  },
}));

import { dbMock, resetDbMock } from "../helpers/dbMock";
import { encryptString } from "../../src/lib/encryption";
import einvoiceRouter from "../../src/routes/einvoice";

// ──────────────────────────────────────────────────────────────────────
// App + fixture helpers
// ──────────────────────────────────────────────────────────────────────

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api", einvoiceRouter);
  return app;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// loadOrderForIrn does two selects: order+customer+org join, then
// order lines. Queue both in the right order.
function queueOrderLoad(
  order: {
    id?: number;
    organizationId?: number;
    orderNumber?: string;
    orderDate?: string;
    status?: string;
    irn?: string | null;
    irpStatus?: string | null;
    irpAckDate?: Date | null;
    subtotal?: number | string;
    taxTotal?: number | string;
    total?: number | string;
  } = {},
) {
  const orderRow = {
    order: {
      id: order.id ?? 42,
      organizationId: order.organizationId ?? 1,
      orderNumber: order.orderNumber ?? "INV-0001",
      orderDate: order.orderDate ?? "2026-01-15",
      status: order.status ?? "shipped",
      irn: order.irn ?? null,
      irpStatus: order.irpStatus ?? null,
      irpAckDate: order.irpAckDate ?? null,
      subtotal: order.subtotal ?? "1000",
      taxTotal: order.taxTotal ?? "180",
      total: order.total ?? "1180",
    },
    customer: {
      id: 7,
      name: "Acme Buyer",
      company: "Acme Pvt Ltd",
      gstNumber: "29ABCDE1234F1Z5",
      billingAddress: "12 MG Road, Bengaluru 560001",
      shippingAddress: "12 MG Road, Bengaluru 560001",
      placeOfSupply: "Karnataka",
      email: "buyer@acme.test",
      phone: "9999999999",
    },
    org: {
      name: "Mystics Inc",
      gstNumber: "29ZZZZZ9999Z1Z5",
      addressLine1: "1 Brigade Road, Bengaluru 560002",
      city: "Bengaluru",
      state: "Karnataka",
      postalCode: "560002",
      eInvoiceGstin: null,
    },
  };
  dbMock.queueSelect([orderRow]);
  dbMock.queueSelect([
    {
      line: {
        id: 1,
        salesOrderId: order.id ?? 42,
        description: "Blue widget",
        quantity: "1",
        unitPrice: "1000",
        taxRate: "18",
        lineSubtotal: "1000",
        lineTax: "180",
        lineTotal: "1180",
      },
      itemId: 100,
      itemName: "Widget",
      sku: "WID-1",
      hsnCode: "84715000",
      unit: "NOS",
    },
  ]);
}

// `getOrgEinvoiceToken` does one DB select to load creds + cached token.
function queueTokenLoad(
  opts: { token?: string; expiresInMs?: number } = {},
) {
  const expiresAt = new Date(
    Date.now() + (opts.expiresInMs ?? 60 * 60 * 1000),
  );
  dbMock.queueSelect([
    {
      enabled: true,
      gstin: "29AAAAA1234A1Z5",
      username: "tester",
      passwordEncrypted: encryptString("pw"),
      clientIdEncrypted: null,
      clientSecretEncrypted: null,
      tokenEncrypted: encryptString(opts.token ?? "T"),
      tokenExpiresAt: expiresAt,
    },
  ]);
}

beforeEach(() => {
  resetDbMock();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ──────────────────────────────────────────────────────────────────────
// generate — happy path + error mapping
// ──────────────────────────────────────────────────────────────────────

describe("POST /api/sales-orders/:id/einvoice/generate", () => {
  it("happy path: claims, calls IRP, persists IRN, returns 200", async () => {
    // 1. Atomic claim update returns 1 row
    dbMock.queueUpdate([{ id: 42 }]);
    // 2. loadOrderForIrn (order + lines)
    queueOrderLoad();
    // 3. getOrgEinvoiceToken loads creds
    queueTokenLoad();
    // 4. einvoiceRequest's success branch updates eInvoiceLastErrorAt = null
    dbMock.queueUpdate([{}]);
    // 5. Persist IRN onto the order
    dbMock.queueUpdate([{}]);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(200, {
        status: "1",
        data: {
          Irn: "IRN-XYZ",
          AckNo: "12345",
          AckDt: "2026-01-15 10:30:00",
          SignedQRCode: "qr-data",
        },
      }),
    );

    const res = await request(makeApp()).post(
      "/api/sales-orders/42/einvoice/generate",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      irn: "IRN-XYZ",
      ackNumber: "12345",
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect((fetchSpy.mock.calls[0]![0] as string)).toContain("/invoice");
  });

  it("4xx from IRP → 400 with the IRP message and code (not a 500/502)", async () => {
    dbMock.queueUpdate([{ id: 42 }]); // claim
    queueOrderLoad();
    queueTokenLoad();
    dbMock.queueUpdate([{}]); // last-error set inside einvoiceRequest
    dbMock.queueUpdate([{}]); // route persists irpStatus=failed

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(400, {
        status: "0",
        errorDetails: [
          { ErrorCode: "2150", ErrorMessage: "Duplicate IRN for the document" },
        ],
      }),
    );

    const res = await request(makeApp()).post(
      "/api/sales-orders/42/einvoice/generate",
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("2150");
    expect(res.body.error).toMatch(/Duplicate IRN/);
  });

  it("5xx from IRP → 502 with a generic upstream message and the upstream code", async () => {
    dbMock.queueUpdate([{ id: 42 }]); // claim
    queueOrderLoad();
    queueTokenLoad();
    dbMock.queueUpdate([{}]); // last-error set
    dbMock.queueUpdate([{}]); // route persists irpStatus=failed

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(503, {
        status: "0",
        message: "IRP gateway timeout",
      }),
    );

    const res = await request(makeApp()).post(
      "/api/sales-orders/42/einvoice/generate",
    );
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("einvoice_upstream_failed");
    // The detail-leaking IRP wording is replaced with the generic
    // operator-friendly message.
    expect(res.body.error).not.toMatch(/gateway timeout/i);
  });

  it("local validation failure (missing HSN) → 400 with the structured code, no IRP call", async () => {
    dbMock.queueUpdate([{ id: 42 }]); // claim
    // Same as a normal load, but the line has no HSN — payload build
    // throws before any IRP call is made.
    dbMock.queueSelect([
      {
        order: {
          id: 42,
          organizationId: 1,
          orderNumber: "INV-0001",
          orderDate: "2026-01-15",
          status: "shipped",
          irn: null,
          irpStatus: null,
          irpAckDate: null,
          subtotal: "1000",
          taxTotal: "180",
          total: "1180",
        },
        customer: {
          id: 7,
          name: "Acme",
          company: "Acme Pvt",
          gstNumber: "29ABCDE1234F1Z5",
          billingAddress: "12 MG Road, Bengaluru 560001",
          shippingAddress: "12 MG Road, Bengaluru 560001",
          placeOfSupply: "Karnataka",
          email: null,
          phone: null,
        },
        org: {
          name: "Mystics Inc",
          gstNumber: "29ZZZZZ9999Z1Z5",
          addressLine1: "1 Brigade Road, Bengaluru 560002",
          city: "Bengaluru",
          state: "Karnataka",
          postalCode: "560002",
          eInvoiceGstin: null,
        },
      },
    ]);
    dbMock.queueSelect([
      {
        line: {
          id: 1,
          salesOrderId: 42,
          description: null,
          quantity: "1",
          unitPrice: "1000",
          taxRate: "18",
          lineSubtotal: "1000",
          lineTax: "180",
          lineTotal: "1180",
        },
        itemId: 100,
        itemName: "Widget",
        sku: "WID-1",
        hsnCode: null, // ← the trigger
        unit: "NOS",
      },
    ]);
    dbMock.queueUpdate([{}]); // route persists irpStatus=failed

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await request(makeApp()).post(
      "/api/sales-orders/42/einvoice/generate",
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_hsn");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ineligible status (e.g. draft) → 400 ineligible_status, no IRP call", async () => {
    // Claim returns 0 rows because the order is in 'draft'.
    dbMock.queueUpdate([]);
    queueOrderLoad({ status: "draft" });

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await request(makeApp()).post(
      "/api/sales-orders/42/einvoice/generate",
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ineligible_status");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("already-active IRN → 409 irn_already_issued, no IRP call", async () => {
    dbMock.queueUpdate([]); // claim refused (irpStatus=active fails the OR guard)
    queueOrderLoad({
      irn: "EXISTING",
      irpStatus: "active",
      status: "invoiced",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await request(makeApp()).post(
      "/api/sales-orders/42/einvoice/generate",
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("irn_already_issued");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("already-cancelled IRN → 400 irn_cancelled (must issue credit note instead)", async () => {
    dbMock.queueUpdate([]); // claim refused
    queueOrderLoad({
      irn: null,
      irpStatus: "cancelled",
      status: "invoiced",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await request(makeApp()).post(
      "/api/sales-orders/42/einvoice/generate",
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("irn_cancelled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Concurrency: two simultaneous generate calls only hit the IRP once
// ──────────────────────────────────────────────────────────────────────

describe("POST /api/sales-orders/:id/einvoice/generate (concurrency)", () => {
  it("two simultaneous calls only hit the IRP once; the loser gets 409", async () => {
    // The deterministic recipe: the first request claims and then
    // hangs inside fetch (we hand it a deferred promise). While it's
    // hung we queue the loser's mocks and fire the second request,
    // which should fail-fast on the CAS and return 409 without
    // touching IRP. Then we resolve the fetch and let the winner
    // finish.

    let resolveFetch!: (r: Response) => void;
    const fetchDeferred = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => fetchDeferred);

    const app = makeApp();

    // ── Winner setup (queued before firing) ─────────────────────────
    dbMock.queueUpdate([{ id: 42 }]); // claim won
    queueOrderLoad({ irpStatus: "pending" }); // load order + lines
    queueTokenLoad(); // creds + cached token

    // `.then()` is what actually opens the HTTP socket in supertest;
    // assigning the Test object alone is lazy.
    const winnerPromise = request(app)
      .post("/api/sales-orders/42/einvoice/generate")
      .then((r) => r);

    // Pump the event loop until the winner's handler reaches the
    // fetch and parks on the deferred. We poll instead of fixing a
    // tick count because the network round-trip and Express dispatch
    // take an unpredictable number of microtasks/macrotasks.
    const start = Date.now();
    while (fetchSpy.mock.calls.length === 0) {
      if (Date.now() - start > 2000) {
        throw new Error("winner request never reached IRP fetch");
      }
      await new Promise((r) => setImmediate(r));
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // ── Loser setup (queued only AFTER winner is hung) ──────────────
    dbMock.queueUpdate([]); // claim lost
    queueOrderLoad({ irpStatus: "pending" }); // for the 409 lookup

    const loserRes = await request(app).post(
      "/api/sales-orders/42/einvoice/generate",
    );
    expect(loserRes.status).toBe(409);
    expect(loserRes.body.code).toBe("irn_in_flight");
    expect(fetchSpy).toHaveBeenCalledTimes(1); // still just the one

    // ── Release the winner ──────────────────────────────────────────
    dbMock.queueUpdate([{}]); // success-clear (last-error)
    dbMock.queueUpdate([{}]); // persist IRN
    resolveFetch(
      jsonResponse(200, {
        status: "1",
        data: {
          Irn: "IRN-CONCURRENT",
          AckNo: "1",
          AckDt: "2026-01-15 10:30:00",
          SignedQRCode: "qr",
        },
      }),
    );

    const winnerRes = await winnerPromise;
    expect(winnerRes.status).toBe(200);
    expect(winnerRes.body.irn).toBe("IRN-CONCURRENT");

    // Final invariant: throughout the whole race, IRP was hit
    // exactly once.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// cancel — 24h window + error mapping
// ──────────────────────────────────────────────────────────────────────

describe("POST /api/sales-orders/:id/einvoice/cancel", () => {
  it("happy path: cancels within the 24h window and clears the IRN locally", async () => {
    const ackedAnHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    // Route: 1 select (full row) → cancelIrn → 1 token select →
    // 1 last-error update → 1 IRN-clear update.
    dbMock.queueSelect([
      {
        id: 42,
        organizationId: 1,
        orderNumber: "INV-0001",
        orderDate: "2026-01-15",
        status: "invoiced",
        irn: "ABC",
        irpStatus: "active",
        irpAckDate: ackedAnHourAgo,
        irpAckNumber: "12345",
        irpQrPayload: "qr",
        irpCancelledAt: null,
        irpCancelReason: null,
        irpError: null,
        irpErrorCode: null,
        irpErrorContext: null,
        subtotal: "1000",
        taxTotal: "180",
        total: "1180",
      },
    ]);
    queueTokenLoad();
    dbMock.queueUpdate([{}]); // last-error clear
    dbMock.queueUpdate([{}]); // IRN clear

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(200, {
        status: "1",
        data: { Irn: "ABC", CancelDate: "2026-01-15 11:00:00" },
      }),
    );

    const res = await request(makeApp())
      .post("/api/sales-orders/42/einvoice/cancel")
      .send({ reasonCode: "1", reasonRemark: "duplicate" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.cancelledAt).toBe("string");
  });

  it("rejects cancel beyond the 24h window with a clear code", async () => {
    const ackedTwoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    dbMock.queueSelect([
      {
        id: 42,
        organizationId: 1,
        orderNumber: "INV-0001",
        orderDate: "2026-01-13",
        status: "invoiced",
        irn: "ABC",
        irpStatus: "active",
        irpAckDate: ackedTwoDaysAgo,
        irpAckNumber: "12345",
        irpQrPayload: "qr",
        irpCancelledAt: null,
        irpCancelReason: null,
        irpError: null,
        irpErrorCode: null,
        irpErrorContext: null,
        subtotal: "1000",
        taxTotal: "180",
        total: "1180",
      },
    ]);

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await request(makeApp())
      .post("/api/sales-orders/42/einvoice/cancel")
      .send({ reasonCode: "1", reasonRemark: "duplicate" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("cancel_window_expired");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects cancel when there is no active IRN to cancel", async () => {
    dbMock.queueSelect([
      {
        id: 42,
        organizationId: 1,
        orderNumber: "INV-0001",
        orderDate: "2026-01-15",
        status: "shipped",
        irn: null,
        irpStatus: null,
        irpAckDate: null,
        irpAckNumber: null,
        irpQrPayload: null,
        irpCancelledAt: null,
        irpCancelReason: null,
        irpError: null,
        irpErrorCode: null,
        irpErrorContext: null,
        subtotal: "1000",
        taxTotal: "180",
        total: "1180",
      },
    ]);

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await request(makeApp())
      .post("/api/sales-orders/42/einvoice/cancel")
      .send({ reasonCode: "1", reasonRemark: "duplicate" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("no_active_irn");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty reasonRemark (zod validation)", async () => {
    const res = await request(makeApp())
      .post("/api/sales-orders/42/einvoice/cancel")
      .send({ reasonCode: "1", reasonRemark: "" });
    expect(res.status).toBe(400);
  });

  it("5xx from IRP → 502 with a generic upstream message", async () => {
    const ackedAnHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    dbMock.queueSelect([
      {
        id: 42,
        organizationId: 1,
        orderNumber: "INV-0001",
        orderDate: "2026-01-15",
        status: "invoiced",
        irn: "ABC",
        irpStatus: "active",
        irpAckDate: ackedAnHourAgo,
        irpAckNumber: "12345",
        irpQrPayload: "qr",
        irpCancelledAt: null,
        irpCancelReason: null,
        irpError: null,
        irpErrorCode: null,
        irpErrorContext: null,
        subtotal: "1000",
        taxTotal: "180",
        total: "1180",
      },
    ]);
    queueTokenLoad();
    dbMock.queueUpdate([{}]); // last-error set on failure

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(503, {
        status: "0",
        message: "IRP gateway timeout",
      }),
    );

    const res = await request(makeApp())
      .post("/api/sales-orders/42/einvoice/cancel")
      .send({ reasonCode: "1", reasonRemark: "duplicate" });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("einvoice_upstream_failed");
    // The IRP wording is replaced with the operator-friendly message.
    expect(res.body.error).not.toMatch(/gateway timeout/i);
  });

  it("4xx from IRP → 400 with the upstream message", async () => {
    const ackedAnHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    dbMock.queueSelect([
      {
        id: 42,
        organizationId: 1,
        orderNumber: "INV-0001",
        orderDate: "2026-01-15",
        status: "invoiced",
        irn: "ABC",
        irpStatus: "active",
        irpAckDate: ackedAnHourAgo,
        irpAckNumber: "12345",
        irpQrPayload: "qr",
        irpCancelledAt: null,
        irpCancelReason: null,
        irpError: null,
        irpErrorCode: null,
        irpErrorContext: null,
        subtotal: "1000",
        taxTotal: "180",
        total: "1180",
      },
    ]);
    queueTokenLoad();
    dbMock.queueUpdate([{}]); // last-error set on failure

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(400, {
        status: "0",
        errorDetails: [
          { ErrorCode: "9999", ErrorMessage: "Cancellation refused by IRP" },
        ],
      }),
    );

    const res = await request(makeApp())
      .post("/api/sales-orders/42/einvoice/cancel")
      .send({ reasonCode: "1", reasonRemark: "duplicate" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("9999");
  });
});

// ──────────────────────────────────────────────────────────────────────
// qr.png — happy path + 404
// ──────────────────────────────────────────────────────────────────────

describe("GET /api/sales-orders/:id/einvoice/qr.png", () => {
  it("returns a PNG buffer when an IRN QR is on file", async () => {
    dbMock.queueSelect([{ qr: "QR_PAYLOAD_FOR_IRN", status: "active" }]);
    const res = await request(makeApp()).get(
      "/api/sales-orders/42/einvoice/qr.png",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    // PNG file signature: 89 50 4E 47 0D 0A 1A 0A
    expect(res.body[0]).toBe(0x89);
    expect(res.body[1]).toBe(0x50);
    expect(res.body[2]).toBe(0x4e);
    expect(res.body[3]).toBe(0x47);
  });

  it("returns 404 when no QR is stored", async () => {
    dbMock.queueSelect([{ qr: null, status: null }]);
    const res = await request(makeApp()).get(
      "/api/sales-orders/42/einvoice/qr.png",
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the order does not exist", async () => {
    dbMock.queueSelect([]);
    const res = await request(makeApp()).get(
      "/api/sales-orders/42/einvoice/qr.png",
    );
    expect(res.status).toBe(404);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Auto-hook: tryAutoGenerateIrn fire-and-forget behaviour
// ──────────────────────────────────────────────────────────────────────

describe("tryAutoGenerateIrn", () => {
  it("silently no-ops when the org is not connected", async () => {
    const { tryAutoGenerateIrn } = await import("../../src/routes/einvoice");
    // First select inside runAutoGenerate: org row with enabled=false.
    dbMock.queueSelect([
      { enabled: false, gstin: null, passwordEncrypted: null },
    ]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await tryAutoGenerateIrn(1, 42);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("happy path: claims, calls IRP, persists IRN", async () => {
    const { tryAutoGenerateIrn } = await import("../../src/routes/einvoice");
    // 1. Org gate: enabled and connected.
    dbMock.queueSelect([
      {
        enabled: true,
        gstin: "29AAAAA1234A1Z5",
        passwordEncrypted: encryptString("pw"),
      },
    ]);
    // 2. loadOrderForIrn (order + lines)
    queueOrderLoad();
    // 3. Atomic claim
    dbMock.queueUpdate([{ id: 42 }]);
    // 4. Token load
    queueTokenLoad();
    // 5. einvoiceRequest success: clears last-error
    dbMock.queueUpdate([{}]);
    // 6. Persist IRN
    dbMock.queueUpdate([{}]);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(200, {
        status: "1",
        data: {
          Irn: "AUTO-IRN",
          AckNo: "1",
          AckDt: "2026-01-15 10:30:00",
          SignedQRCode: "qr",
        },
      }),
    );

    await tryAutoGenerateIrn(1, 42);

    // We don't assert response (none — fire-and-forget); we assert
    // the IRN-persisting update was issued (the last update we
    // queued was consumed).
    const updates = dbMock.updateCalls();
    expect(updates.length).toBeGreaterThanOrEqual(3);
  });

  it("never throws on internal errors (fire-and-forget)", async () => {
    const { tryAutoGenerateIrn } = await import("../../src/routes/einvoice");
    // Force the very first select to reject — runAutoGenerate's
    // try/catch in tryAutoGenerateIrn must swallow it.
    dbMock.queueSelect(
      // A thenable that rejects.
      Object.assign(Promise.reject(new Error("DB down")), {
        catch: Promise.prototype.catch.bind(
          Promise.reject(new Error("DB down")).catch(() => undefined),
        ),
      }),
    );
    // Avoid an unhandled rejection from the rejected promise above
    // (the test only cares that tryAutoGenerateIrn doesn't throw).
    await expect(tryAutoGenerateIrn(1, 42)).resolves.toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Bulk e-invoice flow — POST /api/einvoice/bulk + background worker
// ──────────────────────────────────────────────────────────────────────
//
// The bulk path is a 202-then-background-worker design: the route
// classifies every order up-front, persists the batch row, returns
// 202 with the per-row classification, and spawns a fire-and-forget
// worker (`runBulkBatch`) that walks the pending rows.
//
// The worker shares the same compare-and-claim pattern as the
// single-order /generate route, so a worker run + a manual
// /generate call against the same order is guaranteed to hit the
// IRP exactly once. The tests below cover the route's classifier,
// the worker tick on success, the worker's behaviour on 4xx/5xx
// from IRP, and the worker-vs-manual race.

/**
 * Poll until `predicate()` is truthy or the deadline elapses. The
 * bulk worker is fire-and-forget so the test must drive microtasks
 * and watch the dbMock for the worker's terminal write
 * (markBatchCompleted) before asserting.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  message = "predicate never became true",
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out: ${message}`);
    }
    await new Promise((r) => setImmediate(r));
  }
}

/**
 * Build a row in the shape `classifyBulkOrders` expects from its
 * single SQL select (sales_orders left-joined with customers).
 */
function classifyRow(opts: {
  id: number;
  orderNumber: string;
  status?: string;
  irpStatus?: string | null;
  irn?: string | null;
  customerGstNumber?: string | null;
}) {
  return {
    id: opts.id,
    orderNumber: opts.orderNumber,
    status: opts.status ?? "shipped",
    irpStatus: opts.irpStatus ?? null,
    irn: opts.irn ?? null,
    customerGstNumber: opts.customerGstNumber ?? "29ABCDE1234F1Z5",
  };
}

/**
 * Build a fully-populated batch row in the shape Drizzle's
 * `INSERT … RETURNING *` produces. The worker re-loads this same
 * row via `loadBulkBatch`, so the same fixture serves both queues.
 */
function makeBatchRow(opts: {
  id: string;
  orderIdsInOrder: number[];
  results: Record<string, unknown>;
  total?: number;
  processed?: number;
  succeeded?: number;
  failed?: number;
  skipped?: number;
}) {
  const now = new Date();
  return {
    id: opts.id,
    organizationId: 1,
    status: "running",
    total: opts.total ?? opts.orderIdsInOrder.length,
    processed: opts.processed ?? 0,
    succeeded: opts.succeeded ?? 0,
    failed: opts.failed ?? 0,
    skipped: opts.skipped ?? 0,
    orderIdsInOrder: opts.orderIdsInOrder,
    results: opts.results,
    createdAt: now,
    updatedAt: now,
    completedAt: null as Date | null,
    recoveryClaimedAt: now,
  };
}

describe("POST /api/einvoice/bulk (classifier + 202 response)", () => {
  it("classifies orders into queued / already_issued / skipped / ineligible / not-found", async () => {
    const orderIdsInOrder = [100, 101, 102, 103, 200];
    // 1. Org connectivity gate (route's first select).
    dbMock.queueSelect([
      {
        enabled: true,
        gstin: "29AAAAA1234A1Z5",
        passwordEncrypted: encryptString("pw"),
      },
    ]);
    // 2. classifyBulkOrders' single join select. Row 200 is omitted
    //    so the classifier reports it as "not found / ineligible".
    dbMock.queueSelect([
      classifyRow({ id: 100, orderNumber: "INV-100" }),
      classifyRow({
        id: 101,
        orderNumber: "INV-101",
        status: "invoiced",
        irpStatus: "active",
        irn: "EXISTING-IRN",
      }),
      classifyRow({
        id: 102,
        orderNumber: "INV-102",
        irpStatus: "pending",
      }),
      classifyRow({
        id: 103,
        orderNumber: "INV-103",
        status: "draft",
      }),
    ]);
    // 3. Insert returning the inserted batch row. Use the shape the
    //    classifier would have produced so the route can serialize
    //    it back to the caller.
    const insertedBatch = makeBatchRow({
      id: "batch-classify",
      orderIdsInOrder,
      total: 5,
      processed: 4,
      succeeded: 1,
      failed: 0,
      skipped: 3,
      results: {
        "100": {
          orderId: 100,
          orderNumber: "INV-100",
          status: "pending",
          message: null,
          errorCode: null,
        },
        "101": {
          orderId: 101,
          orderNumber: "INV-101",
          status: "already_issued",
          message: "An active IRN already exists for this order.",
          errorCode: "irn_already_issued",
        },
        "102": {
          orderId: 102,
          orderNumber: "INV-102",
          status: "skipped",
          message: "Another IRN registration is already in flight.",
          errorCode: "irn_in_flight",
        },
        "103": {
          orderId: 103,
          orderNumber: "INV-103",
          status: "ineligible",
          message:
            "E-invoice can only be registered after the order has shipped. Current status: draft.",
          errorCode: "ineligible_status",
        },
        "200": {
          orderId: 200,
          orderNumber: null,
          status: "ineligible",
          message: "Sales order not found",
          errorCode: "not_found",
        },
      },
    });
    dbMock.queueInsert([insertedBatch]);
    // 4. The worker fires after the response. Make its loadBulkBatch
    //    select return [] so it exits silently — this test only
    //    cares about the immediate classifier response.
    dbMock.queueSelect([]);

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await request(makeApp())
      .post("/api/einvoice/bulk")
      .send({ orderIds: orderIdsInOrder });

    expect(res.status).toBe(202);
    expect(res.body.id).toBe("batch-classify");
    expect(res.body.total).toBe(5);
    // The display order is the caller's submission order, deduped.
    expect(res.body.results.map((r: { orderId: number }) => r.orderId)).toEqual(
      [100, 101, 102, 103, 200],
    );
    expect(
      res.body.results.map((r: { status: string }) => r.status),
    ).toEqual([
      "pending",
      "already_issued",
      "skipped",
      "ineligible",
      "ineligible",
    ]);
    expect(res.body.results[4].errorCode).toBe("not_found");
    // The worker's loadBulkBatch returned []; it never reached IRP.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects when e-invoicing is not connected (no IRP call, no worker spawned)", async () => {
    // Org row has no GSTIN/password → connected=false.
    dbMock.queueSelect([
      { enabled: false, gstin: null, passwordEncrypted: null },
    ]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await request(makeApp())
      .post("/api/einvoice/bulk")
      .send({ orderIds: [42] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("einvoice_not_connected");
    // No insert (no batch row) and no IRP fetch.
    expect(dbMock.insertCalls().length).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Bulk worker (background runBulkBatch)", () => {
  it("worker tick: claims a pending row, calls IRP, persists IRN, advances cursor, marks batch completed", async () => {
    const orderIdsInOrder = [42];
    // ── Route-level mocks ────────────────────────────────────────────
    dbMock.queueSelect([
      {
        enabled: true,
        gstin: "29AAAAA1234A1Z5",
        passwordEncrypted: encryptString("pw"),
      },
    ]);
    dbMock.queueSelect([classifyRow({ id: 42, orderNumber: "INV-0001" })]);
    const initialResults = {
      "42": {
        orderId: 42,
        orderNumber: "INV-0001",
        status: "pending",
        message: null,
        errorCode: null,
      },
    };
    const insertedBatch = makeBatchRow({
      id: "batch-happy",
      orderIdsInOrder,
      results: initialResults,
    });
    dbMock.queueInsert([insertedBatch]);

    // ── Worker mocks ────────────────────────────────────────────────
    // 1. loadBulkBatch reloads the same row.
    dbMock.queueSelect([insertedBatch]);
    // 2. CAS claim wins.
    dbMock.queueUpdate([{ id: 42, orderNumber: "INV-0001" }]);
    // 3. loadOrderForIrn (order joins + lines).
    queueOrderLoad();
    // 4. getOrgEinvoiceToken / loadOrgEinvoiceCreds.
    queueTokenLoad();
    // 5. einvoiceRequest's success branch clears last-error.
    dbMock.queueUpdate([{}]);
    // 6. Persist IRN onto sales_orders.
    dbMock.queueUpdate([{}]);
    // 7. persistRowSettlement uses db.execute — the default empty
    //    rowset is fine, but queue explicitly so the call is
    //    observable in executeCalls().
    dbMock.queueExecute([]);
    // 8. markBatchCompleted: status='completed' update.
    dbMock.queueUpdate([{}]);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(200, {
        status: "1",
        data: {
          Irn: "BULK-IRN-OK",
          AckNo: "12345",
          AckDt: "2026-01-15 10:30:00",
          SignedQRCode: "qr-data",
        },
      }),
    );

    const res = await request(makeApp())
      .post("/api/einvoice/bulk")
      .send({ orderIds: orderIdsInOrder });
    expect(res.status).toBe(202);
    expect(res.body.id).toBe("batch-happy");

    // Wait for the worker to finish: claim + last-error clear + IRN
    // persist + markBatchCompleted = 4 updates.
    await waitFor(
      () => dbMock.updateCalls().length >= 4,
      3000,
      "worker did not complete",
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The IRP call goes to the /invoice path.
    expect((fetchSpy.mock.calls[0]![0] as string)).toContain("/invoice");

    // Per-row settlement was persisted exactly once.
    expect(dbMock.executeCalls().length).toBe(1);

    // The final update is markBatchCompleted with status='completed'.
    const updates = dbMock.updateCalls();
    const lastUpdate = updates[updates.length - 1]!;
    const setCall = lastUpdate.calls.find((c) => c.fn === "set");
    expect(setCall).toBeDefined();
    expect(
      (setCall!.args[0] as { status: string }).status,
    ).toBe("completed");

    // The IRN-persist update before that wrote irpStatus='active' on
    // the sales order — proves the worker's success path advanced
    // the order, not just the batch counters.
    const setStatuses = updates
      .map((u) => u.calls.find((c) => c.fn === "set"))
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
      .map((s) => s.args[0] as Record<string, unknown>);
    const irnPersist = setStatuses.find(
      (s) => s.irpStatus === "active" && typeof s.irn === "string",
    );
    expect(irnPersist).toBeDefined();
    expect(irnPersist!.irn).toBe("BULK-IRN-OK");
  });

  it("worker handles 4xx from IRP: marks the row failed and still completes the batch (no crash, no second IRP call)", async () => {
    const orderIdsInOrder = [42];
    dbMock.queueSelect([
      {
        enabled: true,
        gstin: "29AAAAA1234A1Z5",
        passwordEncrypted: encryptString("pw"),
      },
    ]);
    dbMock.queueSelect([classifyRow({ id: 42, orderNumber: "INV-0001" })]);
    const initialResults = {
      "42": {
        orderId: 42,
        orderNumber: "INV-0001",
        status: "pending",
        message: null,
        errorCode: null,
      },
    };
    const insertedBatch = makeBatchRow({
      id: "batch-4xx",
      orderIdsInOrder,
      results: initialResults,
    });
    dbMock.queueInsert([insertedBatch]);

    // Worker mocks
    dbMock.queueSelect([insertedBatch]); // loadBulkBatch
    dbMock.queueUpdate([{ id: 42, orderNumber: "INV-0001" }]); // claim wins
    queueOrderLoad();
    queueTokenLoad();
    dbMock.queueUpdate([{}]); // einvoiceRequest's failure branch sets last-error
    dbMock.queueUpdate([{}]); // processOrderForBulk's catch persists irpStatus='failed'
    dbMock.queueExecute([]); // persistRowSettlement
    dbMock.queueUpdate([{}]); // markBatchCompleted

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(400, {
        status: "0",
        errorDetails: [
          {
            ErrorCode: "2150",
            ErrorMessage: "Duplicate IRN for the document",
          },
        ],
      }),
    );

    await request(makeApp())
      .post("/api/einvoice/bulk")
      .send({ orderIds: orderIdsInOrder });

    await waitFor(
      () => dbMock.updateCalls().length >= 4,
      3000,
      "worker did not complete after 4xx",
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const updates = dbMock.updateCalls();
    const setStatuses = updates
      .map((u) => u.calls.find((c) => c.fn === "set"))
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
      .map((s) => s.args[0] as Record<string, unknown>);

    // The order was marked irpStatus='failed' (not 'active') with the
    // IRP's error code and message.
    const failedUpdate = setStatuses.find(
      (s) => s.irpStatus === "failed" && s.irpErrorCode === "2150",
    );
    expect(failedUpdate).toBeDefined();
    expect(String(failedUpdate!.irpError)).toMatch(/Duplicate IRN/);

    // The final update is still markBatchCompleted — the failure
    // didn't prevent the batch from terminating cleanly.
    const lastUpdate = updates[updates.length - 1]!;
    const setCall = lastUpdate.calls.find((c) => c.fn === "set");
    expect(
      (setCall!.args[0] as { status: string }).status,
    ).toBe("completed");

    // Per-row settlement still recorded the failure.
    expect(dbMock.executeCalls().length).toBe(1);
  });

  it("worker handles 5xx from IRP: marks the row failed (without leaking IRP detail) and completes the batch", async () => {
    const orderIdsInOrder = [42];
    dbMock.queueSelect([
      {
        enabled: true,
        gstin: "29AAAAA1234A1Z5",
        passwordEncrypted: encryptString("pw"),
      },
    ]);
    dbMock.queueSelect([classifyRow({ id: 42, orderNumber: "INV-0001" })]);
    const initialResults = {
      "42": {
        orderId: 42,
        orderNumber: "INV-0001",
        status: "pending",
        message: null,
        errorCode: null,
      },
    };
    const insertedBatch = makeBatchRow({
      id: "batch-5xx",
      orderIdsInOrder,
      results: initialResults,
    });
    dbMock.queueInsert([insertedBatch]);

    dbMock.queueSelect([insertedBatch]); // loadBulkBatch
    dbMock.queueUpdate([{ id: 42, orderNumber: "INV-0001" }]); // claim wins
    queueOrderLoad();
    queueTokenLoad();
    dbMock.queueUpdate([{}]); // einvoiceRequest sets last-error on failure
    dbMock.queueUpdate([{}]); // processOrderForBulk's catch marks failed
    dbMock.queueExecute([]); // persistRowSettlement
    dbMock.queueUpdate([{}]); // markBatchCompleted

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(503, {
        status: "0",
        message: "IRP gateway timeout",
      }),
    );

    await request(makeApp())
      .post("/api/einvoice/bulk")
      .send({ orderIds: orderIdsInOrder });

    await waitFor(
      () => dbMock.updateCalls().length >= 4,
      3000,
      "worker did not complete after 5xx",
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const updates = dbMock.updateCalls();
    const setStatuses = updates
      .map((u) => u.calls.find((c) => c.fn === "set"))
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
      .map((s) => s.args[0] as Record<string, unknown>);
    const failedUpdate = setStatuses.find((s) => s.irpStatus === "failed");
    expect(failedUpdate).toBeDefined();
    // 5xx wording from the IRP is mapped to the generic
    // operator-friendly message, not the leaky upstream detail.
    expect(String(failedUpdate!.irpError)).not.toMatch(/gateway timeout/i);

    const lastUpdate = updates[updates.length - 1]!;
    const setCall = lastUpdate.calls.find((c) => c.fn === "set");
    expect(
      (setCall!.args[0] as { status: string }).status,
    ).toBe("completed");
  });
});

describe("Bulk worker vs. manual /generate (concurrency)", () => {
  it("a worker run + a concurrent manual generate for the same order only hit IRP once", async () => {
    // The recipe:
    //   1. Spawn the bulk worker; let it CAS-claim order 42 and reach
    //      its IRP fetch, then park on a deferred promise.
    //   2. Fire the manual /generate request — its CAS claim must
    //      lose (claim returns []) and the route must respond with
    //      409 irn_in_flight without making any IRP call.
    //   3. Resolve the worker's fetch with a normal success and let
    //      it finish.
    //   4. Assert IRP was hit exactly once across the whole race.
    let resolveFetch!: (r: Response) => void;
    const fetchDeferred = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => fetchDeferred);

    const app = makeApp();

    // ── Bulk route + worker pre-fetch mocks ─────────────────────────
    const orderIdsInOrder = [42];
    dbMock.queueSelect([
      {
        enabled: true,
        gstin: "29AAAAA1234A1Z5",
        passwordEncrypted: encryptString("pw"),
      },
    ]); // org connectivity
    dbMock.queueSelect([classifyRow({ id: 42, orderNumber: "INV-0001" })]); // classify
    const initialResults = {
      "42": {
        orderId: 42,
        orderNumber: "INV-0001",
        status: "pending",
        message: null,
        errorCode: null,
      },
    };
    const insertedBatch = makeBatchRow({
      id: "batch-race",
      orderIdsInOrder,
      results: initialResults,
    });
    dbMock.queueInsert([insertedBatch]); // insert returning
    dbMock.queueSelect([insertedBatch]); // worker loadBulkBatch
    dbMock.queueUpdate([{ id: 42, orderNumber: "INV-0001" }]); // worker CAS claim
    queueOrderLoad({ irpStatus: "pending" }); // worker loadOrderForIrn
    queueTokenLoad(); // worker getOrgEinvoiceToken

    // Fire the bulk request — the response returns 202 immediately,
    // and the worker keeps running in the background.
    const bulkRes = await request(app)
      .post("/api/einvoice/bulk")
      .send({ orderIds: orderIdsInOrder });
    expect(bulkRes.status).toBe(202);

    // Wait for the worker to reach its IRP fetch and park.
    const start = Date.now();
    while (fetchSpy.mock.calls.length === 0) {
      if (Date.now() - start > 2000) {
        throw new Error("worker never reached IRP fetch");
      }
      await new Promise((r) => setImmediate(r));
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // ── Loser setup (manual /generate, queued only after the worker
    //    has parked on fetch — order matters in the dbMock queue). ──
    dbMock.queueUpdate([]); // manual claim CAS loses
    queueOrderLoad({ irpStatus: "pending" }); // 409-lookup

    const manualRes = await request(app).post(
      "/api/sales-orders/42/einvoice/generate",
    );
    expect(manualRes.status).toBe(409);
    expect(manualRes.body.code).toBe("irn_in_flight");
    // Critical invariant: even though both code paths just executed,
    // the IRP was contacted exactly once (by the worker that won
    // the claim).
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // ── Release the worker and let it finish ────────────────────────
    dbMock.queueUpdate([{}]); // einvoiceRequest's success-clear
    dbMock.queueUpdate([{}]); // worker persists IRN onto sales_orders
    dbMock.queueExecute([]); // persistRowSettlement
    dbMock.queueUpdate([{}]); // markBatchCompleted

    resolveFetch(
      jsonResponse(200, {
        status: "1",
        data: {
          Irn: "IRN-RACE",
          AckNo: "1",
          AckDt: "2026-01-15 10:30:00",
          SignedQRCode: "qr",
        },
      }),
    );

    await waitFor(
      () =>
        dbMock
          .updateCalls()
          .some((u) =>
            u.calls.some(
              (c) =>
                c.fn === "set" &&
                (c.args[0] as { status?: string } | undefined)?.status ===
                  "completed",
            ),
          ),
      3000,
      "worker did not mark the batch completed",
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
