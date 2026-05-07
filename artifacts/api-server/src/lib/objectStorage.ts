import { Storage, File } from "@google-cloud/storage";
import { Readable } from "stream";
import { randomUUID, createHmac, timingSafeEqual } from "crypto";
import { promises as fs, createReadStream as fsCreateReadStream } from "fs";
import path from "path";
import {
  ObjectAclPolicy,
  ObjectPermission,
  canAccessObject,
  getObjectAclPolicy as getGcsObjectAclPolicy,
  setObjectAclPolicy as setGcsObjectAclPolicy,
} from "./objectAcl";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

/**
 * Opaque handle returned by the storage service. Callers must not
 * inspect the inner shape — pass it back to service methods
 * (downloadObject, getMetadata, getAclPolicy, ...) which dispatch on
 * the backend.
 */
export type StorageObject =
  | { kind: "gcs"; file: File }
  | { kind: "local"; absolutePath: string; entityId: string; isPublic: boolean };

export interface StorageObjectMetadata {
  contentType: string;
  size: number;
}

function isLocalMode(): boolean {
  return !!process.env.LOCAL_STORAGE_DIR;
}

function getLocalRoot(): string {
  const dir = process.env.LOCAL_STORAGE_DIR;
  if (!dir) throw new Error("LOCAL_STORAGE_DIR not set");
  return dir;
}

function getSigningKey(): string {
  const k = process.env.APP_ENCRYPTION_KEY;
  if (!k || k.length < 32) {
    throw new Error(
      "APP_ENCRYPTION_KEY must be set (>=32 chars) to sign local storage URLs",
    );
  }
  return k;
}

interface LocalToken {
  op: "put" | "get";
  path: string; // /objects/uploads/org-X/uuid OR /public/<rest>
  exp: number; // unix seconds
  ct?: string; // content-type pinned at issue time (PUT only)
}

function signLocalToken(payload: LocalToken): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, "utf8").toString("base64url");
  const sig = createHmac("sha256", getSigningKey()).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

export function verifyLocalToken(token: string): LocalToken | null {
  const idx = token.indexOf(".");
  if (idx < 0) return null;
  const b64 = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = createHmac("sha256", getSigningKey()).update(b64).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: LocalToken;
  try {
    payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

function safeJoinUnderRoot(root: string, relative: string): string {
  // normalize and reject anything that escapes the root
  const resolved = path.resolve(root, relative);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new ObjectNotFoundError();
  }
  return resolved;
}

function entityIdFromObjectPath(objectPath: string): string {
  // /objects/<entityId>  -> <entityId>
  if (!objectPath.startsWith("/objects/")) {
    throw new ObjectNotFoundError();
  }
  const id = objectPath.slice("/objects/".length);
  if (!id || id.includes("..")) throw new ObjectNotFoundError();
  return id;
}

async function readLocalAclPolicy(absPath: string): Promise<ObjectAclPolicy | null> {
  try {
    const raw = await fs.readFile(`${absPath}.acl.json`, "utf8");
    return JSON.parse(raw) as ObjectAclPolicy;
  } catch {
    return null;
  }
}

async function writeLocalAclPolicy(absPath: string, policy: ObjectAclPolicy): Promise<void> {
  await fs.writeFile(`${absPath}.acl.json`, JSON.stringify(policy), "utf8");
}

async function readLocalContentMeta(absPath: string): Promise<StorageObjectMetadata> {
  let contentType = "application/octet-stream";
  try {
    const raw = await fs.readFile(`${absPath}.meta.json`, "utf8");
    const m = JSON.parse(raw) as { contentType?: string };
    if (typeof m.contentType === "string" && m.contentType.length > 0) {
      contentType = m.contentType;
    }
  } catch {
    // no sidecar → keep default
  }
  const stat = await fs.stat(absPath);
  return { contentType, size: stat.size };
}

export async function writeLocalContentMeta(
  absPath: string,
  contentType: string,
): Promise<void> {
  await fs.writeFile(
    `${absPath}.meta.json`,
    JSON.stringify({ contentType }),
    "utf8",
  );
}

/**
 * Resolve the absolute on-disk path for a `/objects/<entityId>` virtual
 * path, ensuring it stays inside `LOCAL_STORAGE_DIR`.
 */
export function resolveLocalObjectAbsPath(objectPath: string): {
  absPath: string;
  entityId: string;
} {
  const entityId = entityIdFromObjectPath(objectPath);
  const absPath = safeJoinUnderRoot(getLocalRoot(), entityId);
  return { absPath, entityId };
}

export class ObjectStorageService {
  constructor() {}

  getPublicObjectSearchPaths(): Array<string> {
    if (isLocalMode()) {
      // In local mode, public assets live under <LOCAL_STORAGE_DIR>/public.
      return [path.join(getLocalRoot(), "public")];
    }
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p.length > 0),
      ),
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          "tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths).",
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    if (isLocalMode()) {
      return getLocalRoot();
    }
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var.",
      );
    }
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<StorageObject | null> {
    if (isLocalMode()) {
      const root = path.join(getLocalRoot(), "public");
      const abs = safeJoinUnderRoot(root, filePath);
      try {
        await fs.access(abs);
      } catch {
        return null;
      }
      return {
        kind: "local",
        absolutePath: abs,
        entityId: `public/${filePath}`,
        isPublic: true,
      };
    }
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;
      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);
      const [exists] = await file.exists();
      if (exists) {
        return { kind: "gcs", file };
      }
    }
    return null;
  }

  async downloadObject(
    obj: StorageObject,
    cacheTtlSec: number = 3600,
  ): Promise<Response> {
    if (obj.kind === "local") {
      const meta = await readLocalContentMeta(obj.absolutePath);
      const acl = await readLocalAclPolicy(obj.absolutePath);
      const isPublic = obj.isPublic || acl?.visibility === "public";
      const nodeStream = fsCreateReadStream(obj.absolutePath);
      const webStream = Readable.toWeb(nodeStream) as ReadableStream;
      const headers: Record<string, string> = {
        "Content-Type": meta.contentType,
        "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
        "Content-Length": String(meta.size),
      };
      return new Response(webStream, { headers });
    }
    const file = obj.file;
    const [metadata] = await file.getMetadata();
    const aclPolicy = await getGcsObjectAclPolicy(file);
    const isPublic = aclPolicy?.visibility === "public";
    const nodeStream = file.createReadStream();
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;
    const headers: Record<string, string> = {
      "Content-Type":
        (metadata.contentType as string) || "application/octet-stream",
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) {
      headers["Content-Length"] = String(metadata.size);
    }
    return new Response(webStream, { headers });
  }

  async getObjectMetadata(obj: StorageObject): Promise<StorageObjectMetadata> {
    if (obj.kind === "local") {
      return readLocalContentMeta(obj.absolutePath);
    }
    const [metadata] = await obj.file.getMetadata();
    return {
      contentType:
        (metadata.contentType as string) || "application/octet-stream",
      size: Number(metadata.size ?? 0),
    };
  }

  async readObjectAsBuffer(obj: StorageObject): Promise<Buffer> {
    if (obj.kind === "local") {
      return fs.readFile(obj.absolutePath);
    }
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = obj.file.createReadStream();
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  }

  async getAclPolicy(obj: StorageObject): Promise<ObjectAclPolicy | null> {
    if (obj.kind === "local") {
      return readLocalAclPolicy(obj.absolutePath);
    }
    return getGcsObjectAclPolicy(obj.file);
  }

  async setAclPolicy(obj: StorageObject, policy: ObjectAclPolicy): Promise<void> {
    if (obj.kind === "local") {
      await writeLocalAclPolicy(obj.absolutePath, policy);
      return;
    }
    await setGcsObjectAclPolicy(obj.file, policy);
  }

  async getObjectEntityUploadURL(organizationId: number): Promise<string> {
    if (!Number.isInteger(organizationId) || organizationId <= 0) {
      throw new Error("getObjectEntityUploadURL requires a positive organizationId");
    }
    const objectId = randomUUID();
    const entityId = `uploads/org-${organizationId}/${objectId}`;
    const objectPath = `/objects/${entityId}`;

    if (isLocalMode()) {
      const exp = Math.floor(Date.now() / 1000) + 900; // 15 min
      const token = signLocalToken({ op: "put", path: objectPath, exp });
      // Relative URL — the browser will PUT to current origin. The
      // `path` query string is informational/aids normalization; the
      // authoritative path is encoded inside the signed token.
      return `/api/storage/local-upload?token=${encodeURIComponent(token)}&path=${encodeURIComponent(objectPath)}`;
    }

    const privateObjectDir = this.getPrivateObjectDir();
    const fullPath = `${privateObjectDir}/${entityId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    return signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 900,
    });
  }

  /**
   * Issue a short-lived URL for an already-validated object that an
   * `<img>` tag (or any cookie-less request) can fetch directly.
   */
  async getObjectEntityViewURL(
    obj: StorageObject,
    ttlSec: number = 3600,
  ): Promise<string> {
    if (obj.kind === "local") {
      const objectPath = `/objects/${obj.entityId}`;
      const exp = Math.floor(Date.now() / 1000) + ttlSec;
      const token = signLocalToken({ op: "get", path: objectPath, exp });
      return `/api/storage/local-view?token=${encodeURIComponent(token)}&path=${encodeURIComponent(objectPath)}`;
    }
    return signObjectURL({
      bucketName: obj.file.bucket.name,
      objectName: obj.file.name,
      method: "GET",
      ttlSec,
    });
  }

  async getObjectEntityFile(objectPath: string): Promise<StorageObject> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    if (isLocalMode()) {
      const { absPath, entityId } = resolveLocalObjectAbsPath(objectPath);
      try {
        await fs.access(absPath);
      } catch {
        throw new ObjectNotFoundError();
      }
      return { kind: "local", absolutePath: absPath, entityId, isPublic: false };
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }
    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return { kind: "gcs", file: objectFile };
  }

  normalizeObjectEntityPath(rawPath: string): string {
    // Local: relative URL with `path` query param
    if (rawPath.startsWith("/api/storage/local-upload") || rawPath.startsWith("/api/storage/local-view")) {
      try {
        const u = new URL(rawPath, "http://placeholder.local");
        const p = u.searchParams.get("path");
        if (p && p.startsWith("/objects/")) return p;
      } catch {
        // fall through
      }
    }
    if (rawPath.startsWith("/objects/")) {
      return rawPath;
    }
    if (!rawPath.startsWith("https://storage.googleapis.com/")) {
      return rawPath;
    }
    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;

    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith("/")) {
      objectEntityDir = `${objectEntityDir}/`;
    }
    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }
    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy,
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }
    const obj = await this.getObjectEntityFile(normalizedPath);
    await this.setAclPolicy(obj, aclPolicy);
    return normalizedPath;
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: StorageObject;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    // Only meaningful for the GCS backend's user-id-based ACLs.
    if (objectFile.kind === "gcs") {
      return canAccessObject({
        userId,
        objectFile: objectFile.file,
        requestedPermission: requestedPermission ?? ObjectPermission.READ,
      });
    }
    const acl = await readLocalAclPolicy(objectFile.absolutePath);
    if (!acl) return false;
    if (acl.visibility === "public" && (requestedPermission ?? ObjectPermission.READ) === ObjectPermission.READ) return true;
    if (!userId) return false;
    return acl.owner === userId;
  }

  /**
   * Cross-tenant access check for `/objects/...` paths served by the
   * storage router. See original gcs implementation for the rule set;
   * the same logic applies regardless of backend.
   */
  async canTenantAccessObject({
    objectPath,
    objectFile,
    organizationId,
  }: {
    objectPath: string;
    objectFile: StorageObject;
    organizationId: number;
  }): Promise<boolean> {
    const ownerOrgId = objectPathOrganizationId(objectPath);
    if (ownerOrgId !== null) {
      if (ownerOrgId === organizationId) return true;
      const acl = await this.getAclPolicy(objectFile);
      return acl?.visibility === "public";
    }
    const acl = await this.getAclPolicy(objectFile);
    if (!acl) return false;
    if (acl.visibility === "public") return true;
    return acl.owner === `org:${organizationId}`;
  }
}

/**
 * Parse the owning organisation id out of an `/objects/uploads/org-<id>/...`
 * path. Returns `null` for paths that don't carry an org segment.
 */
export function objectPathOrganizationId(objectPath: string): number | null {
  if (!objectPath.startsWith("/objects/")) return null;
  const parts = objectPath.slice("/objects/".length).split("/");
  if (parts[0] !== "uploads") return null;
  const seg = parts[1];
  if (!seg || !seg.startsWith("org-")) return null;
  const n = Number(seg.slice("org-".length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseObjectPath(p: string): {
  bucketName: string;
  objectName: string;
} {
  if (!p.startsWith("/")) {
    p = `/${p}`;
  }
  const pathParts = p.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }
  const bucketName = pathParts[1]!;
  const objectName = pathParts.slice(2).join("/");
  return { bucketName, objectName };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
}): Promise<string> {
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, ` +
        `make sure you're running on Replit`,
    );
  }
  const data = (await response.json()) as { signed_url?: string };
  if (!data.signed_url) {
    throw new Error("Sidecar response missing signed_url field");
  }
  return data.signed_url;
}
