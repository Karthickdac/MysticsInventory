/**
 * Role-based access control.
 *
 * One role per organization member. The set is closed and enforced at
 * the edge by `tenantMiddleware` (after `req.tenant` is populated).
 *
 * Legacy DB rows may still hold `member` (the original default before
 * we expanded the role set). We treat `member` as `manager` to
 * preserve their previous behaviour: they had full app access except
 * Team management.
 *
 * Super admins (users.is_super_admin = true) bypass every check —
 * they can already switch into any org via `X-Organization-Id`.
 */

export const ROLE_VALUES = [
  "owner",
  "admin",
  "manager",
  "accountant",
  "salesman",
  "viewer",
] as const;

export type Role = (typeof ROLE_VALUES)[number];

export const ALL_ROLES: readonly Role[] = ROLE_VALUES;
export const ADMIN_ROLES: readonly Role[] = ["owner", "admin"];
export const MANAGER_AND_UP: readonly Role[] = ["owner", "admin", "manager"];
export const ACCOUNTING_AND_UP: readonly Role[] = [
  "owner",
  "admin",
  "manager",
  "accountant",
];
export const SALES_AND_UP: readonly Role[] = [
  "owner",
  "admin",
  "manager",
  "salesman",
];

/**
 * Map any string stored in `organization_members.role` (including the
 * legacy `member` value) to a known Role. Unknown values fall back to
 * `viewer` so a typo can never accidentally grant elevated access.
 */
export function normalizeRole(raw: string | null | undefined): Role {
  if (!raw) return "viewer";
  const r = raw.trim().toLowerCase();
  if (r === "member") return "manager"; // legacy alias — preserve prior access
  if ((ROLE_VALUES as readonly string[]).includes(r)) return r as Role;
  return "viewer";
}

const WRITE_METHODS = /^(POST|PATCH|PUT|DELETE)$/;
const ANY_METHOD = /.*/;

interface Policy {
  methods: RegExp;
  pattern: RegExp;
  allow: readonly Role[];
}

/**
 * First matching policy wins. Paths are the request path AFTER the
 * `/api` mount, so they start with `/team`, `/items`, etc.
 *
 * Routes not matched by any policy default to allow-for-any-role —
 * that's safe because every role is already a member of the org and
 * `tenantMiddleware` has confirmed they may operate inside it.
 */
const POLICIES: readonly Policy[] = [
  // ── Workspace administration ───────────────────────────────────
  { methods: ANY_METHOD, pattern: /^\/team(\/|$)/, allow: ADMIN_ROLES },
  { methods: ANY_METHOD, pattern: /^\/email-settings(\/|$)/, allow: ADMIN_ROLES },
  {
    methods: ANY_METHOD,
    pattern: /^\/(shopify|shiprocket|ewb|einvoice)(\/|$)/,
    allow: ADMIN_ROLES,
  },
  { methods: ANY_METHOD, pattern: /^\/onboarding(\/|$)/, allow: ADMIN_ROLES },
  {
    methods: WRITE_METHODS,
    pattern: /^\/organizations(\/|$)/,
    allow: ADMIN_ROLES,
  },
  {
    methods: WRITE_METHODS,
    pattern: /^\/subscription(\/|$)/,
    allow: ADMIN_ROLES,
  },

  // ── POS — sales-floor staff and up ─────────────────────────────
  { methods: ANY_METHOD, pattern: /^\/pos(\/|$)/, allow: SALES_AND_UP },

  // ── Customers / sales orders — salesman and up may write ───────
  {
    methods: WRITE_METHODS,
    pattern: /^\/customers(\/|$)/,
    allow: SALES_AND_UP,
  },
  {
    methods: WRITE_METHODS,
    pattern: /^\/sales-orders(\/|$)/,
    allow: SALES_AND_UP,
  },

  // ── Money in/out — accountant and up may write ─────────────────
  {
    methods: WRITE_METHODS,
    pattern: /^\/(customer-payments|payment-links|supplier-payments)(\/|$)/,
    allow: ACCOUNTING_AND_UP,
  },

  // ── Inventory + procurement writes — manager and up ────────────
  {
    methods: WRITE_METHODS,
    pattern:
      /^\/(items|suppliers|warehouses|stock-movements|stock-transfers|purchase-orders|goods-receipts|shipments|job-work-orders)(\/|$)/,
    allow: MANAGER_AND_UP,
  },
];

export interface PolicyResult {
  allowed: boolean;
  matched: boolean;
}

/**
 * Decide whether `role` may invoke `method path`. Returns
 * `{ allowed: true, matched: false }` when no policy fires (default
 * allow), so callers can distinguish "no opinion" from "explicit yes".
 */
export function checkRolePolicy(
  method: string,
  path: string,
  role: Role,
): PolicyResult {
  const upperMethod = method.toUpperCase();
  for (const p of POLICIES) {
    if (!p.methods.test(upperMethod)) continue;
    if (!p.pattern.test(path)) continue;
    return { allowed: p.allow.includes(role), matched: true };
  }
  return { allowed: true, matched: false };
}
