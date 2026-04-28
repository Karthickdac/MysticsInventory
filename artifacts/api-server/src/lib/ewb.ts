import { eq } from "drizzle-orm";
import { db, organizationsTable } from "@workspace/db";
import { logger } from "./logger";
import { decryptString, encryptString } from "./encryption";

// NIC EWB HTTP client. EWB_API_BASE points at either NIC directly or a
// GSP. Tokens last ~6h; we cache and silently re-mint using the
// stored credentials. We refresh 5 minutes before expiry.

const DEFAULT_EWB_BASE =
  process.env["EWB_API_BASE"] ||
  "https://einv-apisandbox.nic.in/eiewb/v1.03";

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const FALLBACK_TOKEN_TTL_MS = 5.5 * 60 * 60 * 1000;

export class EwbNotConnectedError extends Error {
  constructor() {
    super("E-way bill integration is not configured for this organization");
    this.name = "EwbNotConnectedError";
  }
}

export class EwbAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EwbAuthError";
  }
}

export class EwbApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "EwbApiError";
    this.status = status;
    this.body = body;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Auth
// ──────────────────────────────────────────────────────────────────────

interface AuthResponse {
  status?: string;
  // NIC returns these on success:
  authtoken?: string;
  sek?: string; // session encryption key (used by GSP envelope; opaque to us)
  tokenExpiry?: string; // ISO-ish, sometimes
  // Errors
  error?: { error_cd?: string; message?: string } | string;
  message?: string;
}

/**
 * Mint a fresh NIC EWB session token from GSTIN + username + password.
 * Caller persists the encrypted token + expiry. The raw password
 * remains encrypted at rest — it is decrypted in-process only when a
 * fresh token is needed.
 */
export async function ewbAuthLogin(
  gstin: string,
  username: string,
  password: string,
): Promise<{ token: string; expiresAt: Date }> {
  const url = `${DEFAULT_EWB_BASE}/auth`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Gstin": gstin,
    },
    body: JSON.stringify({ username, password }),
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
    const message = extractEwbErrorMessage(data, res.status, "auth");
    throw new EwbAuthError(message);
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

function extractEwbErrorMessage(
  body: AuthResponse | null,
  status: number,
  op: string,
): string {
  if (!body) return `EWB ${op} failed (HTTP ${status})`;
  if (typeof body.error === "object" && body.error?.message) {
    return body.error.message;
  }
  if (typeof body.error === "string" && body.error.trim()) {
    return body.error;
  }
  if (body.message) return body.message;
  return `EWB ${op} failed (HTTP ${status})`;
}

// ──────────────────────────────────────────────────────────────────────
// Token cache + auto-refresh
// ──────────────────────────────────────────────────────────────────────

interface OrgEwbCreds {
  gstin: string | null;
  username: string | null;
  passwordEncrypted: string | null;
  tokenEncrypted: string | null;
  tokenExpiresAt: Date | null;
}

async function loadOrgEwbCreds(orgId: number): Promise<OrgEwbCreds | null> {
  const rows = await db
    .select({
      gstin: organizationsTable.ewbGstin,
      username: organizationsTable.ewbApiUsername,
      passwordEncrypted: organizationsTable.ewbApiPasswordEncrypted,
      tokenEncrypted: organizationsTable.ewbTokenEncrypted,
      tokenExpiresAt: organizationsTable.ewbTokenExpiresAt,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Resolve the active EWB session token for an org. If the cached
 * token is missing, near expiry, or undecryptable, transparently
 * mint a fresh one using the encrypted username + password.
 *
 * Throws:
 *   - EwbNotConnectedError when no creds are on file
 *   - EwbAuthError when NIC rejects the credentials
 */
async function getOrgEwbToken(orgId: number): Promise<{
  token: string;
  gstin: string;
}> {
  const creds = await loadOrgEwbCreds(orgId);
  if (
    !creds ||
    !creds.gstin ||
    !creds.username ||
    !creds.passwordEncrypted
  ) {
    throw new EwbNotConnectedError();
  }
  const fresh =
    !!creds.tokenEncrypted &&
    !!creds.tokenExpiresAt &&
    creds.tokenExpiresAt.getTime() - Date.now() > TOKEN_EXPIRY_BUFFER_MS;
  if (fresh) {
    try {
      return { token: decryptString(creds.tokenEncrypted!), gstin: creds.gstin };
    } catch (err) {
      logger.warn(
        { orgId, err },
        "ewb: cached token failed to decrypt — minting a fresh one",
      );
      // fall through to re-mint
    }
  }
  // Re-mint from saved username + password.
  let password: string;
  try {
    password = decryptString(creds.passwordEncrypted);
  } catch (err) {
    logger.error(
      { orgId, err },
      "ewb: saved password failed to decrypt — admin must reconnect",
    );
    throw new EwbAuthError(
      "Saved EWB credentials cannot be decrypted; please reconnect the integration.",
    );
  }
  const minted = await ewbAuthLogin(creds.gstin, creds.username, password);
  await db
    .update(organizationsTable)
    .set({
      ewbTokenEncrypted: encryptString(minted.token),
      ewbTokenExpiresAt: minted.expiresAt,
      ewbLastErrorAt: null,
      ewbLastErrorMessage: null,
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

interface EwbEnvelopeResponse<T> {
  status?: string;
  data?: T;
  error?: { error_cd?: string; message?: string } | string;
  message?: string;
}

/**
 * Issue an authenticated request against the configured EWB base.
 * Re-mints the token once on 401 (in case the cached token was
 * silently revoked between calls) before giving up.
 */
async function ewbRequest<T>(
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
  const url = `${DEFAULT_EWB_BASE}${path}${qs}`;

  const doOnce = async (token: string, gstin: string) => {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "authtoken": token,
        "Gstin": gstin,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
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

  let { token, gstin } = await getOrgEwbToken(orgId);
  let { res, parsed } = await doOnce(token, gstin);

  if (res.status === 401) {
    // Force a fresh token and retry once.
    logger.info(
      { orgId, path },
      "ewb: 401 from EWB API — clearing cached token and retrying",
    );
    await db
      .update(organizationsTable)
      .set({ ewbTokenEncrypted: null, ewbTokenExpiresAt: null })
      .where(eq(organizationsTable.id, orgId));
    const fresh = await getOrgEwbToken(orgId);
    token = fresh.token;
    gstin = fresh.gstin;
    ({ res, parsed } = await doOnce(token, gstin));
  }

  const env = (parsed && typeof parsed === "object" ? parsed : null) as
    | EwbEnvelopeResponse<T>
    | null;

  // NIC sometimes returns HTTP 200 with status:"0" + an error
  // message. Treat that the same as a non-2xx response.
  const upstreamFailed =
    !res.ok ||
    (env?.status !== undefined && env.status !== "1" && env.status !== "Success");

  if (upstreamFailed) {
    const message = extractEwbErrorMessage(env, res.status, path);
    // Persist the failure so the UI can surface a stale-credentials
    // banner without us having to re-fetch the upstream.
    await db
      .update(organizationsTable)
      .set({
        ewbLastErrorAt: new Date(),
        ewbLastErrorMessage: message.slice(0, 500),
      })
      .where(eq(organizationsTable.id, orgId));
    throw new EwbApiError(res.status, message, env);
  }

  // Clear any prior error breadcrumb on a successful call.
  await db
    .update(organizationsTable)
    .set({ ewbLastErrorAt: null, ewbLastErrorMessage: null })
    .where(eq(organizationsTable.id, orgId));

  return (env?.data ?? (parsed as T)) as T;
}

// ──────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────

export type EwbTransactionType = 1 | 2 | 3 | 4;
// 1 = Regular, 2 = Bill To-Ship To, 3 = Bill From-Dispatch From, 4 = Combo

export type EwbSupplyType = "O" | "I"; // Outward / Inward
export type EwbSubSupplyType =
  | "1" // Supply
  | "2" // Import
  | "3" // Export
  | "4" // Job Work
  | "5" // For Own Use
  | "6" // Job Work Returns
  | "7" // Sales Return
  | "8" // Others
  | "9" // SKD/CKD/Lots
  | "10" // Line Sales
  | "11" // Recipient Not Known
  | "12"; // Exhibition or Fairs

export type EwbDocType = "INV" | "BIL" | "BOE" | "CHL" | "CNT" | "OTH";

export type EwbTransportMode = "1" | "2" | "3" | "4";
// 1 = Road, 2 = Rail, 3 = Air, 4 = Ship

export type EwbVehicleType = "R" | "O"; // Regular / Over-dimensional cargo

export interface EwbAddress {
  legalName: string;
  gstin?: string | null;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  pincode: string;
  stateCode: number; // GST state code (1-37)
}

export interface EwbItem {
  productName: string;
  productDesc?: string | null;
  hsnCode: string;
  quantity: number;
  qtyUnit: string;
  cgstRate?: number;
  sgstRate?: number;
  igstRate?: number;
  cessRate?: number;
  taxableAmount: number;
}

export interface GenerateEwbInput {
  supplyType: EwbSupplyType;
  subSupplyType: EwbSubSupplyType;
  docType: EwbDocType;
  docNo: string;
  docDate: string; // dd/mm/yyyy per NIC spec
  fromAddress: EwbAddress;
  toAddress: EwbAddress;
  items: EwbItem[];
  totalValue: number;
  cgstValue?: number;
  sgstValue?: number;
  igstValue?: number;
  cessValue?: number;
  totalInvValue: number;
  transactionType: EwbTransactionType;
  transportMode: EwbTransportMode;
  vehicleNumber?: string | null;
  vehicleType?: EwbVehicleType | null;
  transporterId?: string | null;
  transporterName?: string | null;
  transDocNo?: string | null;
  transDocDate?: string | null;
  distanceKm: number;
}

export interface GeneratedEwb {
  ewayBillNo: string;
  ewayBillDate: string; // dd/mm/yyyy hh:mm:ss
  validUpto: string;
}

interface RawGenerateResponse {
  ewayBillNo?: number | string;
  ewayBillDate?: string;
  validUpto?: string;
  // Some GSPs nest under "Data" or similar — flatten before mapping.
}

function dateToNicFormat(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function nowNicDateString(): string {
  return dateToNicFormat(new Date());
}

function buildGeneratePayload(input: GenerateEwbInput): Record<string, unknown> {
  return {
    supplyType: input.supplyType,
    subSupplyType: input.subSupplyType,
    docType: input.docType,
    docNo: input.docNo,
    docDate: input.docDate,
    fromGstin: input.fromAddress.gstin ?? "URP",
    fromTrdName: input.fromAddress.legalName,
    fromAddr1: input.fromAddress.addressLine1,
    fromAddr2: input.fromAddress.addressLine2 ?? "",
    fromPlace: input.fromAddress.city,
    fromPincode: Number(input.fromAddress.pincode),
    fromStateCode: input.fromAddress.stateCode,
    actualFromStateCode: input.fromAddress.stateCode,
    toGstin: input.toAddress.gstin ?? "URP",
    toTrdName: input.toAddress.legalName,
    toAddr1: input.toAddress.addressLine1,
    toAddr2: input.toAddress.addressLine2 ?? "",
    toPlace: input.toAddress.city,
    toPincode: Number(input.toAddress.pincode),
    toStateCode: input.toAddress.stateCode,
    actualToStateCode: input.toAddress.stateCode,
    transactionType: input.transactionType,
    totalValue: round2(input.totalValue),
    cgstValue: round2(input.cgstValue ?? 0),
    sgstValue: round2(input.sgstValue ?? 0),
    igstValue: round2(input.igstValue ?? 0),
    cessValue: round2(input.cessValue ?? 0),
    totInvValue: round2(input.totalInvValue),
    transMode: input.transportMode,
    transDistance: String(input.distanceKm),
    transporterId: input.transporterId ?? "",
    transporterName: input.transporterName ?? "",
    transDocNo: input.transDocNo ?? "",
    transDocDate: input.transDocDate ?? "",
    vehicleNo: input.vehicleNumber ?? "",
    vehicleType: input.vehicleType ?? "R",
    itemList: input.items.map((it) => ({
      productName: it.productName,
      productDesc: it.productDesc ?? it.productName,
      hsnCode: Number(it.hsnCode) || it.hsnCode,
      quantity: it.quantity,
      qtyUnit: it.qtyUnit,
      cgstRate: it.cgstRate ?? 0,
      sgstRate: it.sgstRate ?? 0,
      igstRate: it.igstRate ?? 0,
      cessRate: it.cessRate ?? 0,
      taxableAmount: round2(it.taxableAmount),
    })),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function normaliseGeneratedEwb(raw: RawGenerateResponse): GeneratedEwb {
  if (raw.ewayBillNo === undefined || !raw.ewayBillDate || !raw.validUpto) {
    throw new EwbApiError(
      502,
      "EWB upstream returned an unexpected response shape",
      raw,
    );
  }
  return {
    ewayBillNo: String(raw.ewayBillNo),
    ewayBillDate: raw.ewayBillDate,
    validUpto: raw.validUpto,
  };
}

export async function generateEwb(
  orgId: number,
  input: GenerateEwbInput,
): Promise<GeneratedEwb> {
  const raw = await ewbRequest<RawGenerateResponse>(
    orgId,
    "/ewayapi?action=GENEWAYBILL",
    {
      method: "POST",
      body: buildGeneratePayload(input),
    },
  );
  return normaliseGeneratedEwb(raw);
}

export async function generateEwbByIrn(
  orgId: number,
  input: {
    irn: string;
    transactionType: EwbTransactionType;
    distanceKm: number;
    transportMode: EwbTransportMode;
    vehicleNumber?: string | null;
    vehicleType?: EwbVehicleType | null;
    transporterId?: string | null;
    transporterName?: string | null;
    transDocNo?: string | null;
    transDocDate?: string | null;
  },
): Promise<GeneratedEwb> {
  const raw = await ewbRequest<RawGenerateResponse>(
    orgId,
    "/ewayapi?action=GENEWAYBILLBYIRN",
    {
      method: "POST",
      body: {
        Irn: input.irn,
        TransMode: input.transportMode,
        TransactionType: input.transactionType,
        Distance: input.distanceKm,
        VehNo: input.vehicleNumber ?? "",
        VehType: input.vehicleType ?? "R",
        TransId: input.transporterId ?? "",
        TransName: input.transporterName ?? "",
        TransDocNo: input.transDocNo ?? "",
        TransDocDt: input.transDocDate ?? "",
      },
    },
  );
  return normaliseGeneratedEwb(raw);
}

export type EwbVehicleUpdateReason =
  | "1" // Due to break-down
  | "2" // Due to transhipment
  | "3" // Others
  | "4"; // First Time

export interface UpdateVehicleInput {
  ewbNo: string;
  vehicleNumber: string;
  fromPlace: string;
  fromState: number;
  reasonCode: EwbVehicleUpdateReason;
  reasonRem: string;
  transDocNo?: string | null;
  transDocDate?: string | null;
  transportMode: EwbTransportMode;
  vehicleType?: EwbVehicleType | null;
}

interface UpdateVehicleResponse {
  vehUpdDate?: string;
  validUpto?: string;
}

export async function updateVehicleEwb(
  orgId: number,
  input: UpdateVehicleInput,
): Promise<{ updatedAt: string; validUpto: string }> {
  const raw = await ewbRequest<UpdateVehicleResponse>(
    orgId,
    "/ewayapi?action=VEHEWB",
    {
      method: "POST",
      body: {
        ewbNo: Number(input.ewbNo) || input.ewbNo,
        vehicleNo: input.vehicleNumber,
        fromPlace: input.fromPlace,
        fromState: input.fromState,
        reasonCode: input.reasonCode,
        reasonRem: input.reasonRem,
        transDocNo: input.transDocNo ?? "",
        transDocDate: input.transDocDate ?? "",
        transMode: input.transportMode,
        vehicleType: input.vehicleType ?? "R",
      },
    },
  );
  if (!raw.validUpto) {
    throw new EwbApiError(
      502,
      "EWB update-vehicle returned no validUpto",
      raw,
    );
  }
  return {
    updatedAt: raw.vehUpdDate ?? new Date().toISOString(),
    validUpto: raw.validUpto,
  };
}

export type EwbCancelReason =
  | "1" // Duplicate
  | "2" // Order Cancelled
  | "3" // Data Entry Mistake
  | "4"; // Others

export interface CancelEwbInput {
  ewbNo: string;
  reasonCode: EwbCancelReason;
  reasonRem: string;
}

interface CancelResponse {
  cancelDate?: string;
}

export async function cancelEwb(
  orgId: number,
  input: CancelEwbInput,
): Promise<{ cancelledAt: string }> {
  const raw = await ewbRequest<CancelResponse>(
    orgId,
    "/ewayapi?action=CANEWB",
    {
      method: "POST",
      body: {
        ewbNo: Number(input.ewbNo) || input.ewbNo,
        cancelRsnCode: input.reasonCode,
        cancelRmrk: input.reasonRem,
      },
    },
  );
  return { cancelledAt: raw.cancelDate ?? new Date().toISOString() };
}

// ──────────────────────────────────────────────────────────────────────
// Lookup
// ──────────────────────────────────────────────────────────────────────

interface GetEwbResponse {
  ewayBillNo?: number | string;
  ewayBillDate?: string;
  validUpto?: string;
  status?: string;
  vehicleNo?: string;
  transMode?: string;
  fromGstin?: string;
  toGstin?: string;
  totInvValue?: number;
  docNo?: string;
  docDate?: string;
}

export interface EwbLookupResult {
  ewayBillNo: string;
  ewayBillDate: string | null;
  validUpto: string | null;
  status: string | null;
  vehicleNo: string | null;
  transportMode: string | null;
  fromGstin: string | null;
  toGstin: string | null;
  totalInvoiceValue: number | null;
  docNo: string | null;
  docDate: string | null;
}

/**
 * Look up an existing e-way bill by number. Useful for syncing
 * status (e.g. "active" vs "cancelled") or recovering details when
 * we missed the upstream response. Mirrors the NIC `GETEWAYBILL`
 * action.
 */
export async function getEwbByNumber(
  orgId: number,
  ewbNo: string,
): Promise<EwbLookupResult> {
  const raw = await ewbRequest<GetEwbResponse>(
    orgId,
    `/ewayapi?action=GETEWAYBILL&ewbNo=${encodeURIComponent(ewbNo)}`,
    { method: "GET" },
  );
  return {
    ewayBillNo: String(raw.ewayBillNo ?? ewbNo),
    ewayBillDate: raw.ewayBillDate ?? null,
    validUpto: raw.validUpto ?? null,
    status: raw.status ?? null,
    vehicleNo: raw.vehicleNo ?? null,
    transportMode: raw.transMode ?? null,
    fromGstin: raw.fromGstin ?? null,
    toGstin: raw.toGstin ?? null,
    totalInvoiceValue:
      typeof raw.totInvValue === "number" ? raw.totInvValue : null,
    docNo: raw.docNo ?? null,
    docDate: raw.docDate ?? null,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Date helpers exposed to callers
// ──────────────────────────────────────────────────────────────────────

/**
 * Parse a NIC date-time string ("dd/mm/yyyy hh:mm:ss") into a Date,
 * or return null if it cannot be parsed.
 */
export function parseNicDateTime(s: string | null | undefined): Date | null {
  if (!s) return null;
  // Accept either "dd/mm/yyyy hh:mm:ss" or "dd/mm/yyyy"
  const m = s.match(
    /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/u,
  );
  if (!m) {
    const fallback = new Date(s);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }
  const [, dd, mm, yyyy, hh, min, sec] = m;
  const d = new Date(
    Number(yyyy),
    Number(mm) - 1,
    Number(dd),
    Number(hh ?? "0"),
    Number(min ?? "0"),
    Number(sec ?? "0"),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

// Encodes the EWB number as the NIC public lookup URL so the QR is
// scannable by generic apps as well as the official NIC scanner.
export function buildEwbQrPayload(ewbNumber: string): string {
  return `https://ewaybillgst.gov.in/Others/EBPrintnew.aspx?ewbno=${encodeURIComponent(
    ewbNumber,
  )}`;
}
