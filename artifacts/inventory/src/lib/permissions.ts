/**
 * Client-side mirror of `artifacts/api-server/src/lib/permissions.ts`.
 *
 * The server is the source of truth and will 403 anything we get
 * wrong here — these helpers only exist to hide nav items and route
 * guards so users don't get a flash of forbidden content.
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

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  accountant: "Accountant",
  salesman: "Salesman",
  viewer: "Viewer",
};

export function normalizeRole(raw: string | null | undefined): Role {
  if (!raw) return "viewer";
  const r = raw.trim().toLowerCase();
  if (r === "member") return "manager"; // legacy alias
  if ((ROLE_VALUES as readonly string[]).includes(r)) return r as Role;
  return "viewer";
}

const ADMIN: readonly Role[] = ["owner", "admin"];
const MANAGER_AND_UP: readonly Role[] = ["owner", "admin", "manager"];
const ACCOUNTING_AND_UP: readonly Role[] = [
  "owner",
  "admin",
  "manager",
  "accountant",
];
const SALES_AND_UP: readonly Role[] = [
  "owner",
  "admin",
  "manager",
  "salesman",
];
const ALL: readonly Role[] = [...ROLE_VALUES];

/**
 * Which roles may *navigate to* a given top-level page. Reads are
 * permissive (everyone can browse most things); writes are gated
 * server-side, so we only need to lock pages that are pure-admin
 * surfaces or that would have nothing usable for the role.
 */
const PAGE_ACCESS: Array<{ pattern: RegExp; allow: readonly Role[] }> = [
  // Workspace administration
  { pattern: /^\/team(\/|$)/, allow: ADMIN },
  { pattern: /^\/settings(\/|$)/, allow: ADMIN },
  { pattern: /^\/integrations(\/|$)/, allow: ADMIN },
  { pattern: /^\/onboarding(\/|$)/, allow: ADMIN },

  // POS — sales and up only (accountant/viewer would have no use)
  { pattern: /^\/pos(\/|$)/, allow: SALES_AND_UP },

  // Money pages — accountant and up
  { pattern: /^\/payments(\/|$)/, allow: ACCOUNTING_AND_UP },
  { pattern: /^\/supplier-payments(\/|$)/, allow: ACCOUNTING_AND_UP },

  // Procurement — manager and up (accountant/salesman/viewer skip it)
  { pattern: /^\/purchase-orders(\/|$)/, allow: MANAGER_AND_UP },
  { pattern: /^\/job-work(\/|$)/, allow: MANAGER_AND_UP },
  { pattern: /^\/suppliers(\/|$)/, allow: MANAGER_AND_UP },
  { pattern: /^\/transfers(\/|$)/, allow: MANAGER_AND_UP },
  { pattern: /^\/warehouses(\/|$)/, allow: MANAGER_AND_UP },
  { pattern: /^\/stock(\/|$)/, allow: MANAGER_AND_UP },

  // Sales surfaces — salesman and up
  { pattern: /^\/sales-orders(\/|$)/, allow: SALES_AND_UP },
  { pattern: /^\/customers(\/|$)/, allow: SALES_AND_UP },

  // Items — viewable by everyone (read), but salesman doesn't write
  { pattern: /^\/items(\/|$)/, allow: ALL },

  // Reports — accountant + manager + admin/owner + viewer
  {
    pattern: /^\/reports(\/|$)/,
    allow: ["owner", "admin", "manager", "accountant", "viewer"],
  },

  // Dashboard / shared — everyone
  { pattern: /^\/dashboard(\/|$)/, allow: ALL },
];

export function canAccessPath(role: Role, path: string): boolean {
  for (const entry of PAGE_ACCESS) {
    if (entry.pattern.test(path)) return entry.allow.includes(role);
  }
  // Default to allow — pages without an explicit policy are
  // considered shared (e.g. /accept-invitation, /admin which is
  // gated separately by isSuperAdmin).
  return true;
}
