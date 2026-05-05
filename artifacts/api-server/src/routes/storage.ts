import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
  SignObjectViewUrlBody,
  SignObjectViewUrlResponse,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { tenantMiddleware } from "../lib/tenant";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS. These are
 * unconditionally public — they're server-managed static assets
 * (e.g. seeded onboarding images), NOT user uploads, and there is no
 * tenant concept attached to them. Mounted BEFORE `tenantMiddleware`
 * so the bucket can be read without an authenticated session.
 */
router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
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

// Everything below this line requires an authenticated tenant. Upload
// URLs and private object reads are tenant-scoped: presigned URLs are
// issued under the caller's `org-<id>/` prefix, and downloads enforce
// that the caller owns the requested object (see
// `ObjectStorageService.canTenantAccessObject`).
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

export default router;
