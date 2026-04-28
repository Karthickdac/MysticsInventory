import { eq } from "drizzle-orm";
import { db, organizationsTable } from "@workspace/db";
import { logger } from "./logger";
import { decryptString, encryptString } from "./encryption";

// IRP (Invoice Registration Portal) HTTP client. EINVOICE_API_BASE
// points at either the NIC sandbox/production endpoint directly or at
// a GSP fronting it (Cygnet, Masters India, IRIS — all of them speak
// the same NIC-shaped JSON, just on a different base URL with their
// own client_id/client_secret on top of the per-GSTIN auth).
//
// IRP session tokens last ~6 hours; we cache them and silently
// re-mint using the stored credentials. We refresh 5 minutes before
// expiry. Credentials are encrypted at rest with the same AES-256-GCM
// helper used for EWB and Shiprocket.

const DEFAULT_EINVOICE_BASE =
  process.env["EINVOICE_API_BASE"] ||
  "https://einv-apisandbox.nic.in/eivital/v1.04";

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const FALLBACK_TOKEN_TTL_MS = 5.5 * 60 * 60 * 1000;

// IRP enforces a 24-hour cancellation window from invoice
// acknowledgement. After that, the only legal way to reverse the
// invoice is a credit note, which must itself be reported separately.
export const IRP_CANCEL_WINDOW_MS = 24 * 60 * 60 * 1000;

// Hard per-request timeout for any IRP/GSP HTTP call. NIC's sandbox
// is occasionally slow but a 7-second cap keeps us well under
// Express' default keep-alive without giving up on real responses.
const EINVOICE_FETCH_TIMEOUT_MS = 7000;

export class EinvoiceNotConnectedError extends Error {
  constructor() {
    super("E-invoice integration is not configured for this organization");
    this.name = "EinvoiceNotConnectedError";
  }
}

export class EinvoiceAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EinvoiceAuthError";
  }
}

export class EinvoiceApiError extends Error {
  status: number;
  body: unknown;
  code: string | null;
  // Optional structured context for the failure (e.g. the item ID
  // for an `invalid_hsn` error). Persisted alongside the error
  // code so the UI can deep-link the operator to the right
  // record.
  context: Record<string, unknown> | null;
  constructor(
    status: number,
    message: string,
    body: unknown,
    code: string | null = null,
    context: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "EinvoiceApiError";
    this.status = status;
    this.body = body;
    this.code = code;
    this.context = context;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Auth
// ──────────────────────────────────────────────────────────────────────

interface AuthResponse {
  status?: string;
  authtoken?: string;
  sek?: string;
  tokenExpiry?: string;
  error?: { error_cd?: string; message?: string } | string;
  message?: string;
}

/**
 * Mint a fresh IRP session token. NIC and most GSPs use the same auth
 * shape (POST username + password with the GSTIN as a header). The
 * optional client_id / client_secret are sent only when the GSP
 * requires them — sandbox / NIC-direct flows ignore them.
 */
export async function einvoiceAuthLogin(
  gstin: string,
  username: string,
  password: string,
  clientId?: string | null,
  clientSecret?: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  const url = `${DEFAULT_EINVOICE_BASE}/auth`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Gstin": gstin,
  };
  if (clientId) headers["client_id"] = clientId;
  if (clientSecret) headers["client_secret"] = clientSecret;
  // Hard per-request timeout. Without this, an unresponsive IRP /
  // GSP could keep an Express handler hanging indefinitely.
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(EINVOICE_FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: AuthResponse | string | null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  const data = (body && typeof body === "object" ? body : null) as
    | AuthResponse
    | null;
  if (!res.ok || !data?.authtoken) {
    const message = extractEinvoiceErrorMessage(data, res.status, "auth");
    throw new EinvoiceAuthError(message);
  }
  let expiresAt: Date;
  if (data.tokenExpiry) {
    const parsed = new Date(data.tokenExpiry);
    expiresAt = Number.isNaN(parsed.getTime())
      ? new Date(Date.now() + FALLBACK_TOKEN_TTL_MS)
      : parsed;
  } else {
    expiresAt = new Date(Date.now() + FALLBACK_TOKEN_TTL_MS);
  }
  return { token: data.authtoken, expiresAt };
}

interface EinvoiceErrorBody {
  status?: string;
  error?: { error_cd?: string; message?: string } | string;
  message?: string;
  errorDetails?: Array<{ ErrorCode?: string; ErrorMessage?: string }>;
}

function extractEinvoiceErrorMessage(
  body: EinvoiceErrorBody | null,
  status: number,
  op: string,
): string {
  if (!body) return `IRP ${op} failed (HTTP ${status})`;
  // NIC's "ErrorDetails" array on validation failure carries the most
  // user-friendly text (rule code + plain-English message).
  if (Array.isArray(body.errorDetails) && body.errorDetails.length > 0) {
    return body.errorDetails
      .map((e) => {
        const code = e.ErrorCode ? `[${e.ErrorCode}] ` : "";
        return `${code}${e.ErrorMessage ?? ""}`.trim();
      })
      .filter(Boolean)
      .join("; ");
  }
  if (typeof body.error === "object" && body.error?.message) {
    return body.error.message;
  }
  if (typeof body.error === "string" && body.error.trim()) {
    return body.error;
  }
  if (body.message) return body.message;
  return `IRP ${op} failed (HTTP ${status})`;
}

function extractEinvoiceErrorCode(body: EinvoiceErrorBody | null): string | null {
  if (!body) return null;
  if (Array.isArray(body.errorDetails) && body.errorDetails[0]?.ErrorCode) {
    return body.errorDetails[0].ErrorCode;
  }
  if (typeof body.error === "object" && body.error?.error_cd) {
    return body.error.error_cd;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Token cache + auto-refresh
// ──────────────────────────────────────────────────────────────────────

interface OrgEinvoiceCreds {
  enabled: boolean;
  gstin: string | null;
  username: string | null;
  passwordEncrypted: string | null;
  clientIdEncrypted: string | null;
  clientSecretEncrypted: string | null;
  tokenEncrypted: string | null;
  tokenExpiresAt: Date | null;
}

async function loadOrgEinvoiceCreds(
  orgId: number,
): Promise<OrgEinvoiceCreds | null> {
  const rows = await db
    .select({
      enabled: organizationsTable.eInvoiceEnabled,
      gstin: organizationsTable.eInvoiceGstin,
      username: organizationsTable.eInvoiceApiUsername,
      passwordEncrypted: organizationsTable.eInvoiceApiPasswordEncrypted,
      clientIdEncrypted: organizationsTable.eInvoiceClientIdEncrypted,
      clientSecretEncrypted: organizationsTable.eInvoiceClientSecretEncrypted,
      tokenEncrypted: organizationsTable.eInvoiceTokenEncrypted,
      tokenExpiresAt: organizationsTable.eInvoiceTokenExpiresAt,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Resolve the active IRP session token for an org. If the cached
 * token is missing, near expiry, or undecryptable, transparently
 * mint a fresh one using the encrypted username + password.
 *
 * Throws:
 *   - EinvoiceNotConnectedError when no creds are on file
 *   - EinvoiceAuthError when the IRP rejects the credentials
 */
async function getOrgEinvoiceToken(orgId: number): Promise<{
  token: string;
  gstin: string;
}> {
  const creds = await loadOrgEinvoiceCreds(orgId);
  if (
    !creds ||
    !creds.gstin ||
    !creds.username ||
    !creds.passwordEncrypted
  ) {
    throw new EinvoiceNotConnectedError();
  }
  const fresh =
    !!creds.tokenEncrypted &&
    !!creds.tokenExpiresAt &&
    creds.tokenExpiresAt.getTime() - Date.now() > TOKEN_EXPIRY_BUFFER_MS;
  if (fresh) {
    try {
      return {
        token: decryptString(creds.tokenEncrypted!),
        gstin: creds.gstin,
      };
    } catch (err) {
      logger.warn(
        { orgId, err },
        "einvoice: cached token failed to decrypt — minting a fresh one",
      );
      // fall through to re-mint
    }
  }
  let password: string;
  try {
    password = decryptString(creds.passwordEncrypted);
  } catch (err) {
    logger.error(
      { orgId, err },
      "einvoice: saved password failed to decrypt — admin must reconnect",
    );
    throw new EinvoiceAuthError(
      "Saved e-invoice credentials cannot be decrypted; please reconnect the integration.",
    );
  }
  let clientId: string | null = null;
  let clientSecret: string | null = null;
  if (creds.clientIdEncrypted) {
    try {
      clientId = decryptString(creds.clientIdEncrypted);
    } catch {
      // Treat undecryptable secondary creds as absent — auth will
      // either succeed (NIC-direct) or fail with a clear error.
      clientId = null;
    }
  }
  if (creds.clientSecretEncrypted) {
    try {
      clientSecret = decryptString(creds.clientSecretEncrypted);
    } catch {
      clientSecret = null;
    }
  }
  const minted = await einvoiceAuthLogin(
    creds.gstin,
    creds.username,
    password,
    clientId,
    clientSecret,
  );
  await db
    .update(organizationsTable)
    .set({
      eInvoiceTokenEncrypted: encryptString(minted.token),
      eInvoiceTokenExpiresAt: minted.expiresAt,
      eInvoiceLastErrorAt: null,
      eInvoiceLastErrorMessage: null,
    })
    .where(eq(organizationsTable.id, orgId));
  return { token: minted.token, gstin: creds.gstin };
}

// ──────────────────────────────────────────────────────────────────────
// Authenticated request
// ──────────────────────────────────────────────────────────────────────

interface RequestOptions {
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

interface EinvoiceEnvelopeResponse<T> {
  status?: string;
  data?: T;
  error?: { error_cd?: string; message?: string } | string;
  message?: string;
  errorDetails?: Array<{ ErrorCode?: string; ErrorMessage?: string }>;
}

/**
 * Issue an authenticated request against the configured IRP base.
 * Re-mints the token once on 401 (in case the cached token was
 * silently revoked between calls) before giving up.
 */
async function einvoiceRequest<T>(
  orgId: number,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  const qs = opts.query
    ? `?${new URLSearchParams(
        Object.fromEntries(
          Object.entries(opts.query)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)]),
        ),
      ).toString()}`
    : "";
  const url = `${DEFAULT_EINVOICE_BASE}${path}${qs}`;

  const doOnce = async (token: string, gstin: string) => {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "authtoken": token,
        "Gstin": gstin,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(EINVOICE_FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { res, parsed };
  };

  let { token, gstin } = await getOrgEinvoiceToken(orgId);
  let { res, parsed } = await doOnce(token, gstin);

  if (res.status === 401) {
    logger.info(
      { orgId, path },
      "einvoice: 401 from IRP — clearing cached token and retrying",
    );
    await db
      .update(organizationsTable)
      .set({
        eInvoiceTokenEncrypted: null,
        eInvoiceTokenExpiresAt: null,
      })
      .where(eq(organizationsTable.id, orgId));
    const fresh = await getOrgEinvoiceToken(orgId);
    token = fresh.token;
    gstin = fresh.gstin;
    ({ res, parsed } = await doOnce(token, gstin));
  }

  const env = (parsed && typeof parsed === "object" ? parsed : null) as
    | EinvoiceEnvelopeResponse<T>
    | null;

  // NIC sometimes returns HTTP 200 with status:"0" + an error
  // message. Treat that the same as a non-2xx response.
  const upstreamFailed =
    !res.ok ||
    (env?.status !== undefined && env.status !== "1" && env.status !== "Success");

  if (upstreamFailed) {
    const message = extractEinvoiceErrorMessage(env, res.status, path);
    const code = extractEinvoiceErrorCode(env);
    await db
      .update(organizationsTable)
      .set({
        eInvoiceLastErrorAt: new Date(),
        eInvoiceLastErrorMessage: message.slice(0, 500),
      })
      .where(eq(organizationsTable.id, orgId));
    throw new EinvoiceApiError(res.status, message, env, code);
  }

  await db
    .update(organizationsTable)
    .set({
      eInvoiceLastErrorAt: null,
      eInvoiceLastErrorMessage: null,
    })
    .where(eq(organizationsTable.id, orgId));

  return (env?.data ?? (parsed as T)) as T;
}

// ──────────────────────────────────────────────────────────────────────
// Invoice payload
// ──────────────────────────────────────────────────────────────────────

export type IrpDocType = "INV" | "CRN" | "DBN";
// CRN = credit note, DBN = debit note. Out of scope for this version
// (we only register fresh sales invoices) but kept on the type for
// when credit-note registration is added.

export type IrpSupplyType =
  | "B2B"
  | "SEZWP" // SEZ with payment of tax
  | "SEZWOP" // SEZ without payment of tax
  | "EXPWP" // Export with payment of tax
  | "EXPWOP" // Export without payment of tax
  | "DEXP"; // Deemed export

export interface IrpAddress {
  legalName: string;
  gstin: string; // "URP" for unregistered recipients
  addressLine1: string;
  addressLine2?: string | null;
  location: string; // city
  pincode: string; // 6 digits
  stateCode: string; // GST state code as a string ("01"-"37")
  email?: string | null;
  phone?: string | null;
}

export interface IrpItem {
  serialNumber: string; // "1", "2", … per IRP spec
  productName: string;
  productDesc?: string | null;
  hsnCode: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  taxableValue: number;
  gstRate: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  cessAmount: number;
  totalItemValue: number;
}

export interface GenerateIrnInput {
  docType: IrpDocType;
  docNumber: string;
  docDate: string; // dd/mm/yyyy
  supplyType: IrpSupplyType;
  seller: IrpAddress;
  buyer: IrpAddress;
  items: IrpItem[];
  totals: {
    assessableValue: number;
    cgstValue: number;
    sgstValue: number;
    igstValue: number;
    cessValue: number;
    totalInvoiceValue: number;
  };
}

export interface GeneratedIrn {
  irn: string;
  ackNumber: string;
  ackDate: string; // ISO-ish ("yyyy-mm-dd hh:mm:ss") returned by IRP
  signedQrCode: string; // opaque base64; render to QR PNG for the PDF
}

interface RawIrnResponse {
  Irn?: string;
  AckNo?: string | number;
  AckDt?: string;
  SignedInvoice?: string;
  SignedQRCode?: string;
}

function dateToNicFormat(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function nowNicDateString(): string {
  return dateToNicFormat(new Date());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function buildIrnPayload(input: GenerateIrnInput): Record<string, unknown> {
  // Shape mirrors NIC's "Generate IRN" v1.1 schema (and the equivalent
  // GSP wrappers): top-level Version + TranDtls + DocDtls + SellerDtls
  // + BuyerDtls + ItemList + ValDtls.
  return {
    Version: "1.1",
    TranDtls: {
      TaxSch: "GST",
      SupTyp: input.supplyType,
      RegRev: "N",
      IgstOnIntra: "N",
    },
    DocDtls: {
      Typ: input.docType,
      No: input.docNumber,
      Dt: input.docDate,
    },
    SellerDtls: {
      Gstin: input.seller.gstin,
      LglNm: input.seller.legalName,
      Addr1: input.seller.addressLine1,
      Addr2: input.seller.addressLine2 ?? "",
      Loc: input.seller.location,
      Pin: Number(input.seller.pincode),
      Stcd: input.seller.stateCode,
      Em: input.seller.email ?? "",
      Ph: input.seller.phone ?? "",
    },
    BuyerDtls: {
      Gstin: input.buyer.gstin,
      LglNm: input.buyer.legalName,
      Pos: input.buyer.stateCode,
      Addr1: input.buyer.addressLine1,
      Addr2: input.buyer.addressLine2 ?? "",
      Loc: input.buyer.location,
      Pin: Number(input.buyer.pincode),
      Stcd: input.buyer.stateCode,
      Em: input.buyer.email ?? "",
      Ph: input.buyer.phone ?? "",
    },
    ItemList: input.items.map((it) => ({
      SlNo: it.serialNumber,
      PrdDesc: (it.productDesc ?? it.productName).slice(0, 300),
      IsServc: "N",
      HsnCd: it.hsnCode,
      Qty: round2(it.quantity),
      Unit: (it.unit || "NOS").toUpperCase().slice(0, 8),
      UnitPrice: round2(it.unitPrice),
      TotAmt: round2(it.unitPrice * it.quantity),
      Discount: 0,
      AssAmt: round2(it.taxableValue),
      GstRt: round2(it.gstRate),
      IgstAmt: round2(it.igstAmount),
      CgstAmt: round2(it.cgstAmount),
      SgstAmt: round2(it.sgstAmount),
      CesRt: 0,
      CesAmt: round2(it.cessAmount),
      CesNonAdvlAmt: 0,
      StateCesRt: 0,
      StateCesAmt: 0,
      StateCesNonAdvlAmt: 0,
      OthChrg: 0,
      TotItemVal: round2(it.totalItemValue),
    })),
    ValDtls: {
      AssVal: round2(input.totals.assessableValue),
      CgstVal: round2(input.totals.cgstValue),
      SgstVal: round2(input.totals.sgstValue),
      IgstVal: round2(input.totals.igstValue),
      CesVal: round2(input.totals.cessValue),
      StCesVal: 0,
      Discount: 0,
      OthChrg: 0,
      RndOffAmt: 0,
      TotInvVal: round2(input.totals.totalInvoiceValue),
    },
  };
}

function normaliseGeneratedIrn(raw: RawIrnResponse): GeneratedIrn {
  if (!raw.Irn || raw.AckNo === undefined || !raw.AckDt || !raw.SignedQRCode) {
    throw new EinvoiceApiError(
      502,
      "IRP returned an unexpected response shape",
      raw,
    );
  }
  return {
    irn: raw.Irn,
    ackNumber: String(raw.AckNo),
    ackDate: raw.AckDt,
    signedQrCode: raw.SignedQRCode,
  };
}

export async function generateIrn(
  orgId: number,
  input: GenerateIrnInput,
): Promise<GeneratedIrn> {
  const raw = await einvoiceRequest<RawIrnResponse>(
    orgId,
    "/invoice",
    {
      method: "POST",
      body: buildIrnPayload(input),
    },
  );
  return normaliseGeneratedIrn(raw);
}

// IRP cancellation reason codes
export type IrpCancelReason =
  | "1" // Duplicate
  | "2" // Data Entry Mistake
  | "3" // Order Cancelled
  | "4"; // Others

export interface CancelIrnInput {
  irn: string;
  reasonCode: IrpCancelReason;
  reasonRemark: string;
}

interface RawCancelResponse {
  Irn?: string;
  CancelDate?: string;
}

export async function cancelIrn(
  orgId: number,
  input: CancelIrnInput,
): Promise<{ cancelledAt: string }> {
  const raw = await einvoiceRequest<RawCancelResponse>(
    orgId,
    "/invoice/cancel",
    {
      method: "POST",
      body: {
        Irn: input.irn,
        CnlRsn: input.reasonCode,
        CnlRem: input.reasonRemark.slice(0, 100),
      },
    },
  );
  return { cancelledAt: raw.CancelDate ?? new Date().toISOString() };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers used by the IRP payload builder caller
// ──────────────────────────────────────────────────────────────────────

/**
 * Parse the IRP "AckDt" timestamp (yyyy-mm-dd hh:mm:ss in IST) into a
 * UTC Date. Returns null on unparseable input.
 */
export function parseIrpAckDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  // The IRP spec returns the timestamp without a timezone. By
  // convention this is IST (UTC+5:30). Build the UTC Date by parsing
  // the components manually — `new Date(s)` would interpret it as
  // local time on the server, which is fine in IST containers but
  // wrong everywhere else (sandbox CI, migration, etc.).
  const m = s.trim().match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/u,
  );
  if (!m) {
    const fallback = new Date(s);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }
  const [, y, mo, d, h, mi, se] = m;
  const utcMs = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(se),
  );
  // Subtract 5h30m to go from IST to UTC.
  return new Date(utcMs - (5 * 60 + 30) * 60 * 1000);
}

/**
 * Whether an IRN issued at `ackDate` is still within IRP's 24-hour
 * cancellation window.
 */
export function isIrpCancellable(ackDate: Date | null): boolean {
  if (!ackDate) return false;
  return Date.now() - ackDate.getTime() < IRP_CANCEL_WINDOW_MS;
}
