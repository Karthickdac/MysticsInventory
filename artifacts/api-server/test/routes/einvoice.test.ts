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

// ──────────────────────────────────────────────────────────────────────
// Module mocks. These must come before any code that imports the
// einvoice route or its transitive dependencies.
// ──────────────────────────────────────────────────────────────────────
vi.mock("@workspace/db", () => createDbModuleMock());
vi.mock("drizzle-orm", () => ({
  eq: (...args: unknown[]) => ({ kind: "eq", args }),
  and: (...args: unknown[]) => ({ kind: "and", args }),
  or: (...args: unknown[]) => ({ kind: "or", args }),
  inArray: (...args: unknown[]) => ({ kind: "inArray", args }),
  isNull: (...args: unknown[]) => ({ kind: "isNull", args }),
  sql: (...args: unknown[]) => ({ kind: "sql", args }),
}));
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

function createDbModuleMock() {
  const tableSentinel = (name: string): Record<string, unknown> =>
    new Proxy(
      { __table: name },
      {
        get: (target, prop) => {
          if (prop in target) return (target as Record<string, unknown>)[prop as string];
          return { __table: name, __column: String(prop) };
        },
      },
    );
  return {
    db: {
      select: (..._args: unknown[]) => dbMock.select(),
      update: (..._args: unknown[]) => dbMock.update(),
      insert: (..._args: unknown[]) => dbMock.insert(),
      delete: (..._args: unknown[]) => dbMock.delete(),
    },
    organizationsTable: tableSentinel("organizations"),
    organizationMembersTable: tableSentinel("organization_members"),
    salesOrdersTable: tableSentinel("sales_orders"),
    salesOrderLinesTable: tableSentinel("sales_order_lines"),
    customersTable: tableSentinel("customers"),
    itemsTable: tableSentinel("items"),
    usersTable: tableSentinel("users"),
    warehousesTable: tableSentinel("warehouses"),
    suppliersTable: tableSentinel("suppliers"),
  };
}

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
