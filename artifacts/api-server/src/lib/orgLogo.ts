// Shared loader for the organisation logo used across every PDF
// document. Handles uploaded logos (object storage with ACL owner
// check), external HTTP(S) URLs (with SSRF guards), and the
// content-type / size limits PDFKit needs.

import dns from "node:dns/promises";
import net from "node:net";
import { logger } from "./logger";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";

const objectStorageService = new ObjectStorageService();

async function fetchLogoFromObjectStorage(
  objectPath: string,
  organizationId: number,
): Promise<Buffer | null> {
  try {
    const obj = await objectStorageService.getObjectEntityFile(objectPath);
    // Tenant-isolation guard: refuse to render a logo whose ACL owner does not
    // match this organization. Logos uploaded through PATCH /organizations/current
    // get an `org:<id>` owner stamped on them.
    const acl = await objectStorageService.getAclPolicy(obj);
    const expectedOwner = `org:${organizationId}`;
    if (!acl || acl.owner !== expectedOwner) {
      logger.warn(
        { objectPath, organizationId, aclOwner: acl?.owner ?? null },
        "Skipping org logo: ACL owner does not match organization",
      );
      return null;
    }
    const meta = await objectStorageService.getObjectMetadata(obj);
    const ct = (meta.contentType ?? "").toLowerCase();
    if (!ct.startsWith("image/png") && !ct.startsWith("image/jpeg")) {
      logger.warn(
        { objectPath, contentType: ct },
        "Org logo object is not a PNG/JPEG, skipping for PDF",
      );
      return null;
    }
    if (meta.size > 2 * 1024 * 1024) {
      logger.warn(
        { objectPath, size: meta.size },
        "Org logo object is larger than 2 MB, skipping for PDF",
      );
      return null;
    }
    try {
      return await objectStorageService.readObjectAsBuffer(obj);
    } catch (err) {
      logger.warn({ err, objectPath }, "Failed reading org logo from object storage");
      return null;
    }
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      logger.warn({ objectPath }, "Org logo object not found in storage");
      return null;
    }
    logger.warn({ err, objectPath }, "Failed loading org logo from storage");
    return null;
  }
}

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (h === "metadata.google.internal") return true;
  return false;
}

function isBlockedIPv4(addr: string): boolean {
  const m = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return true;
  const o = m.slice(1).map((s) => Number(s));
  if (o.some((n) => n < 0 || n > 255)) return true;
  const [a, b] = o as [number, number, number, number];
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isBlockedIPv6(addr: string): boolean {
  const a = addr.toLowerCase().split("%")[0]!;
  if (a === "::" || a === "::1") return true;
  if (a.startsWith("fe80:") || a.startsWith("fc") || a.startsWith("fd")) return true;
  if (a.startsWith("ff")) return true; // multicast
  // ::ffff:x.x.x.x mapped IPv4
  const mapped = a.match(/^::ffff:([0-9a-f.:]+)$/);
  if (mapped) {
    const inner = mapped[1]!;
    if (inner.includes(".")) return isBlockedIPv4(inner);
  }
  return false;
}

async function isHostSafe(hostname: string): Promise<boolean> {
  if (isBlockedHostname(hostname)) return false;
  if (net.isIPv4(hostname)) return !isBlockedIPv4(hostname);
  if (net.isIPv6(hostname)) return !isBlockedIPv6(hostname);
  try {
    const results = await dns.lookup(hostname, { all: true, verbatim: true });
    if (results.length === 0) return false;
    for (const r of results) {
      if (r.family === 4 && isBlockedIPv4(r.address)) return false;
      if (r.family === 6 && isBlockedIPv6(r.address)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function fetchLogoBuffer(
  url: string | null,
  organizationId: number,
): Promise<Buffer | null> {
  if (!url) return null;
  if (url.startsWith("/objects/")) {
    return fetchLogoFromObjectStorage(url, organizationId);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (!(await isHostSafe(parsed.hostname))) {
    logger.warn({ url }, "Blocked logo URL targeting private/loopback host");
    return null;
  }
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(parsed.toString(), {
      signal: ctrl.signal,
      redirect: "manual",
    });
    clearTimeout(timeout);
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.startsWith("image/png") && !ct.startsWith("image/jpeg")) return null;
    const ab = await r.arrayBuffer();
    if (ab.byteLength > 2 * 1024 * 1024) return null;
    return Buffer.from(ab);
  } catch (err) {
    logger.warn({ err, url }, "Could not fetch organization logo for invoice");
    return null;
  }
}
