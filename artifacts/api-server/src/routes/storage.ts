import express, { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import { promises as fs, createReadStream as fsCreateReadStream } from "fs";
import path from "path";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
  SignObjectViewUrlBody,
  SignObjectViewUrlResponse,
} from "@workspace/api-zod";
import {
  ObjectStorageService,
  ObjectNotFoundError,
  verifyLocalToken,
  resolveLocalObjectAbsPath,
  writeLocalContentMeta,
} from "../lib/objectStorage";
import { tenantMiddleware } from "../lib/tenant";

const router: IRouter = Router();
// Public storage routes (token-authenticated or unconditionally public).
// Mounted separately in routes/index.ts BEFORE any router that calls
// `router.use(tenantMiddleware)`, since such middleware fires for every
// request that enters that router and would otherwise 401 these.
const publicRouter: IRouter = Router();
const objectStorageService = new ObjectStorageService();

const MAX_LOCAL_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB ceiling

/**
 * PUT /storage/local-upload?token=...&path=/objects/...
 *
 * Local-disk backend only (when LOCAL_STORAGE_DIR is set). The token
 * is HMAC-signed by the API at request-url issue time and embeds the
 * destination object path + expiry, so this endpoint stays publicly
 * reachable without a tenant cookie — same posture as a presigned
 * GCS PUT URL.
 */
publicRouter.put("/storage/local-upload", express.raw({
  type: "*/*",
  limit: MAX_LOCAL_UPLOAD_BYTES,
}), async (req: Request, res: Response) => {
  if (!process.env.LOCAL_STORAGE_DIR) {
    res.status(404).json({ error: "Local storage not enabled" });
    return;
  }
  const token = String(req.query.token ?? "");
  const payload = verifyLocalToken(token);
  if (!payload || payload.op !== "put") {
    res.status(403).json({ error: "Invalid or expired upload token" });
    return;
  }
  let absPath: string;
  try {
    ({ absPath } = resolveLocalObjectAbsPath(payload.path));
  } catch {
    res.status(400).json({ error: "Invalid object path" });
    return;
  }
  const body = req.body as Buffer | undefined;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    res.status(400).json({ error: "Empty upload body" });
    return;
  }
  try {
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, body);
    const ct = req.headers["content-type"] || "application/octet-stream";
    await writeLocalContentMeta(absPath, Array.isArray(ct) ? ct[0]! : String(ct));
    res.status(200).json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Local upload write failed");
    res.status(500).json({ error: "Failed to write upload" });
  }
});

/**
 * GET /storage/local-view?token=...&path=/objects/...
 *
 * Local-disk backend only. Same role as a presigned GCS GET URL —
 * the API issues these via getObjectEntityViewURL after running
 * the tenant-ownership check, and the browser <img> tag fetches
 * them directly without the bearer cookie.
 */
publicRouter.get("/storage/local-view", async (req: Request, res: Response) => {
  if (!process.env.LOCAL_STORAGE_DIR) {
    res.status(404).json({ error: "Local storage not enabled" });
    return;
  }
  const token = String(req.query.token ?? "");
  const payload = verifyLocalToken(token);
  if (!payload || payload.op !== "get") {
    res.status(403).json({ error: "Invalid or expired view token" });
    return;
  }
  let absPath: string;
  try {
    ({ absPath } = resolveLocalObjectAbsPath(payload.path));
  } catch {
    res.status(404).json({ error: "Object not found" });
    return;
  }
  let ct = "application/octet-stream";
  try {
    const raw = await fs.readFile(`${absPath}.meta.json`, "utf8");
    const m = JSON.parse(raw) as { contentType?: string };
    if (typeof m.contentType === "string" && m.contentType.length > 0) ct = m.contentType;
  } catch { /* default */ }
  try {
    const stat = await fs.stat(absPath);
    res.setHeader("Content-Type", ct);
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Cache-Control", "private, max-age=3600");
    const stream = fsCreateReadStream(absPath);
    stream.on("error", (err) => {
      req.log.error({ err }, "Local view stream failed");
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  } catch {
    res.status(404).json({ error: "Object not found" });
  }
});

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS. These are
 * unconditionally public — they're server-managed static assets
 * (e.g. seeded onboarding images), NOT user uploads, and there is no
 * tenant concept attached to them. Mounted BEFORE `tenantMiddleware`
 * so the bucket can be read without an authenticated session.
 */
publicRouter.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(file);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    req.log.error({ err: error }, "Error serving public object");
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

// Everything in `router` requires an authenticated tenant. Upload URLs
// and private object reads are tenant-scoped: presigned URLs are issued
// under the caller's `org-<id>/` prefix, and downloads enforce that the
// caller owns the requested object (see
// `ObjectStorageService.canTenantAccessObject`). Public token-auth
// routes live on `publicRouter` (exported separately).
router.use(tenantMiddleware);

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 *
 * The returned object path embeds the caller's organization id
 * (`/objects/uploads/org-<id>/<uuid>`) so the download route can
 * enforce tenant isolation from the URL alone.
 */
router.post("/storage/uploads/request-url", async (req: Request, res: Response) => {
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  try {
    const t = req.tenant!;
    const { name, size, contentType } = parsed.data;

    const uploadURL = await objectStorageService.getObjectEntityUploadURL(
      t.organizationId,
    );
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    res.json(
      RequestUploadUrlResponse.parse({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType },
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "Error generating upload URL");
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/**
 * POST /storage/sign-view
 *
 * Issue a short-lived presigned GCS GET URL for `path`. Used by
 * `<img>` tags rendering tenant-scoped objects: the browser cannot
 * attach the bearer token to a plain image request, so we sign a
 * direct GCS URL after running the same tenant-ownership check that
 * `GET /storage/objects/*` enforces. The signed URL is good for one
 * hour.
 */
router.post("/storage/sign-view", async (req: Request, res: Response) => {
  const parsed = SignObjectViewUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid path" });
    return;
  }
  const { path } = parsed.data;
  if (!path.startsWith("/objects/")) {
    res.status(400).json({ error: "Path must start with /objects/" });
    return;
  }
  try {
    const t = req.tenant!;
    const objectFile = await objectStorageService.getObjectEntityFile(path);
    const allowed = await objectStorageService.canTenantAccessObject({
      objectPath: path,
      objectFile,
      organizationId: t.organizationId,
    });
    if (!allowed) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const url = await objectStorageService.getObjectEntityViewURL(
      objectFile,
      3600,
    );
    res.json(
      SignObjectViewUrlResponse.parse({
        url,
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      }),
    );
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error signing object view URL");
    res.status(500).json({ error: "Failed to sign view URL" });
  }
});

/**
 * GET /storage/objects/*
 *
 * Serve private object entities from PRIVATE_OBJECT_DIR. Requires
 * the caller to be the owning tenant (path-derived) or for the object
 * to be explicitly marked public via its ACL (e.g. an org logo). All
 * other reads return 403.
 */
router.get("/storage/objects/*path", async (req: Request, res: Response) => {
  try {
    const t = req.tenant!;
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const objectPath = `/objects/${wildcardPath}`;
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    const allowed = await objectStorageService.canTenantAccessObject({
      objectPath,
      objectFile,
      organizationId: t.organizationId,
    });
    if (!allowed) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, "Object not found");
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export { publicRouter };
export default router;
