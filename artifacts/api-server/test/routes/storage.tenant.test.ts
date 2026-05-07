// Cross-tenant isolation tests for the storage router.
//
// The storage router brokers two pieces of multi-tenant trust:
//   * `POST /storage/uploads/request-url` mints a presigned PUT URL.
//     The path it returns embeds the caller's `org-<id>` segment so
//     the download route can prove ownership from the URL alone.
//   * `GET /storage/objects/*` streams private bucket objects. The
//     route refuses to serve a path whose `org-<id>` segment doesn't
//     match the caller's tenant — unless the object's ACL marks it
//     public (e.g. an org logo intended for embedding in PDFs).
//
// The bucket itself is mocked: we don't talk to GCS or the Replit
// sidecar in tests. The fake records "uploaded" objects in a map so
// the assertions can check both the route's response and what the
// other tenant would see if they tried to read the resulting path.

import { describe, it, expect, beforeEach, vi } from "vitest";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";

// ───────────────────────────────────────────────────────────────────
// In-memory bucket. Mocking `../../src/lib/objectStorage` keeps the
// route code-under-test (`src/routes/storage.ts`) untouched while
// substituting the bits that would otherwise call out to GCS.
// ───────────────────────────────────────────────────────────────────

const PRIVATE_OBJECT_DIR = "/test-bucket/private";

// Shared in-memory bucket + the fake service class. Hoisted via
// `vi.hoisted` because the `vi.mock` factory below is itself hoisted
// to the very top of the module — referencing top-level `let`/`class`
// declarations from inside that factory would TDZ-fail.
const { bucket, FakeObjectStorageService, FakeObjectNotFoundError, state } =
  vi.hoisted(() => {
    const bucket = new Map<
      string,
      {
        body: Buffer;
        contentType: string;
        acl: { owner: string; visibility: "public" | "private" } | null;
      }
    >();
    const state = { nextUploadId: 0 };

    function pathOrgId(objectPath: string): number | null {
      if (!objectPath.startsWith("/objects/")) return null;
      const parts = objectPath.slice("/objects/".length).split("/");
      if (parts[0] !== "uploads") return null;
      const seg = parts[1];
      if (!seg || !seg.startsWith("org-")) return null;
      const n = Number(seg.slice("org-".length));
      return Number.isInteger(n) && n > 0 ? n : null;
    }

    class FakeObjectNotFoundError extends Error {
      constructor() {
        super("Object not found");
        this.name = "ObjectNotFoundError";
      }
    }

    class FakeObjectStorageService {
      async getObjectEntityUploadURL(organizationId: number): Promise<string> {
        if (!Number.isInteger(organizationId) || organizationId <= 0) {
          throw new Error(
            "getObjectEntityUploadURL requires a positive organizationId",
          );
        }
        state.nextUploadId += 1;
        const objectId = `uuid-${state.nextUploadId}`;
        const fullPath = `${PRIVATE_OBJECT_DIR}/uploads/org-${organizationId}/${objectId}`;
        // Mimic a GCS presigned URL shape so `normalizeObjectEntityPath`
        // reduces it back to `/objects/...`.
        return `https://storage.googleapis.com${fullPath}`;
      }

      normalizeObjectEntityPath(rawPath: string): string {
        if (!rawPath.startsWith("https://storage.googleapis.com/")) return rawPath;
        const url = new URL(rawPath);
        const rawObjectPath = url.pathname;
        const dir = `${PRIVATE_OBJECT_DIR}/`;
        if (!rawObjectPath.startsWith(dir)) return rawObjectPath;
        const entityId = rawObjectPath.slice(dir.length);
        return `/objects/${entityId}`;
      }

      async getObjectEntityFile(
        objectPath: string,
      ): Promise<{ __path: string }> {
        if (!objectPath.startsWith("/objects/"))
          throw new FakeObjectNotFoundError();
        if (!bucket.has(objectPath)) throw new FakeObjectNotFoundError();
        return { __path: objectPath };
      }

      async canTenantAccessObject({
        objectPath,
        organizationId,
      }: {
        objectPath: string;
        objectFile: unknown;
        organizationId: number;
      }): Promise<boolean> {
        const stored = bucket.get(objectPath);
        const ownerOrgId = pathOrgId(objectPath);
        if (ownerOrgId !== null) {
          if (ownerOrgId === organizationId) return true;
          return stored?.acl?.visibility === "public";
        }
        if (!stored?.acl) return false;
        if (stored.acl.visibility === "public") return true;
        return stored.acl.owner === `org:${organizationId}`;
      }

      async searchPublicObject(_filePath: string): Promise<null> {
        // No public assets configured — the public-objects suite only
        // asserts that auth is not required, not that any particular
        // asset exists.
        return null;
      }

      async getObjectEntityViewURL(
        objectFile: { __path: string },
        ttlSec: number = 3600,
      ): Promise<string> {
        // Mimic a presigned GCS GET URL so the route handler can
        // return something the browser would actually call.
        return `https://storage.googleapis.com${PRIVATE_OBJECT_DIR}${objectFile.__path.slice("/objects".length)}?signed=1&ttl=${ttlSec}`;
      }

      async downloadObject(objectFile: {
        __path: string;
      }): Promise<Response> {
        const stored = bucket.get(objectFile.__path)!;
        return new Response(stored.body, {
          headers: { "Content-Type": stored.contentType },
        });
      }
    }

    return { bucket, FakeObjectStorageService, FakeObjectNotFoundError, state };
  });

vi.mock("../../src/lib/objectStorage", () => ({
  ObjectStorageService: FakeObjectStorageService,
  ObjectNotFoundError: FakeObjectNotFoundError,
}));

vi.mock("../../src/lib/tenant", () => ({
  tenantMiddleware: (req: Request, res: Response, next: NextFunction) => {
    const orgId = Number(req.header("x-test-org-id"));
    if (!Number.isFinite(orgId) || orgId <= 0) {
      res.status(401).json({ error: "missing x-test-org-id header" });
      return;
    }
    req.tenant = {
      userId: orgId * 10,
      organizationId: orgId,
      role: "owner",
      clerkUserId: `user_test_${orgId}`,
      isSuperAdmin: false,
    };
    next();
  },
}));

import storageRouter, { publicRouter as publicStorageRouter } from "../../src/routes/storage";

const ORG_A = 1001;
const ORG_B = 2002;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  // Mock pino-http's `req.log` so the route's `req.log.warn/.error`
  // calls don't throw inside the in-memory test harness.
  app.use((req, _res, next) => {
    (req as unknown as { log: { warn: () => void; error: () => void } }).log = {
      warn: () => undefined,
      error: () => undefined,
    };
    next();
  });
  // Mirror routes/index.ts: public storage routes are mounted before
  // the tenant-protected ones so they bypass tenantMiddleware.
  app.use(publicStorageRouter);
  app.use(storageRouter);
  return app;
}

function seedObject(
  objectPath: string,
  opts: {
    body?: Buffer;
    contentType?: string;
    acl?: { owner: string; visibility: "public" | "private" } | null;
  } = {},
) {
  bucket.set(objectPath, {
    body: opts.body ?? Buffer.from("payload"),
    contentType: opts.contentType ?? "image/png",
    acl: opts.acl === undefined ? null : opts.acl,
  });
}

describe("storage cross-tenant isolation", () => {
  let app: Express;

  beforeEach(() => {
    bucket.clear();
    state.nextUploadId = 0;
    app = buildApp();
  });

  describe("POST /storage/uploads/request-url", () => {
    it("requires an authenticated tenant", async () => {
      const res = await request(app)
        .post("/storage/uploads/request-url")
        .send({ name: "x.png", size: 10, contentType: "image/png" });
      expect(res.status).toBe(401);
    });

    it("embeds the caller's org segment in the returned object path", async () => {
      const res = await request(app)
        .post("/storage/uploads/request-url")
        .set("x-test-org-id", String(ORG_A))
        .send({ name: "x.png", size: 10, contentType: "image/png" });
      expect(res.status).toBe(200);
      expect(res.body.objectPath).toMatch(
        new RegExp(`^/objects/uploads/org-${ORG_A}/`),
      );
      // The signed URL also points at the org-scoped prefix — the
      // client cannot rewrite the path before PUTting.
      expect(res.body.uploadURL).toContain(`/uploads/org-${ORG_A}/`);
      expect(res.body.uploadURL).not.toContain(`/uploads/org-${ORG_B}/`);
    });

    it("two orgs hitting the route get disjoint, org-scoped paths", async () => {
      const a = await request(app)
        .post("/storage/uploads/request-url")
        .set("x-test-org-id", String(ORG_A))
        .send({ name: "a.png", size: 1, contentType: "image/png" });
      const b = await request(app)
        .post("/storage/uploads/request-url")
        .set("x-test-org-id", String(ORG_B))
        .send({ name: "b.png", size: 1, contentType: "image/png" });
      expect(a.body.objectPath).toContain(`/uploads/org-${ORG_A}/`);
      expect(b.body.objectPath).toContain(`/uploads/org-${ORG_B}/`);
      expect(a.body.objectPath).not.toBe(b.body.objectPath);
    });
  });

  describe("GET /storage/objects/*", () => {
    it("requires an authenticated tenant", async () => {
      seedObject(`/objects/uploads/org-${ORG_A}/uuid-1`);
      const res = await request(app).get(
        `/storage/objects/uploads/org-${ORG_A}/uuid-1`,
      );
      expect(res.status).toBe(401);
    });

    it("serves the caller their own org-scoped object", async () => {
      const path = `/objects/uploads/org-${ORG_A}/uuid-1`;
      seedObject(path, { body: Buffer.from("a-secret"), contentType: "image/png" });
      const res = await request(app)
        .get(`/storage/objects/uploads/org-${ORG_A}/uuid-1`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(200);
      expect(res.body.toString("utf8")).toBe("a-secret");
    });

    it("returns 403 when org B tries to read org A's private object", async () => {
      // Org A "uploaded" something private — no ACL stamped on the
      // raw upload, the path's `org-1001` segment is the sole proof
      // of ownership.
      const path = `/objects/uploads/org-${ORG_A}/uuid-1`;
      seedObject(path, { body: Buffer.from("a-secret") });
      const res = await request(app)
        .get(`/storage/objects/uploads/org-${ORG_A}/uuid-1`)
        .set("x-test-org-id", String(ORG_B));
      expect(res.status).toBe(403);
      // And critically, the response body does NOT contain the file.
      expect(res.text).not.toContain("a-secret");
    });

    it("still serves a cross-org object whose ACL marks it public (org logo flow)", async () => {
      // Org A's logo: stored under their org prefix but explicitly
      // claimed as `public` so it can render in customer-facing PDFs
      // requested by anyone (including other tenants viewing a
      // shared invoice link).
      const path = `/objects/uploads/org-${ORG_A}/logo`;
      seedObject(path, {
        body: Buffer.from("public-logo"),
        acl: { owner: `org:${ORG_A}`, visibility: "public" },
      });
      const res = await request(app)
        .get(`/storage/objects/uploads/org-${ORG_A}/logo`)
        .set("x-test-org-id", String(ORG_B));
      expect(res.status).toBe(200);
      expect(res.body.toString("utf8")).toBe("public-logo");
    });

    it("returns 404 (not 403) for a path that doesn't exist", async () => {
      const res = await request(app)
        .get(`/storage/objects/uploads/org-${ORG_A}/missing`)
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(404);
    });

    it("legacy paths without an org segment fall back to ACL — and fail closed when unowned", async () => {
      // A pre-existing upload with no ACL stamped. Without the
      // segment we can't prove ownership from the URL, and with no
      // ACL there is nothing to authorise the read. Result: 403 for
      // every caller, including org A.
      const path = `/objects/uploads/legacy-uuid`;
      seedObject(path, { acl: null });
      const res = await request(app)
        .get("/storage/objects/uploads/legacy-uuid")
        .set("x-test-org-id", String(ORG_A));
      expect(res.status).toBe(403);
    });

    it("legacy paths with an `org:<id>` ACL only serve the owning org", async () => {
      const path = `/objects/uploads/legacy-claimed`;
      seedObject(path, {
        acl: { owner: `org:${ORG_A}`, visibility: "private" },
      });
      const okA = await request(app)
        .get("/storage/objects/uploads/legacy-claimed")
        .set("x-test-org-id", String(ORG_A));
      expect(okA.status).toBe(200);
      const denyB = await request(app)
        .get("/storage/objects/uploads/legacy-claimed")
        .set("x-test-org-id", String(ORG_B));
      expect(denyB.status).toBe(403);
    });
  });

  describe("POST /storage/sign-view", () => {
    it("requires an authenticated tenant", async () => {
      seedObject(`/objects/uploads/org-${ORG_A}/uuid-1`);
      const res = await request(app)
        .post("/storage/sign-view")
        .send({ path: `/objects/uploads/org-${ORG_A}/uuid-1` });
      expect(res.status).toBe(401);
    });

    it("returns 400 when the body is missing or malformed", async () => {
      const noBody = await request(app)
        .post("/storage/sign-view")
        .set("x-test-org-id", String(ORG_A))
        .send({});
      expect(noBody.status).toBe(400);

      const wrongPrefix = await request(app)
        .post("/storage/sign-view")
        .set("x-test-org-id", String(ORG_A))
        .send({ path: "/etc/passwd" });
      expect(wrongPrefix.status).toBe(400);
    });

    it("returns a signed GCS URL for the caller's own object", async () => {
      const path = `/objects/uploads/org-${ORG_A}/uuid-1`;
      seedObject(path, { body: Buffer.from("a-secret"), contentType: "image/png" });
      const res = await request(app)
        .post("/storage/sign-view")
        .set("x-test-org-id", String(ORG_A))
        .send({ path });
      expect(res.status).toBe(200);
      expect(typeof res.body.url).toBe("string");
      expect(res.body.url).toContain("storage.googleapis.com");
      expect(res.body.url).toContain(`org-${ORG_A}`);
      expect(typeof res.body.expiresAt).toBe("string");
      // expiresAt parses as a future ISO timestamp.
      expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it("returns 403 when org B asks to sign org A's private object", async () => {
      const path = `/objects/uploads/org-${ORG_A}/uuid-1`;
      seedObject(path, { body: Buffer.from("a-secret") });
      const res = await request(app)
        .post("/storage/sign-view")
        .set("x-test-org-id", String(ORG_B))
        .send({ path });
      expect(res.status).toBe(403);
      // Crucially, no signed URL leaks in the body.
      expect(res.body.url).toBeUndefined();
    });

    it("signs a public-ACL object for any tenant (org logo flow)", async () => {
      const path = `/objects/uploads/org-${ORG_A}/logo`;
      seedObject(path, {
        body: Buffer.from("public-logo"),
        acl: { owner: `org:${ORG_A}`, visibility: "public" },
      });
      const res = await request(app)
        .post("/storage/sign-view")
        .set("x-test-org-id", String(ORG_B))
        .send({ path });
      expect(res.status).toBe(200);
      expect(res.body.url).toContain("storage.googleapis.com");
    });

    it("returns 404 for a path that doesn't exist", async () => {
      const res = await request(app)
        .post("/storage/sign-view")
        .set("x-test-org-id", String(ORG_A))
        .send({ path: `/objects/uploads/org-${ORG_A}/missing` });
      expect(res.status).toBe(404);
    });
  });

  describe("upload → download round trip", () => {
    it("a presigned upload from org A cannot be read back by org B", async () => {
      // 1. Org A asks for an upload URL.
      const reqUrl = await request(app)
        .post("/storage/uploads/request-url")
        .set("x-test-org-id", String(ORG_A))
        .send({ name: "secret.png", size: 8, contentType: "image/png" });
      expect(reqUrl.status).toBe(200);
      const objectPath = reqUrl.body.objectPath as string;

      // 2. Simulate the client PUTting the file to the presigned URL
      //    by populating the in-memory bucket directly.
      seedObject(objectPath, { body: Buffer.from("a-secret") });

      // 3. Org B knows the path (e.g. it leaked into their logs)
      //    and tries to fetch it. Must be 403.
      const cross = await request(app)
        .get(`/storage${objectPath}`)
        .set("x-test-org-id", String(ORG_B));
      expect(cross.status).toBe(403);

      // 4. Org A reading it back works.
      const own = await request(app)
        .get(`/storage${objectPath}`)
        .set("x-test-org-id", String(ORG_A));
      expect(own.status).toBe(200);
      expect(own.body.toString("utf8")).toBe("a-secret");
    });
  });

  describe("GET /storage/public-objects/* (mounted before tenantMiddleware)", () => {
    it("works without auth — these are server-managed static assets", async () => {
      // We don't seed anything here because `searchPublicObject`
      // hits the live bucket; the important assertion is just that
      // the request reaches the handler (i.e. NOT a 401 from
      // tenantMiddleware kicking in) and the in-memory fake responds
      // with a 500/404 on its own. Mocking a public-search hit would
      // require also mocking `searchPublicObject`, which is out of
      // scope — the cross-tenant property here is just "auth is not
      // required".
      const res = await request(app).get(
        "/storage/public-objects/some-asset.png",
      );
      expect(res.status).not.toBe(401);
    });
  });
});
