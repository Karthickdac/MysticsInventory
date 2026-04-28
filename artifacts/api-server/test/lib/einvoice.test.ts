import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDbModuleMock, drizzleOrmMock } from "../helpers/mockModules";

// Stub `@workspace/db` *before* importing anything that pulls it in.
// `lib/einvoice.ts` reads/writes the organizations table for token
// caching; the shared helper replaces it with a queue-driven mock so
// the tests can drive every code path without a real database.
// Drizzle's expression helpers are likewise replaced with cheap,
// side-effect-free pass-throughs the mock db never inspects.
vi.mock("@workspace/db", () => createDbModuleMock());
vi.mock("drizzle-orm", () => drizzleOrmMock);

import {
  generateIrn,
  cancelIrn,
  einvoiceAuthLogin,
  parseIrpAckDate,
  isIrpCancellable,
  EinvoiceApiError,
  EinvoiceAuthError,
  EinvoiceNotConnectedError,
  IRP_CANCEL_WINDOW_MS,
} from "../../src/lib/einvoice";
import { encryptString } from "../../src/lib/encryption";
import { resetDbMock, dbMock } from "../helpers/dbMock";

// ──────────────────────────────────────────────────────────────────────
// Generic helpers
// ──────────────────────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setupConnectedOrg(opts: { token?: string; expiresInMs?: number } = {}) {
  // The token cache load is the very first DB select inside
  // `getOrgEinvoiceToken`. Queue it up so any subsequent
  // `einvoiceRequest` call finds valid creds without minting.
  const token = opts.token ?? "TEST_TOKEN";
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
      tokenEncrypted: encryptString(token),
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
// parseIrpAckDate
// ──────────────────────────────────────────────────────────────────────

describe("parseIrpAckDate", () => {
  it("parses NIC's space-separated IST timestamp into a UTC Date", () => {
    // 2026-01-15 10:30:00 IST → 05:00:00 UTC
    const d = parseIrpAckDate("2026-01-15 10:30:00");
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });

  it("parses the ISO-style 'T'-separated form too", () => {
    const d = parseIrpAckDate("2026-01-15T10:30:00");
    expect(d!.toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });

  it("returns null for null/undefined inputs", () => {
    expect(parseIrpAckDate(null)).toBeNull();
    expect(parseIrpAckDate(undefined)).toBeNull();
    expect(parseIrpAckDate("")).toBeNull();
  });

  it("returns null for unparseable garbage", () => {
    expect(parseIrpAckDate("not-a-date")).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// isIrpCancellable
// ──────────────────────────────────────────────────────────────────────

describe("isIrpCancellable", () => {
  it("returns true within the 24h window", () => {
    const ack = new Date(Date.now() - 23 * 60 * 60 * 1000);
    expect(isIrpCancellable(ack)).toBe(true);
  });

  it("returns false at exactly the 24h boundary", () => {
    const ack = new Date(Date.now() - IRP_CANCEL_WINDOW_MS);
    expect(isIrpCancellable(ack)).toBe(false);
  });

  it("returns false past 24h", () => {
    const ack = new Date(Date.now() - 25 * 60 * 60 * 1000);
    expect(isIrpCancellable(ack)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isIrpCancellable(null)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// einvoiceAuthLogin (mocked fetch)
// ──────────────────────────────────────────────────────────────────────

describe("einvoiceAuthLogin", () => {
  it("returns the minted token + parsed expiry when the IRP accepts the credentials", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: "1",
          authtoken: "ABC",
          tokenExpiry: "2030-01-01T00:00:00.000Z",
        }),
      );
    const out = await einvoiceAuthLogin(
      "29AAAAA1234A1Z5",
      "tester",
      "pw",
    );
    expect(out.token).toBe("ABC");
    expect(out.expiresAt.toISOString()).toBe("2030-01-01T00:00:00.000Z");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      username: "tester",
      password: "pw",
    });
  });

  it("falls back to a default expiry if NIC omits tokenExpiry", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(200, { status: "1", authtoken: "XYZ" }),
    );
    const out = await einvoiceAuthLogin(
      "29AAAAA1234A1Z5",
      "tester",
      "pw",
    );
    expect(out.token).toBe("XYZ");
    // Fallback is ~5.5h from now; allow a generous window.
    const ms = out.expiresAt.getTime() - Date.now();
    expect(ms).toBeGreaterThan(5 * 60 * 60 * 1000);
    expect(ms).toBeLessThan(6 * 60 * 60 * 1000);
  });

  it("throws EinvoiceAuthError when the IRP rejects the credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(401, {
        status: "0",
        error: { error_cd: "AUTH101", message: "Invalid login credentials" },
      }),
    );
    await expect(
      einvoiceAuthLogin("29AAAAA1234A1Z5", "tester", "pw"),
    ).rejects.toBeInstanceOf(EinvoiceAuthError);
  });

  it("forwards client_id / client_secret headers when supplied", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse(200, { status: "1", authtoken: "T" }),
      );
    await einvoiceAuthLogin(
      "29AAAAA1234A1Z5",
      "tester",
      "pw",
      "GSP_CLIENT",
      "GSP_SECRET",
    );
    const [, init] = fetchSpy.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["client_id"]).toBe("GSP_CLIENT");
    expect(headers["client_secret"]).toBe("GSP_SECRET");
    expect(headers["Gstin"]).toBe("29AAAAA1234A1Z5");
  });
});

// ──────────────────────────────────────────────────────────────────────
// generateIrn — auth resolution + payload + response shape
// ──────────────────────────────────────────────────────────────────────

const irnInput = {
  docType: "INV" as const,
  docNumber: "INV-1",
  docDate: "15/01/2026",
  supplyType: "B2B" as const,
  seller: {
    legalName: "Mystics Inc",
    gstin: "29ZZZZZ9999Z1Z5",
    addressLine1: "1 Brigade Road",
    location: "Bengaluru",
    pincode: "560001",
    stateCode: "29",
  },
  buyer: {
    legalName: "Acme",
    gstin: "29ABCDE1234F1Z5",
    addressLine1: "12 MG Road",
    location: "Bengaluru",
    pincode: "560002",
    stateCode: "29",
  },
  items: [
    {
      serialNumber: "1",
      productName: "Widget",
      hsnCode: "84715000",
      quantity: 1,
      unit: "NOS",
      unitPrice: 1000,
      taxableValue: 1000,
      gstRate: 18,
      cgstAmount: 90,
      sgstAmount: 90,
      igstAmount: 0,
      cessAmount: 0,
      totalItemValue: 1180,
    },
  ],
  totals: {
    assessableValue: 1000,
    cgstValue: 90,
    sgstValue: 90,
    igstValue: 0,
    cessValue: 0,
    totalInvoiceValue: 1180,
  },
};

describe("generateIrn", () => {
  it("returns the parsed IRN/ack triple on a successful response", async () => {
    setupConnectedOrg();
    // Update for clearing eInvoiceLastErrorAt happens after success.
    dbMock.queueUpdate([{}]);
    // Final order persistence: not relevant here (caller does it).
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(200, {
        status: "1",
        data: {
          Irn: "abc123",
          AckNo: 987654,
          AckDt: "2026-01-15 10:30:00",
          SignedQRCode: "qr-payload",
        },
      }),
    );
    const out = await generateIrn(1, irnInput);
    expect(out.irn).toBe("abc123");
    expect(out.ackNumber).toBe("987654"); // numeric → string normalisation
    expect(out.ackDate).toBe("2026-01-15 10:30:00");
    expect(out.signedQrCode).toBe("qr-payload");
  });

  it("maps a 4xx response to EinvoiceApiError with status preserved", async () => {
    setupConnectedOrg();
    dbMock.queueUpdate([{}]); // last-error set
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(400, {
        status: "0",
        errorDetails: [
          { ErrorCode: "2150", ErrorMessage: "Duplicate IRN" },
        ],
      }),
    );
    await expect(generateIrn(1, irnInput)).rejects.toMatchObject({
      name: "EinvoiceApiError",
      status: 400,
      code: "2150",
    });
  });

  it("treats HTTP 200 with status:'0' the same as a non-2xx response", async () => {
    setupConnectedOrg();
    dbMock.queueUpdate([{}]);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(200, {
        status: "0",
        message: "Mandatory field missing",
      }),
    );
    await expect(generateIrn(1, irnInput)).rejects.toBeInstanceOf(
      EinvoiceApiError,
    );
  });

  it("maps a 5xx response to EinvoiceApiError with status>=500", async () => {
    setupConnectedOrg();
    dbMock.queueUpdate([{}]);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(503, {
        status: "0",
        message: "IRP temporarily unavailable",
      }),
    );
    await expect(generateIrn(1, irnInput)).rejects.toMatchObject({
      name: "EinvoiceApiError",
      status: 503,
    });
  });

  it("re-mints the token once on 401 and retries the call", async () => {
    setupConnectedOrg();
    // After the 401, the route clears the cached token (1 update),
    // then re-loads creds (1 select), mints a fresh token (1 fetch),
    // persists the minted token (1 update), retries the request, and
    // finally clears eInvoiceLastErrorAt on success (1 update).
    dbMock.queueUpdate([{}]); // clear cached token
    dbMock.queueSelect([
      {
        enabled: true,
        gstin: "29AAAAA1234A1Z5",
        username: "tester",
        passwordEncrypted: encryptString("pw"),
        clientIdEncrypted: null,
        clientSecretEncrypted: null,
        tokenEncrypted: null,
        tokenExpiresAt: null,
      },
    ]);
    dbMock.queueUpdate([{}]); // persist fresh token
    dbMock.queueUpdate([{}]); // clear eInvoiceLastErrorAt on success

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      // First /invoice call: 401
      .mockResolvedValueOnce(jsonResponse(401, { status: "0" }))
      // Re-mint /auth: success
      .mockResolvedValueOnce(
        jsonResponse(200, { status: "1", authtoken: "FRESH" }),
      )
      // Retry /invoice: success
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: "1",
          data: {
            Irn: "after-retry",
            AckNo: "1",
            AckDt: "2026-01-15 10:30:00",
            SignedQRCode: "qr",
          },
        }),
      );

    const out = await generateIrn(1, irnInput);
    expect(out.irn).toBe("after-retry");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("throws EinvoiceNotConnectedError when no creds are on file", async () => {
    dbMock.queueSelect([]); // no rows
    await expect(generateIrn(1, irnInput)).rejects.toBeInstanceOf(
      EinvoiceNotConnectedError,
    );
  });

  it("throws EinvoiceApiError(502) when the IRP returns an unexpected shape", async () => {
    setupConnectedOrg();
    dbMock.queueUpdate([{}]);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(200, {
        status: "1",
        data: { /* missing Irn/AckNo/AckDt/SignedQRCode */ },
      }),
    );
    await expect(generateIrn(1, irnInput)).rejects.toMatchObject({
      name: "EinvoiceApiError",
      status: 502,
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// cancelIrn
// ──────────────────────────────────────────────────────────────────────

describe("cancelIrn", () => {
  it("returns the cancelDate when the IRP accepts the cancellation", async () => {
    setupConnectedOrg();
    dbMock.queueUpdate([{}]);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(200, {
        status: "1",
        data: { Irn: "abc", CancelDate: "2026-01-15 11:00:00" },
      }),
    );
    const out = await cancelIrn(1, {
      irn: "abc",
      reasonCode: "1",
      reasonRemark: "duplicate",
    });
    expect(out.cancelledAt).toBe("2026-01-15 11:00:00");
  });

  it("trims overlong reasonRemark to 100 chars when sending", async () => {
    setupConnectedOrg();
    dbMock.queueUpdate([{}]);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: "1",
          data: { Irn: "abc", CancelDate: "2026-01-15 11:00:00" },
        }),
      );
    await cancelIrn(1, {
      irn: "abc",
      reasonCode: "4",
      reasonRemark: "x".repeat(500),
    });
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.CnlRem).toHaveLength(100);
    expect(body.CnlRsn).toBe("4");
  });
});
