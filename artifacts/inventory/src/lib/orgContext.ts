import { setOrganizationId } from "@workspace/api-client-react";

const STORAGE_KEY = "mystics.activeOrgId";

function readStored(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Read the active organization id without touching the API client.
 * Useful for components that just need to know whether a "view as"
 * override is currently active.
 */
export function getActiveOrgId(): number | null {
  return readStored();
}

/**
 * Persist the active organization id and apply it to every subsequent
 * API request via the `X-Organization-Id` header. Pass `null` to
 * clear the override and let the server pick the user's default org.
 */
export function setActiveOrgId(id: number | null): void {
  if (typeof window !== "undefined") {
    try {
      if (id == null) {
        window.localStorage.removeItem(STORAGE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_KEY, String(id));
      }
    } catch {
      /* ignore quota / privacy errors */
    }
  }
  setOrganizationId(id);
}

/**
 * Hydrate the API client with whatever org id was last persisted.
 * Call once on app boot, before any API queries fire.
 */
export function initActiveOrgFromStorage(): void {
  setOrganizationId(readStored());
}
