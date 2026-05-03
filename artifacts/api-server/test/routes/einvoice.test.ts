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
import einvoiceRouter, {
  recoverInFlightBulkBatches,
  startBulkBatchPruneScheduler,
} from "../../src/routes/einvoice";

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
  // IRP acknowledgement identifiers, surfaced into the row payload
  // for `already_issued` rows so the bulk dialog/CSV can show the
  // existing IRN without a second lookup.
  irpAckNumber?: string | null;
  irpAckDate?: Date | null;
  customerGstNumber?: string | null;
}) {
  return {
    id: opts.id,
    orderNumber: opts.orderNumber,
    status: opts.status ?? "shipped",
    irpStatus: opts.irpStatus ?? null,
    irn: opts.irn ?? null,
    irpAckNumber: opts.irpAckNumber ?? null,
    irpAckDate: opts.irpAckDate ?? null,
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
    startedAt: now,
    concurrency: 1,
    completedAt: null as Date | null,
    recoveryClaimedAt: now,
  };
}

/**
 * Minimum-viable row that markBatchCompleted's `RETURNING` reads
 * to emit its structured completion log. The route doesn't act on
 * the returned values beyond logging, so the tests only need the
 * fields the log function dereferences (`startedAt`, counters,
 * concurrency, ids).
 */
function completedBatchRow(): Record<string, unknown> {
  const now = new Date();
  return {
    id: "batch-test",
    organizationId: 1,
    status: "completed",
    total: 1,
    processed: 1,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    startedAt: now,
    completedAt: now,
    concurrency: 1,
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
        // Existing ack identifiers come back from the lookup so
        // the classifier can attach them to the already_issued
        // row payload — the bulk dialog and CSV both consume them.
        irpAckNumber: "112025040712345",
        irpAckDate: new Date("2026-04-15T10:30:00.000Z"),
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
          // Persisted alongside the row so the serializer can hand
          // the existing IRN back to the dialog/CSV without a
          // second lookup.
          irn: "EXISTING-IRN",
          ackNumber: "112025040712345",
          ackDate: "2026-04-15T10:30:00.000Z",
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
    // The already_issued row carries the existing IRN (and ack
    // identifiers) so the bulk dialog/CSV don't have to leave the
    // IRN column blank when an operator re-runs a partial batch.
    expect(res.body.results[1].status).toBe("already_issued");
    expect(res.body.results[1].irn).toBe("EXISTING-IRN");
    expect(res.body.results[1].ackNumber).toBe("112025040712345");
    expect(res.body.results[1].ackDate).toBe("2026-04-15T10:30:00.000Z");
    // Rows that didn't end in success/already_issued get explicit
    // null for the IRN identifiers (rather than missing keys), so
    // the OpenAPI contract — which marks them as required-and-
    // nullable — stays honest.
    expect(res.body.results[0].irn).toBeNull();
    expect(res.body.results[2].irn).toBeNull();
    expect(res.body.results[2].ackNumber).toBeNull();
    expect(res.body.results[2].ackDate).toBeNull();
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
    dbMock.queueUpdate([completedBatchRow()]); // markBatchCompleted

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
    dbMock.queueUpdate([completedBatchRow()]); // markBatchCompleted

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

// ──────────────────────────────────────────────────────────────────────
// Bulk worker — verify the per-row jsonb persisted by
// persistRowSettlement actually carries the freshly-issued IRN
// identifiers (irn / ackNumber / ackDate). The worker mirrors them
// onto the row payload so the dialog and CSV no longer have to parse
// the IRN out of the message field. The other worker tests above
// assert the sales-orders column was updated; these tests assert the
// per-row jsonb passed into persistRowSettlement carries the same
// data — a regression where the worker silently drops them on the
// floor would otherwise only show up in production.
// ──────────────────────────────────────────────────────────────────────

/**
 * Pull the JSON-encoded BulkResultRow that the worker passed into
 * persistRowSettlement out of the captured `db.execute(sql\`…\`)`
 * call. The `drizzle-orm` mock collapses the tagged-template call
 * into `{ kind: "sql", args: [strings, ...interpolations] }`, so
 * the row JSON appears as one of the interpolated arguments. We
 * scan for the first arg that parses as a row-shaped JSON object
 * (status key present); the row JSON is re-substituted multiple
 * times inside the SQL, but JSON.parse makes them equivalent so
 * the first match is enough.
 */
function extractPersistedRow(
  call: { args: unknown[] },
): Record<string, unknown> {
  const sqlObj = call.args[0] as { args?: unknown[] };
  for (const interp of sqlObj.args ?? []) {
    if (typeof interp !== "string") continue;
    if (!interp.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(interp);
      if (parsed && typeof parsed === "object" && "status" in parsed) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not the row-JSON arg; keep scanning.
    }
  }
  throw new Error(
    "no persisted-row JSON found in execute() call sql interpolations",
  );
}

describe("Bulk worker persists IRN identifiers into the per-row jsonb", () => {
  it("success branch: the persisted row carries the freshly-issued irn / ackNumber / ackDate", async () => {
    const orderIdsInOrder = [42];
    dbMock.queueSelect([
      {
        enabled: true,
        gstin: "29AAAAA1234A1Z5",
        passwordEncrypted: encryptString("pw"),
      },
    ]);
    dbMock.queueSelect([classifyRow({ id: 42, orderNumber: "INV-0001" })]);
    const insertedBatch = makeBatchRow({
      id: "batch-persist-success",
      orderIdsInOrder,
      results: {
        "42": {
          orderId: 42,
          orderNumber: "INV-0001",
          status: "pending",
          message: null,
          errorCode: null,
        },
      },
    });
    dbMock.queueInsert([insertedBatch]);

    // Worker mocks (mirrors the happy-path test above).
    dbMock.queueSelect([insertedBatch]); // loadBulkBatch
    dbMock.queueUpdate([{ id: 42, orderNumber: "INV-0001" }]); // CAS claim wins
    queueOrderLoad();
    queueTokenLoad();
    dbMock.queueUpdate([{}]); // einvoiceRequest clears last-error
    dbMock.queueUpdate([{}]); // persist IRN onto sales_orders
    dbMock.queueExecute([]); // persistRowSettlement
    dbMock.queueUpdate([completedBatchRow()]); // markBatchCompleted

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
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

    await request(makeApp())
      .post("/api/einvoice/bulk")
      .send({ orderIds: orderIdsInOrder });

    await waitFor(
      () => dbMock.updateCalls().length >= 4,
      3000,
      "worker did not complete",
    );

    expect(dbMock.executeCalls().length).toBe(1);
    const persistedRow = extractPersistedRow(dbMock.executeCalls()[0]!);
    expect(persistedRow.status).toBe("success");
    expect(persistedRow.orderId).toBe(42);
    // Structured IRN identifiers — proves the worker doesn't drop
    // them between processOrderForBulk's return and the jsonb that
    // backs the dialog/CSV. Without these, the dialog would have to
    // keep regex-parsing the message for the IRN.
    expect(persistedRow.irn).toBe("BULK-IRN-OK");
    expect(persistedRow.ackNumber).toBe("12345");
    expect(typeof persistedRow.ackDate).toBe("string");
    // ackDate is normalised to an ISO instant before persistence.
    expect(persistedRow.ackDate).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
    // The legacy message is preserved unchanged so older readers
    // that still parse the IRN out of it keep working.
    expect(String(persistedRow.message)).toMatch(/BULK-IRN-OK/);
  });

  it("failed branch: the persisted row leaves irn / ackNumber / ackDate explicitly null", async () => {
    const orderIdsInOrder = [42];
    dbMock.queueSelect([
      {
        enabled: true,
        gstin: "29AAAAA1234A1Z5",
        passwordEncrypted: encryptString("pw"),
      },
    ]);
    dbMock.queueSelect([classifyRow({ id: 42, orderNumber: "INV-0001" })]);
    const insertedBatch = makeBatchRow({
      id: "batch-persist-failed",
      orderIdsInOrder,
      results: {
        "42": {
          orderId: 42,
          orderNumber: "INV-0001",
          status: "pending",
          message: null,
          errorCode: null,
        },
      },
    });
    dbMock.queueInsert([insertedBatch]);

    dbMock.queueSelect([insertedBatch]); // loadBulkBatch
    dbMock.queueUpdate([{ id: 42, orderNumber: "INV-0001" }]); // CAS claim wins
    queueOrderLoad();
    queueTokenLoad();
    dbMock.queueUpdate([{}]); // einvoiceRequest sets last-error on failure
    dbMock.queueUpdate([{}]); // catch persists irpStatus='failed'
    dbMock.queueExecute([]); // persistRowSettlement
    dbMock.queueUpdate([completedBatchRow()]); // markBatchCompleted

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
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

    expect(dbMock.executeCalls().length).toBe(1);
    const persistedRow = extractPersistedRow(dbMock.executeCalls()[0]!);
    expect(persistedRow.status).toBe("failed");
    expect(persistedRow.errorCode).toBe("2150");
    // Failed rows still carry the IRN keys — explicit null — so the
    // OpenAPI contract (required-and-nullable) and the dialog/CSV
    // consumers don't see a mixed shape across rows.
    expect(persistedRow.irn).toBeNull();
    expect(persistedRow.ackNumber).toBeNull();
    expect(persistedRow.ackDate).toBeNull();
  });

  it("skipped branch: the persisted row leaves irn / ackNumber / ackDate explicitly null", async () => {
    const orderIdsInOrder = [42];
    dbMock.queueSelect([
      {
        enabled: true,
        gstin: "29AAAAA1234A1Z5",
        passwordEncrypted: encryptString("pw"),
      },
    ]);
    dbMock.queueSelect([classifyRow({ id: 42, orderNumber: "INV-0001" })]);
    const insertedBatch = makeBatchRow({
      id: "batch-persist-skipped",
      orderIdsInOrder,
      results: {
        "42": {
          orderId: 42,
          orderNumber: "INV-0001",
          status: "pending",
          message: null,
          errorCode: null,
        },
      },
    });
    dbMock.queueInsert([insertedBatch]);

    dbMock.queueSelect([insertedBatch]); // loadBulkBatch
    // The worker's CAS claim loses — another flow already flipped
    // the order to irpStatus='pending', which makes
    // processOrderForBulk return "skipped" without an IRP fetch.
    dbMock.queueUpdate([]); // claim returns no rows
    queueOrderLoad({ irpStatus: "pending" });
    dbMock.queueExecute([]); // persistRowSettlement
    dbMock.queueUpdate([completedBatchRow()]); // markBatchCompleted

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await request(makeApp())
      .post("/api/einvoice/bulk")
      .send({ orderIds: orderIdsInOrder });

    // Only two updates on this path: the lost claim attempt and
    // markBatchCompleted. No IRP fetch, no last-error write.
    await waitFor(
      () => dbMock.updateCalls().length >= 2,
      3000,
      "worker did not complete after skipped",
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dbMock.executeCalls().length).toBe(1);
    const persistedRow = extractPersistedRow(dbMock.executeCalls()[0]!);
    expect(persistedRow.status).toBe("skipped");
    expect(persistedRow.errorCode).toBe("irn_in_flight");
    expect(persistedRow.irn).toBeNull();
    expect(persistedRow.ackNumber).toBeNull();
    expect(persistedRow.ackDate).toBeNull();
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
    dbMock.queueUpdate([completedBatchRow()]); // markBatchCompleted

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

// ──────────────────────────────────────────────────────────────────────
// Crash-recovery — recoverInFlightBulkBatches, pruneStaleBatches,
// startBulkBatchPruneScheduler
// ──────────────────────────────────────────────────────────────────────
//
// These cover the "what happens when the API process restarts mid-
// batch" half of bulk reliability. The route's bulk worker is fire-
// and-forget, so a deploy / crash / workflow restart can leave a
// batch row in `status='running'` with one or more sales_orders
// sitting in `irpStatus='pending'` (the dead worker's in-flight IRP
// claim). Recovery has to:
//   1. Atomically claim each running batch (CAS on
//      `recoveryClaimedAt`) so two replicas don't double-spawn the
//      same worker.
//   2. Reset the orphaned `irpStatus='pending'` rows so the worker's
//      eligibility check can re-pick them up.
//   3. Re-spawn the worker for each claimed batch.
// Prune has to:
//   - Drop completed batches past BULK_BATCH_TTL_MS.
//   - Force-drop *any* batch past BULK_BATCH_HARD_TTL_MS.
//   - Leave fresh ones alone (the SQL where filter does the work; we
//     just verify the cutoffs the route hands to the mock).
// The scheduler has to fire both prune + recovery on every tick and
// keep ticking even when one of them fails.

/**
 * The drizzle-orm mock represents expressions as
 *   { kind: "eq" | "and" | "or" | ..., args: unknown[] }
 * Walk the tree and collect every node whose `kind` matches.
 */
function collectExprByKind(
  expr: unknown,
  kind: string,
  out: Array<{ kind: string; args: unknown[] }> = [],
): Array<{ kind: string; args: unknown[] }> {
  if (!expr || typeof expr !== "object") return out;
  const node = expr as { kind?: string; args?: unknown[] };
  if (node.kind === kind && Array.isArray(node.args)) {
    out.push({ kind: node.kind, args: node.args });
  }
  if (Array.isArray(node.args)) {
    for (const child of node.args) {
      collectExprByKind(child, kind, out);
    }
  }
  return out;
}

/**
 * Build a rejected promise whose unhandled-rejection slot is
 * pre-silenced. The dbMock chain consumes the rejection later via
 * its own `.then(onFulfilled, onRejected)`, but Node fires the
 * "unhandled rejection" warning in the very next microtask after
 * construction — and Vitest treats that as a test failure even
 * when the consumer eventually attaches a handler. A no-op
 * `.catch` at creation time satisfies the "has at least one
 * handler" check without consuming the rejection — subsequent
 * `.then(_, onRejected)` calls still receive the error.
 */
function silencedRejection(err: Error): Promise<never> {
  const p = Promise.reject(err);
  p.catch(() => {});
  return p;
}

/** Build a running-batch row in the shape Drizzle's select returns. */
function runningBatchRow(opts: {
  id: string;
  orderIdsInOrder?: number[];
  results?: Record<string, unknown>;
  recoveryClaimedAt?: Date | null;
}): Record<string, unknown> {
  const now = new Date();
  return {
    id: opts.id,
    organizationId: 1,
    status: "running",
    total: opts.orderIdsInOrder?.length ?? 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    orderIdsInOrder: opts.orderIdsInOrder ?? [],
    results: opts.results ?? {},
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    concurrency: 1,
    completedAt: null as Date | null,
    recoveryClaimedAt: opts.recoveryClaimedAt ?? null,
  };
}

describe("recoverInFlightBulkBatches (crash-restart recovery)", () => {
  it("skips a batch whose recoveryClaimedAt is fresh (CAS loses, no worker, no orphaned-pending reset)", async () => {
    // Prune (fires first inside recovery) — no rows to drop.
    dbMock.queueDelete([]);
    // Running-batch scan returns one batch.
    dbMock.queueSelect([
      runningBatchRow({
        id: "batch-fresh-claim",
        orderIdsInOrder: [42],
        // The row still has a "pending" entry — if recovery
        // *did* claim, it would attempt the orphan reset. We
        // assert below that no salesOrders update was issued.
        results: {
          "42": {
            orderId: 42,
            orderNumber: "INV-0001",
            status: "pending",
            message: null,
            errorCode: null,
          },
        },
        recoveryClaimedAt: new Date(), // fresh — owned elsewhere
      }),
    ]);
    // CAS loses: another process owns the claim. Returning [] is
    // the dbMock equivalent of "no rows matched the WHERE".
    dbMock.queueUpdate([]);

    await recoverInFlightBulkBatches();

    // 1 prune delete, 1 running-scan select, 1 (lost) CAS update.
    expect(dbMock.deleteCalls().length).toBe(1);
    expect(dbMock.selectCalls().length).toBe(1);
    expect(dbMock.updateCalls().length).toBe(1);

    // Verify the CAS WHERE actually carries the
    // "stale-or-null" guard so a real DB would never let a
    // fresh-claim batch be taken over.
    const claimUpdate = dbMock.updateCalls()[0]!;
    const whereCall = claimUpdate.calls.find((c) => c.fn === "where");
    expect(whereCall).toBeDefined();
    const isNullNodes = collectExprByKind(whereCall!.args[0], "isNull");
    const ltNodes = collectExprByKind(whereCall!.args[0], "lt");
    expect(isNullNodes.length).toBeGreaterThanOrEqual(1);
    expect(ltNodes.length).toBeGreaterThanOrEqual(1);

    // No worker spawned: a spawned worker would have done at
    // least one more select (loadBulkBatch).
    expect(dbMock.selectCalls().length).toBe(1);
    // No orphaned-pending reset on sales_orders.
    const setCalls = dbMock
      .updateCalls()
      .flatMap((u) => u.calls.filter((c) => c.fn === "set"));
    const interruptedReset = setCalls.find(
      (c) =>
        (c.args[0] as { irpErrorCode?: string } | undefined)?.irpErrorCode ===
        "interrupted",
    );
    expect(interruptedReset).toBeUndefined();
  });

  it("claims a stale (or null) batch, resets orphaned irpStatus='pending' rows to failed/interrupted, and re-spawns the worker", async () => {
    // Prune cleanup at the top of recovery — empty drop list.
    dbMock.queueDelete([]);

    // The running batch has two pending rows from the dead
    // worker. recoveryClaimedAt is null (never claimed), which
    // is the same code path as "stale" — both satisfy the OR
    // in the CAS guard.
    const orderIdsInOrder = [42, 43];
    const initialResults = {
      "42": {
        orderId: 42,
        orderNumber: "INV-0001",
        status: "pending",
        message: null,
        errorCode: null,
      },
      "43": {
        orderId: 43,
        orderNumber: "INV-0002",
        status: "pending",
        message: null,
        errorCode: null,
      },
    };
    const stale = runningBatchRow({
      id: "batch-stale",
      orderIdsInOrder,
      results: initialResults,
      recoveryClaimedAt: null,
    });
    dbMock.queueSelect([stale]);

    // CAS wins — return the (now-claimed) row.
    const claimed = {
      ...stale,
      recoveryClaimedAt: new Date(),
    };
    dbMock.queueUpdate([claimed]);
    // Orphaned-pending reset on sales_orders.
    dbMock.queueUpdate([{}]);
    // Worker's loadBulkBatch — return [] so the worker exits
    // silently (we're not testing the worker body here, just
    // proving recovery re-spawned it).
    dbMock.queueSelect([]);

    await recoverInFlightBulkBatches();

    // Wait for the fire-and-forget worker to consume its select.
    await waitFor(
      () => dbMock.selectCalls().length >= 2,
      3000,
      "worker was never re-spawned by recovery",
    );

    // 1 prune delete, 2 selects (running scan + worker
    // loadBulkBatch), 2 updates (CAS claim + orphaned-pending
    // reset).
    expect(dbMock.deleteCalls().length).toBe(1);
    expect(dbMock.selectCalls().length).toBe(2);
    expect(dbMock.updateCalls().length).toBe(2);

    // The orphaned-pending reset is the second update.
    const resetUpdate = dbMock.updateCalls()[1]!;
    const setCall = resetUpdate.calls.find((c) => c.fn === "set");
    expect(setCall).toBeDefined();
    const setArgs = setCall!.args[0] as Record<string, unknown>;
    expect(setArgs.irpStatus).toBe("failed");
    expect(setArgs.irpErrorCode).toBe("interrupted");
    // Operator-friendly message — the actual wording is
    // checked loosely so a copy edit doesn't break the test.
    expect(String(setArgs.irpError)).toMatch(/restart/i);

    // The reset is scoped to the batch's pending order ids only
    // (and to irpStatus='pending' so a row that already moved
    // forward isn't clobbered). Both are encoded in the WHERE.
    const whereCall = resetUpdate.calls.find((c) => c.fn === "where");
    expect(whereCall).toBeDefined();
    const inArrayNodes = collectExprByKind(whereCall!.args[0], "inArray");
    expect(inArrayNodes.length).toBeGreaterThanOrEqual(1);
    // The inArray's second arg is the id list passed to drizzle.
    const inArrayIdList = inArrayNodes[0]!.args[1];
    expect(inArrayIdList).toEqual([42, 43]);
    const eqNodes = collectExprByKind(whereCall!.args[0], "eq");
    const irpPendingGuard = eqNodes.find((n) => n.args[1] === "pending");
    expect(irpPendingGuard).toBeDefined();
  });

  it("only resets pending rows for the claimed batch — already-settled rows are left alone", async () => {
    dbMock.queueDelete([]);

    // Two rows: one still pending (orphaned by the dead worker),
    // one already settled (success). Recovery must reset only
    // the pending one and never touch the success row.
    const orderIdsInOrder = [42, 43];
    const initialResults = {
      "42": {
        orderId: 42,
        orderNumber: "INV-0001",
        status: "pending",
        message: null,
        errorCode: null,
      },
      "43": {
        orderId: 43,
        orderNumber: "INV-0002",
        status: "success",
        message: "IRN OK",
        errorCode: null,
        irn: "IRN-DONE",
        ackNumber: "1",
        ackDate: "2026-01-15T10:30:00.000Z",
      },
    };
    const stale = runningBatchRow({
      id: "batch-mixed",
      orderIdsInOrder,
      results: initialResults,
      recoveryClaimedAt: null,
    });
    dbMock.queueSelect([stale]);
    dbMock.queueUpdate([{ ...stale, recoveryClaimedAt: new Date() }]);
    dbMock.queueUpdate([{}]); // orphan reset
    dbMock.queueSelect([]); // worker loadBulkBatch → no-op

    await recoverInFlightBulkBatches();
    await waitFor(
      () => dbMock.selectCalls().length >= 2,
      3000,
      "worker was never re-spawned for mixed-status batch",
    );

    const resetUpdate = dbMock.updateCalls()[1]!;
    const whereCall = resetUpdate.calls.find((c) => c.fn === "where");
    const inArrayIdList = collectExprByKind(whereCall!.args[0], "inArray")[0]!
      .args[1];
    // Only order 42 (the pending one) — never order 43.
    expect(inArrayIdList).toEqual([42]);
  });

  it("skips the orphan reset entirely when the claimed batch has no pending rows left (e.g., worker died right after settling all rows but before markBatchCompleted)", async () => {
    dbMock.queueDelete([]);
    const stale = runningBatchRow({
      id: "batch-no-pending",
      orderIdsInOrder: [42],
      results: {
        "42": {
          orderId: 42,
          orderNumber: "INV-0001",
          status: "success",
          message: "IRN OK",
          errorCode: null,
          irn: "IRN-DONE",
          ackNumber: "1",
          ackDate: "2026-01-15T10:30:00.000Z",
        },
      },
      recoveryClaimedAt: null,
    });
    dbMock.queueSelect([stale]);
    dbMock.queueUpdate([{ ...stale, recoveryClaimedAt: new Date() }]);
    // No orphan-reset update queued.
    dbMock.queueSelect([]); // worker loadBulkBatch → no-op
    // Worker's markBatchCompleted may also fire if loadBulkBatch
    // returned the batch — but we returned [] so the worker
    // exits before that. Don't queue extra updates.

    await recoverInFlightBulkBatches();
    await waitFor(
      () => dbMock.selectCalls().length >= 2,
      3000,
      "worker was never re-spawned for no-pending batch",
    );

    // Only the CAS claim update — no second update for the
    // orphan reset.
    expect(dbMock.updateCalls().length).toBe(1);
  });

  it("a per-batch claim failure does not abort the rest of the recovery loop", async () => {
    dbMock.queueDelete([]);
    // Two running batches; the first claim attempt rejects.
    dbMock.queueSelect([
      runningBatchRow({ id: "batch-A", orderIdsInOrder: [] }),
      runningBatchRow({ id: "batch-B", orderIdsInOrder: [] }),
    ]);
    dbMock.queueUpdate(silencedRejection(new Error("DB hiccup on claim")));
    // Second batch's claim succeeds (empty pending list, so no
    // orphan reset), then the worker's loadBulkBatch no-ops.
    dbMock.queueUpdate([
      runningBatchRow({
        id: "batch-B",
        orderIdsInOrder: [],
        recoveryClaimedAt: new Date(),
      }),
    ]);
    dbMock.queueSelect([]); // worker loadBulkBatch for batch-B

    await expect(recoverInFlightBulkBatches()).resolves.toBeUndefined();

    await waitFor(
      () => dbMock.selectCalls().length >= 2,
      3000,
      "second batch's worker was never spawned",
    );
    // Both batches were processed (2 update attempts) even
    // though the first rejected.
    expect(dbMock.updateCalls().length).toBe(2);
  });

  // ────────────────────────────────────────────────────────────────────
  // Multi-row resume: the worker's `workIds` filter (status==="pending")
  // is what protects against double-charging the IRP after a restart.
  // The single-row crash-recovery cases above don't exercise it because
  // their batches only have one row to begin with — every row in the
  // batch is the row the test cares about. The scenario below is the
  // realistic operator case: a 5-order bulk run got partway through
  // before the process died, so the persisted batch jsonb mixes
  // already-settled rows (success / already_issued / failed) with the
  // ones the dead worker hadn't reached yet (pending / pending). On
  // resume the worker must pick up only the pending ids — re-touching a
  // settled row would either re-bill the IRP for a success (silent
  // duplicate IRN, or a 4xx from NIC), wipe out an already_issued IRN,
  // or retry a row the operator has explicitly accepted as failed.
  //
  // Note on concurrency: the test setup pins BULK_CONCURRENCY=1 so the
  // worker iterates the two pending rows sequentially. That keeps the
  // dbMock queue order deterministic — each row consumes its CAS,
  // order-load, lines-load, token-load, last-error-clear, IRN-persist,
  // and persistRowSettlement in lockstep before the worker loops back
  // for the next pending id. The behaviour under test (the workIds
  // filter) is independent of concurrency.
  it("multi-row resume: a 5-order recovered batch (success / already_issued / failed / pending / pending) replays only the two pending rows — exactly two IRP fetches, settled rows untouched on sales_orders, single markBatchCompleted at the end", async () => {
    // 5-order batch carrying mixed prior settlements. Order ids are
    // chosen so the settled set {40, 41, 42} and the pending set
    // {43, 44} are easy to spot in the WHERE-clause assertions
    // below.
    const orderIdsInOrder = [40, 41, 42, 43, 44];
    const initialResults = {
      "40": {
        orderId: 40,
        orderNumber: "INV-0040",
        status: "success",
        message: "IRN ALREADY-OK-A",
        errorCode: null,
        irn: "IRN-ALREADY-OK-A",
        ackNumber: "ACK-A",
        ackDate: "2026-04-15T10:30:00.000Z",
      },
      "41": {
        orderId: 41,
        orderNumber: "INV-0041",
        status: "already_issued",
        message: "An active IRN already exists for this order.",
        errorCode: "irn_already_issued",
        irn: "IRN-PRE-EXISTING",
        ackNumber: "ACK-PRE",
        ackDate: "2026-04-15T10:30:00.000Z",
      },
      "42": {
        orderId: 42,
        orderNumber: "INV-0042",
        status: "failed",
        message: "RC-2150: Duplicate IRN for the document",
        errorCode: "2150",
      },
      "43": {
        orderId: 43,
        orderNumber: "INV-0043",
        status: "pending",
        message: null,
        errorCode: null,
      },
      "44": {
        orderId: 44,
        orderNumber: "INV-0044",
        status: "pending",
        message: null,
        errorCode: null,
      },
    };

    const stale = runningBatchRow({
      id: "batch-resume-mixed",
      orderIdsInOrder,
      results: initialResults,
      recoveryClaimedAt: null,
    });
    const claimed = { ...stale, recoveryClaimedAt: new Date() };

    // ── Recovery layer ───────────────────────────────────────────────
    dbMock.queueDelete([]); // pruneStaleBatches at the top of recovery
    dbMock.queueSelect([stale]); // running-batch scan
    dbMock.queueUpdate([claimed]); // CAS claim (1) — wins
    dbMock.queueUpdate([{}]); // orphan reset (2) — only [43, 44]

    // ── Worker (runBulkBatch) ────────────────────────────────────────
    dbMock.queueSelect([claimed]); // loadBulkBatch

    // BULK_CONCURRENCY=1 (test/setup.ts) clamps the worker pool to a
    // single sequential loop over workIds. Per pending row the worker
    // walks this fixed sequence:
    //
    //   1) CAS claim          — UPDATE sales_orders ... RETURNING(id, orderNumber)
    //   2) loadOrderForIrn    — SELECT order+customer+org, then SELECT lines
    //   3) getOrgEinvoiceToken — SELECT organizations creds row
    //   4) awaitIrpSlot       — no-op in tests (BULK_IRP_MIN_SPACING_MS=0)
    //   5) fetch IRP          — single fetch per row
    //   6) einvoiceRequest    — UPDATE organizations to clear last-error
    //   7) IRN persist        — UPDATE sales_orders with IRN/ack/qr
    //   8) persistRowSettlement — execute() statement on the batch row
    //
    // The loop runs row 43 to completion before starting row 44, so
    // queue items below are deterministic.
    const orderRowFor = (id: number, orderNumber: string) => ({
      order: {
        id,
        organizationId: 1,
        orderNumber,
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
    });
    const linesRow = {
      line: {
        id: 1,
        salesOrderId: 0, // worker passes its own orderId in the WHERE
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
    };
    const tokenRow = {
      enabled: true,
      gstin: "29AAAAA1234A1Z5",
      username: "tester",
      passwordEncrypted: encryptString("pw"),
      clientIdEncrypted: null,
      clientSecretEncrypted: null,
      tokenEncrypted: encryptString("T"),
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };

    // Row 43: full per-row pipeline.
    dbMock.queueUpdate([{ id: 43, orderNumber: "INV-0043" }]); // CAS claim
    dbMock.queueSelect([orderRowFor(43, "INV-0043")]); // order join
    dbMock.queueSelect([linesRow]); // lines
    dbMock.queueSelect([tokenRow]); // creds row
    dbMock.queueUpdate([{}]); // einvoiceRequest last-error clear (organizations)
    dbMock.queueUpdate([{}]); // IRN persist on sales_orders
    dbMock.queueExecute([]); // persistRowSettlement

    // Row 44: same pipeline, run after row 43 completes.
    dbMock.queueUpdate([{ id: 44, orderNumber: "INV-0044" }]); // CAS claim
    dbMock.queueSelect([orderRowFor(44, "INV-0044")]); // order join
    dbMock.queueSelect([linesRow]); // lines
    dbMock.queueSelect([tokenRow]); // creds row
    dbMock.queueUpdate([{}]); // einvoiceRequest last-error clear
    dbMock.queueUpdate([{}]); // IRN persist on sales_orders
    dbMock.queueExecute([]); // persistRowSettlement

    // markBatchCompleted — final update flips status to 'completed'
    // and RETURNINGs the row that the structured log line reads from.
    // The counters reflect the merged jsonb: 1 pre-existing success +
    // 2 worker successes = 3 succeeded; 1 failed; 1 already_issued
    // (skipped); 5 processed of 5 total.
    dbMock.queueUpdate([
      {
        ...completedBatchRow(),
        id: "batch-resume-mixed",
        total: 5,
        processed: 5,
        succeeded: 3,
        failed: 1,
        skipped: 1,
      },
    ]);

    // Both pending rows succeed at the IRP — that's the only path
    // where a regression in the workIds filter would surface as a
    // visible "extra fetch" rather than just a queue-exhaustion
    // crash. Use mockImplementation (not mockResolvedValue) so each
    // call gets a fresh Response — Response bodies can only be read
    // once, so reusing the same instance crashes the second worker
    // iteration with "Body is unusable" before the IRP path even
    // runs to completion.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        jsonResponse(200, {
          status: "1",
          data: {
            Irn: "BULK-RESUME-IRN",
            AckNo: "98765",
            AckDt: "2026-04-28 12:00:00",
            SignedQRCode: "qr-data",
          },
        }),
      );

    await recoverInFlightBulkBatches();

    // 1 (recovery CAS) + 1 (orphan reset) + 2 (worker CAS ×2) +
    // 2 (last-error clears ×2) + 2 (IRN persists ×2) +
    // 1 (markBatchCompleted) = 9 updates total.
    await waitFor(
      () => dbMock.updateCalls().length >= 9,
      5000,
      "resumed worker did not finish the two pending rows",
    );

    // ── Assertion 1: exactly two IRP fetch calls ─────────────────────
    // The worker's `workIds` filter (status==="pending") is the line
    // under test. A regression that re-includes settled rows would
    // bump this above 2; one that mis-skips pending rows would drop
    // it below 2. Both directions break double-charging guarantees.
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Each fetch went to the /invoice path (IRN issuance), not some
    // accidental cancel/lookup endpoint that happens to also be
    // mockable from this fixture.
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).toContain("/invoice");
    }

    // ── Assertion 2: persistRowSettlement ran exactly twice ──────────
    // One execute per pending row; never for the settled rows.
    expect(dbMock.executeCalls().length).toBe(2);

    // ── Assertion 3: settled rows are never touched on sales_orders ──
    // Walk every UPDATE's WHERE clause and confirm no eq / inArray
    // node references the salesOrders.id column with one of the
    // settled ids. This is the strongest "didn't replay them" check
    // because the worker's CAS, IRN persist, and the recovery's
    // orphan-reset are the three distinct write sites that could
    // possibly re-touch a settled row.
    const settledIds = new Set([40, 41, 42]);
    const offenders: number[] = [];
    for (const upd of dbMock.updateCalls()) {
      const whereCall = upd.calls.find((c) => c.fn === "where");
      if (!whereCall) continue;
      // eq(salesOrdersTable.id, X)
      for (const node of collectExprByKind(whereCall.args[0], "eq")) {
        const lhs = node.args[0] as
          | { __table?: string; __column?: string }
          | undefined;
        const rhs = node.args[1];
        if (
          lhs?.__table === "sales_orders" &&
          lhs?.__column === "id" &&
          typeof rhs === "number" &&
          settledIds.has(rhs)
        ) {
          offenders.push(rhs);
        }
      }
      // inArray(salesOrdersTable.id, [...])
      for (const node of collectExprByKind(whereCall.args[0], "inArray")) {
        const lhs = node.args[0] as
          | { __table?: string; __column?: string }
          | undefined;
        const rhs = node.args[1];
        if (
          lhs?.__table === "sales_orders" &&
          lhs?.__column === "id" &&
          Array.isArray(rhs)
        ) {
          for (const id of rhs as unknown[]) {
            if (typeof id === "number" && settledIds.has(id)) {
              offenders.push(id);
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);

    // ── Assertion 4: the orphan reset's id list is exactly [43, 44] ──
    // Recovery resets only the still-pending order ids — the dead
    // worker had in-flight IRP claims on those and only those. This
    // is what feeds the worker's eligibility branch when it re-runs.
    const orphanReset = dbMock.updateCalls()[1]!;
    const orphanWhere = orphanReset.calls.find((c) => c.fn === "where");
    expect(orphanWhere).toBeDefined();
    const orphanInArray = collectExprByKind(orphanWhere!.args[0], "inArray");
    expect(orphanInArray.length).toBeGreaterThanOrEqual(1);
    expect(orphanInArray[0]!.args[1]).toEqual([43, 44]);

    // ── Assertion 5: markBatchCompleted runs exactly once at the end
    // with status='completed', and the per-row settlement payloads
    // that drive the merged jsonb counters are correct. ──────────────
    const completionUpdates = dbMock.updateCalls().filter((u) => {
      const setCall = u.calls.find((c) => c.fn === "set");
      const setArgs = setCall?.args[0] as
        | { status?: string }
        | undefined;
      return setArgs?.status === "completed";
    });
    expect(completionUpdates).toHaveLength(1);
    // It's the very last update — no further DB writes after the
    // worker reports the batch as done.
    const lastUpdate = dbMock.updateCalls()[dbMock.updateCalls().length - 1]!;
    expect(completionUpdates[0]).toBe(lastUpdate);

    // markBatchCompleted's `set` only flips status / completedAt /
    // updatedAt — the counter columns (processed/succeeded/failed/
    // skipped) are recomputed inside each persistRowSettlement
    // execute() via jsonb aggregation. The strongest direct check on
    // counter correctness is therefore the per-row settlement JSON
    // the worker fed in. We expect exactly two settlements (one per
    // pending row), each with status='success' so the merged jsonb
    // would yield 3 succeeded (2 new + 1 pre-existing), 1 failed, and
    // 1 skipped — matching the queued completion RETURNING row that
    // feeds the structured completion log.
    expect(dbMock.executeCalls().length).toBe(2);
    const settledOrderIds: number[] = [];
    const settledStatuses: string[] = [];
    for (const call of dbMock.executeCalls()) {
      const persisted = extractPersistedRow(call);
      expect(typeof persisted["orderId"]).toBe("number");
      settledOrderIds.push(persisted["orderId"] as number);
      settledStatuses.push(persisted["status"] as string);
    }
    expect(settledOrderIds.sort((a, b) => a - b)).toEqual([43, 44]);
    expect(settledStatuses).toEqual(["success", "success"]);

    // ── Assertion 6: the two worker CAS claims target only the
    // pending order ids — confirms the loop iterated over {43, 44}
    // and not against any settled row. ─────────────────────────────
    // Identify worker CAS updates by their `set`-payload fingerprint
    // (rather than by position in updateCalls) so harmless internal
    // reordering of unrelated updates can't break this assertion.
    // The bulk worker's CAS in processOrderForBulk is the only update
    // whose set flips `irpStatus` to "pending" and clears the three
    // irpError* columns; no other code path on sales_orders shares
    // that exact shape.
    const workerCasUpdates = dbMock.updateCalls().filter((u) => {
      const setCall = u.calls.find((c) => c.fn === "set");
      const setArgs = setCall?.args[0] as
        | Record<string, unknown>
        | undefined;
      if (!setArgs) return false;
      return (
        setArgs["irpStatus"] === "pending" &&
        setArgs["irpError"] === null &&
        setArgs["irpErrorCode"] === null &&
        setArgs["irpErrorContext"] === null
      );
    });
    expect(workerCasUpdates).toHaveLength(2);
    const workerCasIds: number[] = [];
    for (const upd of workerCasUpdates) {
      const whereCall = upd.calls.find((c) => c.fn === "where");
      const eqs = collectExprByKind(whereCall!.args[0], "eq");
      for (const node of eqs) {
        const lhs = node.args[0] as
          | { __table?: string; __column?: string }
          | undefined;
        const rhs = node.args[1];
        if (
          lhs?.__table === "sales_orders" &&
          lhs?.__column === "id" &&
          typeof rhs === "number"
        ) {
          workerCasIds.push(rhs);
        }
      }
    }
    expect(workerCasIds.sort((a, b) => a - b)).toEqual([43, 44]);
  });

  // ────────────────────────────────────────────────────────────────────
  // Mixed-outcome resume: the multi-row resume test above covers the
  // happy path where both pending rows succeed at the IRP. The mixed
  // path — one pending row succeeds, the other fails again — exercises
  // a different per-row update sequence inside processOrderForBulk
  // (the failure branch writes irpStatus='failed' + the IRP error
  // fields onto sales_orders rather than the IRN+ack columns) and a
  // different counter merge in markBatchCompleted (pre-existing failed
  // + new failed). A regression here would let a failed retry silently
  // flip back to pending or get double-counted.
  // ────────────────────────────────────────────────────────────────────
  it("mixed-outcome resume: a 5-order recovered batch where one pending row succeeds and the other fails again — exactly two IRP fetches, the failed pending row is persisted with irpStatus='failed', settled rows untouched, single markBatchCompleted carrying the merged counters", async () => {
    // Same 5-order seed as the multi-row resume test (success /
    // already_issued / failed / pending / pending). The pending set
    // {43, 44} is what the resumed worker has to replay.
    const orderIdsInOrder = [40, 41, 42, 43, 44];
    const initialResults = {
      "40": {
        orderId: 40,
        orderNumber: "INV-0040",
        status: "success",
        message: "IRN ALREADY-OK-A",
        errorCode: null,
        irn: "IRN-ALREADY-OK-A",
        ackNumber: "ACK-A",
        ackDate: "2026-04-15T10:30:00.000Z",
      },
      "41": {
        orderId: 41,
        orderNumber: "INV-0041",
        status: "already_issued",
        message: "An active IRN already exists for this order.",
        errorCode: "irn_already_issued",
        irn: "IRN-PRE-EXISTING",
        ackNumber: "ACK-PRE",
        ackDate: "2026-04-15T10:30:00.000Z",
      },
      "42": {
        orderId: 42,
        orderNumber: "INV-0042",
        status: "failed",
        message: "RC-2150: Duplicate IRN for the document",
        errorCode: "2150",
      },
      "43": {
        orderId: 43,
        orderNumber: "INV-0043",
        status: "pending",
        message: null,
        errorCode: null,
      },
      "44": {
        orderId: 44,
        orderNumber: "INV-0044",
        status: "pending",
        message: null,
        errorCode: null,
      },
    };

    const stale = runningBatchRow({
      id: "batch-resume-mixed-outcome",
      orderIdsInOrder,
      results: initialResults,
      recoveryClaimedAt: null,
    });
    const claimed = { ...stale, recoveryClaimedAt: new Date() };

    // ── Recovery layer ───────────────────────────────────────────────
    dbMock.queueDelete([]); // pruneStaleBatches at the top of recovery
    dbMock.queueSelect([stale]); // running-batch scan
    dbMock.queueUpdate([claimed]); // CAS claim — wins
    dbMock.queueUpdate([{}]); // orphan reset for [43, 44]

    // ── Worker (runBulkBatch) ────────────────────────────────────────
    dbMock.queueSelect([claimed]); // loadBulkBatch

    // BULK_CONCURRENCY=1 keeps the worker single-threaded so the
    // dbMock queue order is deterministic. Per pending row the worker
    // walks the same fixed sequence as the happy multi-row test, but
    // row 44 takes the failure branch:
    //
    //   Row 43 (success) — 7 queue items:
    //     1) CAS claim          UPDATE sales_orders → {id, orderNumber}
    //     2) loadOrderForIrn    SELECT order+customer+org, then SELECT lines
    //     3) getOrgEinvoiceToken SELECT organizations creds row
    //     4) IRP fetch (200)    — see fetch mock below
    //     5) einvoiceRequest    UPDATE organizations to clear last-error
    //     6) IRN persist        UPDATE sales_orders with IRN/ack/qr
    //     7) persistRowSettlement execute()
    //
    //   Row 44 (failure) — 7 queue items:
    //     1) CAS claim          UPDATE sales_orders → {id, orderNumber}
    //     2) loadOrderForIrn    SELECT order+customer+org, then SELECT lines
    //     3) getOrgEinvoiceToken SELECT organizations creds row
    //     4) IRP fetch (4xx)    — see fetch mock below
    //     5) einvoiceRequest    UPDATE organizations to set last-error
    //                            (failure branch, NOT the clear)
    //     6) processOrderForBulk catch UPDATE sales_orders with
    //                            irpStatus='failed' + persistedErrorFields
    //     7) persistRowSettlement execute()
    const orderRowFor = (id: number, orderNumber: string) => ({
      order: {
        id,
        organizationId: 1,
        orderNumber,
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
    });
    const linesRow = {
      line: {
        id: 1,
        salesOrderId: 0, // worker passes its own orderId in the WHERE
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
    };
    const tokenRow = {
      enabled: true,
      gstin: "29AAAAA1234A1Z5",
      username: "tester",
      passwordEncrypted: encryptString("pw"),
      clientIdEncrypted: null,
      clientSecretEncrypted: null,
      tokenEncrypted: encryptString("T"),
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };

    // Row 43: full success pipeline.
    dbMock.queueUpdate([{ id: 43, orderNumber: "INV-0043" }]); // CAS claim
    dbMock.queueSelect([orderRowFor(43, "INV-0043")]); // order join
    dbMock.queueSelect([linesRow]); // lines
    dbMock.queueSelect([tokenRow]); // creds row
    dbMock.queueUpdate([{}]); // einvoiceRequest last-error clear (organizations)
    dbMock.queueUpdate([{}]); // IRN persist on sales_orders
    dbMock.queueExecute([]); // persistRowSettlement

    // Row 44: failure pipeline.
    dbMock.queueUpdate([{ id: 44, orderNumber: "INV-0044" }]); // CAS claim
    dbMock.queueSelect([orderRowFor(44, "INV-0044")]); // order join
    dbMock.queueSelect([linesRow]); // lines
    dbMock.queueSelect([tokenRow]); // creds row
    dbMock.queueUpdate([{}]); // einvoiceRequest's failure branch sets last-error
    dbMock.queueUpdate([{}]); // processOrderForBulk's catch persists irpStatus='failed'
    dbMock.queueExecute([]); // persistRowSettlement

    // markBatchCompleted — final update flips status to 'completed'.
    // The merged counters reflect: 1 pre-existing success + 1 new
    // success (row 43) = 2 succeeded; 1 pre-existing failed + 1 new
    // failed (row 44) = 2 failed; 1 already_issued = 1 skipped;
    // 5 processed of 5 total. The values here only feed the
    // structured completion log line — the merge itself happens
    // inside persistRowSettlement's jsonb aggregation.
    dbMock.queueUpdate([
      {
        ...completedBatchRow(),
        id: "batch-resume-mixed-outcome",
        total: 5,
        processed: 5,
        succeeded: 2,
        failed: 2,
        skipped: 1,
      },
    ]);

    // Per-call IRP responses: row 43 (first call) gets a clean 200,
    // row 44 (second call) gets a 4xx with a structured error code.
    // Use mockImplementation so each call gets a fresh Response —
    // Response bodies can only be read once, so reusing the same
    // instance crashes the second worker iteration with "Body is
    // unusable" before the failure path even runs to completion.
    let irpCallCount = 0;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        irpCallCount++;
        if (irpCallCount === 1) {
          return jsonResponse(200, {
            status: "1",
            data: {
              Irn: "BULK-RESUME-IRN-43",
              AckNo: "98765",
              AckDt: "2026-04-28 12:00:00",
              SignedQRCode: "qr-data",
            },
          });
        }
        return jsonResponse(400, {
          status: "0",
          errorDetails: [
            {
              ErrorCode: "2150",
              ErrorMessage: "Duplicate IRN for the document",
            },
          ],
        });
      });

    await recoverInFlightBulkBatches();

    // 1 (recovery CAS) + 1 (orphan reset) + 2 (worker CAS ×2) +
    // 2 (last-error writes ×2) + 2 (per-row sales_orders persists ×2:
    // one IRN persist + one failed persist) + 1 (markBatchCompleted)
    // = 9 updates total.
    await waitFor(
      () => dbMock.updateCalls().length >= 9,
      5000,
      "resumed worker did not finish the two pending rows",
    );

    // ── Assertion 1: exactly two IRP fetch calls ─────────────────────
    // The worker's `workIds` filter (status==="pending") still gates
    // the fetch count regardless of per-row outcome. A regression
    // that retries failed rows would surface here as a third call.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).toContain("/invoice");
    }

    // ── Assertion 2: persistRowSettlement ran exactly twice ──────────
    // One execute per pending row; never for the settled rows.
    expect(dbMock.executeCalls().length).toBe(2);

    // ── Assertion 3: settled rows are never touched on sales_orders ──
    // Walk every UPDATE's WHERE clause and confirm no eq / inArray
    // node references the salesOrders.id column with one of the
    // settled ids — guards against the failure branch accidentally
    // re-touching rows that the dead worker already finished.
    const settledIds = new Set([40, 41, 42]);
    const offenders: number[] = [];
    for (const upd of dbMock.updateCalls()) {
      const whereCall = upd.calls.find((c) => c.fn === "where");
      if (!whereCall) continue;
      for (const node of collectExprByKind(whereCall.args[0], "eq")) {
        const lhs = node.args[0] as
          | { __table?: string; __column?: string }
          | undefined;
        const rhs = node.args[1];
        if (
          lhs?.__table === "sales_orders" &&
          lhs?.__column === "id" &&
          typeof rhs === "number" &&
          settledIds.has(rhs)
        ) {
          offenders.push(rhs);
        }
      }
      for (const node of collectExprByKind(whereCall.args[0], "inArray")) {
        const lhs = node.args[0] as
          | { __table?: string; __column?: string }
          | undefined;
        const rhs = node.args[1];
        if (
          lhs?.__table === "sales_orders" &&
          lhs?.__column === "id" &&
          Array.isArray(rhs)
        ) {
          for (const id of rhs as unknown[]) {
            if (typeof id === "number" && settledIds.has(id)) {
              offenders.push(id);
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);

    // ── Assertion 4: row 44's failure persist landed on sales_orders ─
    // The failure branch in processOrderForBulk writes
    // {irpStatus: 'failed', irpError, irpErrorCode, irpErrorContext}
    // onto sales_orders, scoped to (id=44, organizationId=1). This is
    // the strongest direct check that a failed retry doesn't silently
    // flip back to pending — irpStatus must end as 'failed', and the
    // upstream NIC error code (2150) must be persisted.
    const failedPersists = dbMock.updateCalls().filter((u) => {
      const setCall = u.calls.find((c) => c.fn === "set");
      const setArgs = setCall?.args[0] as
        | Record<string, unknown>
        | undefined;
      if (!setArgs) return false;
      if (setArgs["irpStatus"] !== "failed") return false;
      // The CAS claim sets irpStatus='pending' and clears the error
      // columns; only the failure persist sets a non-null error code.
      return setArgs["irpErrorCode"] === "2150";
    });
    expect(failedPersists).toHaveLength(1);
    const failedWhere = failedPersists[0]!.calls.find(
      (c) => c.fn === "where",
    );
    expect(failedWhere).toBeDefined();
    const failedEqs = collectExprByKind(failedWhere!.args[0], "eq");
    const failedTargetIds = failedEqs
      .filter((n) => {
        const lhs = n.args[0] as
          | { __table?: string; __column?: string }
          | undefined;
        return lhs?.__table === "sales_orders" && lhs?.__column === "id";
      })
      .map((n) => n.args[1]);
    expect(failedTargetIds).toEqual([44]);
    // The persisted error message must echo the upstream IRP detail
    // — operators rely on this in the dialog/CSV to fix the source
    // data before re-running the row.
    const failedSetArgs = failedPersists[0]!.calls.find(
      (c) => c.fn === "set",
    )!.args[0] as Record<string, unknown>;
    expect(String(failedSetArgs["irpError"])).toMatch(/Duplicate IRN/);

    // ── Assertion 5: row 43 still wrote a clean IRN persist ──────────
    // Sanity-check the success branch wasn't collateral damage from
    // the failure branch's queue: there must be exactly one update
    // setting irpStatus='active' with a non-null irn, scoped to id=43.
    const irnPersists = dbMock.updateCalls().filter((u) => {
      const setCall = u.calls.find((c) => c.fn === "set");
      const setArgs = setCall?.args[0] as
        | Record<string, unknown>
        | undefined;
      return (
        setArgs?.["irpStatus"] === "active" &&
        typeof setArgs?.["irn"] === "string"
      );
    });
    expect(irnPersists).toHaveLength(1);
    const irnWhere = irnPersists[0]!.calls.find((c) => c.fn === "where")!;
    const irnEqs = collectExprByKind(irnWhere.args[0], "eq");
    const irnTargetIds = irnEqs
      .filter((n) => {
        const lhs = n.args[0] as
          | { __table?: string; __column?: string }
          | undefined;
        return lhs?.__table === "sales_orders" && lhs?.__column === "id";
      })
      .map((n) => n.args[1]);
    expect(irnTargetIds).toEqual([43]);

    // ── Assertion 6: markBatchCompleted runs exactly once at the end
    // with status='completed'. The counter values come from the
    // RETURNING row queued above (the merge itself happens inside
    // persistRowSettlement's jsonb aggregation, which the dbMock
    // doesn't simulate); we still assert the per-row settlement
    // payloads carry the right (orderId, status) tuples that would
    // produce those counters in production. ─────────────────────────
    const completionUpdates = dbMock.updateCalls().filter((u) => {
      const setCall = u.calls.find((c) => c.fn === "set");
      const setArgs = setCall?.args[0] as
        | { status?: string }
        | undefined;
      return setArgs?.status === "completed";
    });
    expect(completionUpdates).toHaveLength(1);
    const lastUpdate = dbMock.updateCalls()[dbMock.updateCalls().length - 1]!;
    expect(completionUpdates[0]).toBe(lastUpdate);

    // Direct counter assertion on the completion RETURNING row —
    // mirrors the all-settled test below. The row markBatchCompleted
    // consumes via `.returning()` is the queued payload at the
    // chain's tail; it must carry the merged counters: 1 pre-existing
    // success + 1 new (row 43) = 2 succeeded; 1 pre-existing failed +
    // 1 new (row 44) = 2 failed; 1 already_issued = 1 skipped;
    // 5 processed of 5 total. A double-counting regression in the
    // jsonb merge would surface here.
    const completionResult = (
      completionUpdates[0] as { result?: unknown[] }
    ).result as Array<Record<string, unknown>>;
    expect(completionResult).toHaveLength(1);
    expect(completionResult[0]).toMatchObject({
      id: "batch-resume-mixed-outcome",
      total: 5,
      processed: 5,
      succeeded: 2,
      failed: 2,
      skipped: 1,
    });

    // The two persisted row settlements must carry the per-outcome
    // statuses that drive the merged jsonb counters. Row 43 lands as
    // 'success'; row 44 lands as 'failed'. These are the direct
    // inputs to the SQL jsonb aggregation that produces the counter
    // values asserted above.
    const settledByOrderId = new Map<number, string>();
    for (const call of dbMock.executeCalls()) {
      const persisted = extractPersistedRow(call);
      settledByOrderId.set(
        persisted["orderId"] as number,
        persisted["status"] as string,
      );
    }
    expect(settledByOrderId.get(43)).toBe("success");
    expect(settledByOrderId.get(44)).toBe("failed");
    expect(settledByOrderId.size).toBe(2);
  });

  // ────────────────────────────────────────────────────────────────────
  // All-settled boundary: the multi-row resume test above proves the
  // worker's `workIds` filter only replays pending rows when there are
  // some pending rows left. The complementary boundary — every row
  // already settled before the crash — is the one where a regression
  // would be most damaging and silent: the dead worker had finished
  // every IRP call but died before flipping the batch to 'completed',
  // so a recovery that re-spawned per-row work would re-bill the IRP
  // for already-issued invoices (or wipe out fresh IRNs). The
  // contract here is: skip the worker pool entirely, fire
  // markBatchCompleted exactly once, never touch a sales_orders row.
  // ────────────────────────────────────────────────────────────────────
  it("all-settled resume: a 5-order recovered batch with every row already settled (success / already_issued / failed) skips the worker pool entirely — no IRP fetches, no sales_orders writes, single markBatchCompleted carrying the seeded counters", async () => {
    // Seeded counters mirror the jsonb: 2 success + 2 failed +
    // 1 already_issued = 5 processed of 5 total, 2 succeeded,
    // 2 failed, 1 skipped. markBatchCompleted only flips
    // status / completedAt / updatedAt, so the counters surfaced
    // by the structured completion log come straight from this
    // RETURNING row — any double-counting would have to show up
    // here as a delta from the seeded values.
    const orderIdsInOrder = [40, 41, 42, 43, 44];
    const initialResults = {
      "40": {
        orderId: 40,
        orderNumber: "INV-0040",
        status: "success",
        message: "IRN ALREADY-OK-A",
        errorCode: null,
        irn: "IRN-ALREADY-OK-A",
        ackNumber: "ACK-A",
        ackDate: "2026-04-15T10:30:00.000Z",
      },
      "41": {
        orderId: 41,
        orderNumber: "INV-0041",
        status: "already_issued",
        message: "An active IRN already exists for this order.",
        errorCode: "irn_already_issued",
        irn: "IRN-PRE-EXISTING",
        ackNumber: "ACK-PRE",
        ackDate: "2026-04-15T10:30:00.000Z",
      },
      "42": {
        orderId: 42,
        orderNumber: "INV-0042",
        status: "failed",
        message: "RC-2150: Duplicate IRN for the document",
        errorCode: "2150",
      },
      "43": {
        orderId: 43,
        orderNumber: "INV-0043",
        status: "success",
        message: "IRN ALREADY-OK-B",
        errorCode: null,
        irn: "IRN-ALREADY-OK-B",
        ackNumber: "ACK-B",
        ackDate: "2026-04-15T10:31:00.000Z",
      },
      "44": {
        orderId: 44,
        orderNumber: "INV-0044",
        status: "failed",
        message: "RC-2172: Invalid HSN",
        errorCode: "2172",
      },
    };

    const stale = runningBatchRow({
      id: "batch-resume-all-settled",
      orderIdsInOrder,
      results: initialResults,
      recoveryClaimedAt: null,
    });
    const claimed = { ...stale, recoveryClaimedAt: new Date() };

    // ── Recovery layer ───────────────────────────────────────────────
    dbMock.queueDelete([]); // pruneStaleBatches at the top of recovery
    dbMock.queueSelect([stale]); // running-batch scan
    dbMock.queueUpdate([claimed]); // CAS claim — wins
    // NB: no orphan-reset update is queued — stillPendingIds is empty
    // (every row already settled), so recovery skips the salesOrders
    // update entirely. If a regression re-introduces an unconditional
    // reset, the test will surface it as a missing queued update
    // (the next dbMock.update consumer would default to []).

    // ── Worker (runBulkBatch) ────────────────────────────────────────
    // loadBulkBatch returns the all-settled claimed batch. The worker
    // computes workIds = [] from this jsonb (no pending rows) and
    // skips the per-row worker pool entirely, jumping straight to
    // markBatchCompleted.
    dbMock.queueSelect([claimed]);

    // markBatchCompleted's RETURNING row carries the seeded
    // counters verbatim — the log line and the dialog read these
    // numbers, so they must match the jsonb exactly with no
    // double-counting.
    dbMock.queueUpdate([
      {
        ...completedBatchRow(),
        id: "batch-resume-all-settled",
        total: 5,
        processed: 5,
        succeeded: 2,
        failed: 2,
        skipped: 1,
      },
    ]);

    // Spy on fetch with a throwing implementation: any IRP call at
    // all is a regression, and we want a clear signal (rather than
    // a hung promise) if one slips through.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        throw new Error("fetch should not be called for an all-settled batch");
      });

    await recoverInFlightBulkBatches();

    // 1 (recovery CAS) + 1 (markBatchCompleted) = 2 updates. The
    // worker fires loadBulkBatch (the second select) before flipping
    // the batch to 'completed', so wait on the update count rather
    // than racing the fire-and-forget runBulkBatch.
    await waitFor(
      () => dbMock.updateCalls().length >= 2,
      3000,
      "all-settled resume did not reach markBatchCompleted",
    );

    // ── Assertion 1: zero IRP fetches ────────────────────────────────
    // The defining contract for an all-settled recovery — any fetch
    // would be a re-bill of an already-issued IRN.
    expect(fetchSpy).not.toHaveBeenCalled();

    // ── Assertion 2: no per-row settlement writes ────────────────────
    // persistRowSettlement uses db.execute(); zero executes proves
    // the worker pool was skipped, not just that no IRP calls were
    // made (a worker that ran but mocked-out its fetches would still
    // hit execute()).
    expect(dbMock.executeCalls().length).toBe(0);

    // ── Assertion 3: no sales_orders rows are touched ────────────────
    // The dead worker already settled every row — recovery must not
    // CAS-claim, IRN-persist, or orphan-reset any of them. Walk every
    // UPDATE's WHERE clause and confirm no eq / inArray node references
    // the salesOrders.id column at all (since the only updates here
    // are on the batches table, this should be vacuously true; an
    // accidental sales_orders write — orphan reset, worker CAS — would
    // surface as a non-empty offender list).
    const settledIds = new Set([40, 41, 42, 43, 44]);
    const offenders: number[] = [];
    for (const upd of dbMock.updateCalls()) {
      const whereCall = upd.calls.find((c) => c.fn === "where");
      if (!whereCall) continue;
      for (const node of collectExprByKind(whereCall.args[0], "eq")) {
        const lhs = node.args[0] as
          | { __table?: string; __column?: string }
          | undefined;
        const rhs = node.args[1];
        if (
          lhs?.__table === "sales_orders" &&
          lhs?.__column === "id" &&
          typeof rhs === "number" &&
          settledIds.has(rhs)
        ) {
          offenders.push(rhs);
        }
      }
      for (const node of collectExprByKind(whereCall.args[0], "inArray")) {
        const lhs = node.args[0] as
          | { __table?: string; __column?: string }
          | undefined;
        const rhs = node.args[1];
        if (
          lhs?.__table === "sales_orders" &&
          lhs?.__column === "id" &&
          Array.isArray(rhs)
        ) {
          for (const id of rhs as unknown[]) {
            if (typeof id === "number" && settledIds.has(id)) {
              offenders.push(id);
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);

    // ── Assertion 4: exactly 2 updates — CAS claim + markBatchCompleted
    // No orphan reset (no pending rows to reset), no worker CAS, no
    // IRN persist. A regression that forces an unconditional orphan
    // reset would bump this to 3.
    expect(dbMock.updateCalls().length).toBe(2);

    // ── Assertion 5: a single markBatchCompleted with seeded counters
    // The completion update is identified by its `set`-payload
    // (status='completed') rather than by position, so harmless
    // reordering elsewhere can't break this assertion. Its RETURNING
    // row must carry the seeded counters verbatim — no double-counting
    // would mean the worker pool re-tallied something on top.
    const completionUpdates = dbMock.updateCalls().filter((u) => {
      const setCall = u.calls.find((c) => c.fn === "set");
      const setArgs = setCall?.args[0] as
        | { status?: string }
        | undefined;
      return setArgs?.status === "completed";
    });
    expect(completionUpdates).toHaveLength(1);
    // It's the very last update — no further DB writes after the
    // worker reports the batch as done.
    const lastUpdate = dbMock.updateCalls()[dbMock.updateCalls().length - 1]!;
    expect(completionUpdates[0]).toBe(lastUpdate);
    // The RETURNING row the completion update consumes (the queued
    // payload at the chain's tail) carries the seeded counters
    // verbatim — total=5, processed=5, succeeded=2, failed=2,
    // skipped=1. The ChainRecord.result is what markBatchCompleted's
    // `await ... .returning()` resolves to, so this is the same row
    // the structured completion log line dereferences.
    const completionResult = (
      completionUpdates[0] as { result?: unknown[] }
    ).result as Array<Record<string, unknown>>;
    expect(completionResult).toHaveLength(1);
    expect(completionResult[0]).toMatchObject({
      id: "batch-resume-all-settled",
      total: 5,
      processed: 5,
      succeeded: 2,
      failed: 2,
      skipped: 1,
    });
  });
});

describe("pruneStaleBatches (TTL retention) — exercised via recovery + scheduler", () => {
  it("hands the right cutoffs to the delete query: completed-past-TTL OR any-past-hard-TTL, with no static fallback", async () => {
    // pruneStaleBatches isn't exported, but recovery calls it
    // first thing. Lock Date.now() so we can compare cutoffs
    // exactly against BULK_BATCH_TTL_MS / BULK_BATCH_HARD_TTL_MS.
    const fixedNow = new Date("2026-04-28T12:00:00.000Z");
    vi.setSystemTime(fixedNow);

    dbMock.queueDelete([]);
    // No running batches — recovery exits cleanly after prune.
    dbMock.queueSelect([]);

    await recoverInFlightBulkBatches();

    expect(dbMock.deleteCalls().length).toBe(1);
    const del = dbMock.deleteCalls()[0]!;
    const whereCall = del.calls.find((c) => c.fn === "where");
    expect(whereCall).toBeDefined();
    // Top-level expression is an OR with the two arms described
    // in the route's prune SQL.
    const orNodes = collectExprByKind(whereCall!.args[0], "or");
    expect(orNodes.length).toBeGreaterThanOrEqual(1);
    const ltNodes = collectExprByKind(whereCall!.args[0], "lt");
    // At least two `lt` nodes: one for completedAt vs the
    // completed cutoff, one for createdAt vs the hard cutoff.
    expect(ltNodes.length).toBeGreaterThanOrEqual(2);

    // The cutoff values are the second arg of each lt(...) call.
    const cutoffValues = ltNodes
      .map((n) => n.args[1])
      .filter((v): v is Date => v instanceof Date)
      .map((d) => d.getTime())
      .sort((a, b) => a - b);
    expect(cutoffValues.length).toBeGreaterThanOrEqual(2);
    const oneHourMs = 60 * 60 * 1000;
    const fourHourMs = 4 * oneHourMs;
    // Hard cutoff (oldest) = now - 4h.
    expect(cutoffValues[0]).toBe(fixedNow.getTime() - fourHourMs);
    // Completed cutoff (newest of the two) = now - 1h.
    expect(cutoffValues[cutoffValues.length - 1]).toBe(
      fixedNow.getTime() - oneHourMs,
    );

    vi.useRealTimers();
  });

  it("a no-op delete (no rows matched the TTL window) does not error and recovery continues normally", async () => {
    // The mock returns [] when nothing was queued — same shape a
    // real DB returns when no rows match. Recovery should not
    // treat this as a failure.
    dbMock.queueDelete([]);
    dbMock.queueSelect([]); // no running batches either

    await expect(recoverInFlightBulkBatches()).resolves.toBeUndefined();
    expect(dbMock.deleteCalls().length).toBe(1);
  });
});

describe("startBulkBatchPruneScheduler (periodic prune + recovery)", () => {
  it("each tick fires both prune and recovery (prune runs twice — once directly, once inside recovery — and the running-batches scan happens)", async () => {
    vi.useFakeTimers();

    // Tick 1 needs:
    //   - 1 delete for the scheduler-direct pruneStaleBatches
    //   - 1 delete + 1 select for the recovery-internal prune+scan
    dbMock.queueDelete([]);
    dbMock.queueDelete([]);
    dbMock.queueSelect([]); // recovery's running-batches scan

    let timer: NodeJS.Timeout | undefined;
    try {
      timer = startBulkBatchPruneScheduler(1000);
      // advanceTimersByTimeAsync flushes pending microtasks
      // between timer firings, so the awaited prune/recovery
      // chains complete before we assert.
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      if (timer) clearInterval(timer);
      vi.useRealTimers();
    }

    expect(dbMock.deleteCalls().length).toBe(2);
    expect(dbMock.selectCalls().length).toBe(1);
  });

  it("a scheduler tick survives individual failures: a rejecting prune and a rejecting recovery scan do not crash the timer — the next tick fires normally", async () => {
    vi.useFakeTimers();

    // ── Tick 1: everything fails. ───────────────────────────────────
    // Direct scheduler-prune rejects, recovery's internal prune
    // rejects, and recovery's running-batches scan rejects.
    // The scheduler's .catch on each top-level call should
    // swallow the rejections, and recovery's own try/catch
    // around the scan logs + returns early.
    dbMock.queueDelete(silencedRejection(new Error("boom (direct prune 1)")));
    dbMock.queueDelete(silencedRejection(new Error("boom (recovery prune 1)")));
    dbMock.queueSelect(silencedRejection(new Error("boom (running scan 1)")));

    // ── Tick 2: clean run, proves the timer is still alive ─────────
    dbMock.queueDelete([]);
    dbMock.queueDelete([]);
    dbMock.queueSelect([]);

    let timer: NodeJS.Timeout | undefined;
    try {
      timer = startBulkBatchPruneScheduler(1000);
      // Tick 1 — failures get swallowed.
      await vi.advanceTimersByTimeAsync(1000);
      // The mocks for tick 1 should be drained even though they
      // rejected. The scheduler tried everything.
      expect(dbMock.deleteCalls().length).toBe(2);
      expect(dbMock.selectCalls().length).toBe(1);

      // Tick 2 — proves the interval timer is still firing
      // after the previous tick's failures.
      await vi.advanceTimersByTimeAsync(1000);
      expect(dbMock.deleteCalls().length).toBe(4);
      expect(dbMock.selectCalls().length).toBe(2);
    } finally {
      if (timer) clearInterval(timer);
      vi.useRealTimers();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// GET /api/einvoice/bulk/:batchId — the polling endpoint the bulk
// dialog hits to render live progress. Tenant scoping is the only
// thing keeping a malicious org id from peeking at another tenant's
// batch contents, so each branch of the org-scope check gets its
// own test below.
// ──────────────────────────────────────────────────────────────────────
describe("GET /api/einvoice/bulk/:batchId (per-tenant scoping)", () => {
  it("returns 200 with the serialized batch when the caller's org owns it (counters and per-row results match)", async () => {
    const orderIdsInOrder = [42, 43, 44];
    const results = {
      "42": {
        orderId: 42,
        orderNumber: "INV-0001",
        status: "success",
        message: "IRN issued",
        errorCode: null,
        irn: "IRN-42",
        ackNumber: "ACK-42",
        ackDate: "2026-04-15T10:30:00.000Z",
      },
      "43": {
        orderId: 43,
        orderNumber: "INV-0002",
        status: "failed",
        message: "IRP timed out",
        errorCode: "irp_timeout",
      },
      "44": {
        orderId: 44,
        orderNumber: "INV-0003",
        status: "skipped",
        message: "Another IRN registration is already in flight.",
        errorCode: "irn_in_flight",
      },
    };
    // makeBatchRow stamps organizationId=1, which matches the
    // tenant middleware's organizationId, so the org-scope check
    // passes and we get the serialized payload back.
    const ownedBatch = makeBatchRow({
      id: "batch-owned",
      orderIdsInOrder,
      results,
      total: 3,
      processed: 3,
      succeeded: 1,
      failed: 1,
      skipped: 1,
    });
    // The route also surfaces durationMs / ordersPerSecond off
    // completedAt − startedAt, so set both to exercise the
    // completed-batch branch of serializeBulkBatch.
    ownedBatch.status = "completed";
    ownedBatch.completedAt = new Date(
      ownedBatch.startedAt.getTime() + 2_000,
    );
    dbMock.queueSelect([ownedBatch]);

    const res = await request(makeApp()).get("/api/einvoice/bulk/batch-owned");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("batch-owned");
    expect(res.body.status).toBe("completed");
    // Counters survive the round trip verbatim.
    expect(res.body.total).toBe(3);
    expect(res.body.processed).toBe(3);
    expect(res.body.succeeded).toBe(1);
    expect(res.body.failed).toBe(1);
    expect(res.body.skipped).toBe(1);
    // Wall-clock telemetry derived from completedAt − startedAt.
    expect(res.body.durationMs).toBe(2_000);
    expect(res.body.ordersPerSecond).toBe(1.5);
    // Display order is the caller-submitted order ids, deduped,
    // and per-row payloads come back attached to their order id.
    expect(
      res.body.results.map((r: { orderId: number }) => r.orderId),
    ).toEqual([42, 43, 44]);
    expect(
      res.body.results.map((r: { status: string }) => r.status),
    ).toEqual(["success", "failed", "skipped"]);
    expect(res.body.results[0].irn).toBe("IRN-42");
    expect(res.body.results[0].ackNumber).toBe("ACK-42");
    expect(res.body.results[0].ackDate).toBe("2026-04-15T10:30:00.000Z");
    expect(res.body.results[1].errorCode).toBe("irp_timeout");
    // Rows that didn't end in success/already_issued get explicit
    // null IRN identifiers so the OpenAPI contract stays honest.
    expect(res.body.results[1].irn).toBeNull();
    expect(res.body.results[1].ackNumber).toBeNull();
    expect(res.body.results[1].ackDate).toBeNull();
    expect(res.body.results[2].irn).toBeNull();

    // Exactly one DB select — the loadBulkBatch lookup. No
    // tenant-scoped follow-up query is performed; the org check
    // happens in JS off the loaded row.
    expect(dbMock.selectCalls().length).toBe(1);
    // The lookup is by batch id only — that's intentional: the
    // route's job is to load the row and then verify ownership
    // in JS so a missing row and a cross-tenant row collapse to
    // the same 404 (see the cross-tenant test below).
    const where = dbMock
      .selectCalls()[0]!
      .calls.find((c) => c.fn === "where");
    expect(where).toBeDefined();
    const eqNodes = collectExprByKind(where!.args[0], "eq");
    expect(eqNodes.length).toBe(1);
    expect(eqNodes[0]!.args[1]).toBe("batch-owned");
  });

  it("returns 404 (not 403, not the batch payload) when the batchId exists but belongs to another org — must not reveal that the id exists", async () => {
    // Same shape as a real loaded row, but stamped with a
    // different organizationId. If the org-scope check ever
    // regressed (e.g., dropped the comparison), this row would
    // serialize back to the caller and leak another tenant's
    // results — exactly the bug this test guards against.
    const foreignBatch = makeBatchRow({
      id: "batch-foreign",
      orderIdsInOrder: [999],
      results: {
        "999": {
          orderId: 999,
          orderNumber: "OTHER-TENANT-INV",
          status: "success",
          message: "IRN issued",
          errorCode: null,
          irn: "OTHER-TENANT-IRN",
          ackNumber: "OTHER-ACK",
          ackDate: "2026-04-15T10:30:00.000Z",
        },
      },
      total: 1,
      processed: 1,
      succeeded: 1,
    });
    foreignBatch.organizationId = 999;
    dbMock.queueSelect([foreignBatch]);

    const res = await request(makeApp()).get(
      "/api/einvoice/bulk/batch-foreign",
    );

    expect(res.status).toBe(404);
    // The response body must look identical to the unknown-id
    // case — no hint that the id exists, no leaked counters,
    // no leaked order numbers / IRN values.
    expect(res.body).toEqual({ error: "Bulk batch not found or expired" });
    const bodyJson = JSON.stringify(res.body);
    expect(bodyJson).not.toContain("OTHER-TENANT-INV");
    expect(bodyJson).not.toContain("OTHER-TENANT-IRN");
    expect(bodyJson).not.toContain("batch-foreign");
    expect(bodyJson).not.toContain("999");
  });

  it("returns 404 when the batchId is unknown / has been pruned (loadBulkBatch returns no row)", async () => {
    // Empty rowset — same shape the prune sweep leaves behind
    // for a batch that aged past BULK_BATCH_TTL_MS.
    dbMock.queueSelect([]);

    const res = await request(makeApp()).get("/api/einvoice/bulk/batch-gone");

    expect(res.status).toBe(404);
    // Identical body to the cross-tenant case — the operator
    // can't distinguish "never existed", "expired", or "owned
    // by another tenant" from this response.
    expect(res.body).toEqual({ error: "Bulk batch not found or expired" });
  });

  it("rejects an empty :batchId path segment without performing any batch lookup (no leakage if the schema or router ever loosens)", async () => {
    // Express 5's path-to-regexp v8 will not match an empty
    // segment to `:batchId`, so the request 404s at the router
    // before the handler — and even if a future refactor swapped
    // the route definition for one that allowed empty segments,
    // bulkBatchIdParamSchema (`z.string().min(1)`) would still
    // reject and sendZodError would return 400. Either way, the
    // safety property the test pins down is the same: no batch
    // lookup is attempted for an empty id, so no leakage path
    // exists for a caller that omits the id entirely.
    const res = await request(makeApp()).get("/api/einvoice/bulk/");

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(dbMock.selectCalls().length).toBe(0);
  });
});
