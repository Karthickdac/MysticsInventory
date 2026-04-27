import { useEffect, useState } from "react";
import { useLocation } from "wouter";

/**
 * Reads the `?focus=<id>` query parameter from the current URL.
 * Used by list pages to auto-open the edit drawer for a record
 * when the user lands here from the global command palette.
 *
 * After consumption, callers should call clearFocusParam() to
 * remove the param from the URL so a refresh doesn't re-trigger
 * the side-effect.
 */
export function useFocusParam(): { focusId: number | null; clear: () => void } {
  const [location] = useLocation();
  const [focusId, setFocusId] = useState<number | null>(null);

  useEffect(() => {
    const search = typeof window !== "undefined" ? window.location.search : "";
    const params = new URLSearchParams(search);
    const raw = params.get("focus");
    if (!raw) {
      setFocusId(null);
      return;
    }
    const parsed = Number.parseInt(raw, 10);
    setFocusId(Number.isFinite(parsed) ? parsed : null);
  }, [location]);

  const clear = () => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("focus")) return;
    url.searchParams.delete("focus");
    window.history.replaceState({}, "", url.toString());
    setFocusId(null);
  };

  return { focusId, clear };
}

/**
 * Reads the `?new=1` query parameter from the current URL. Used by
 * list pages to auto-open the create drawer when the user arrives
 * here from the global command palette's "Create" quick actions.
 *
 * Callers should call clear() after consuming the flag so a refresh
 * doesn't re-trigger the side-effect.
 */
export function useNewParam(): { shouldOpenNew: boolean; clear: () => void } {
  const [location] = useLocation();
  const [shouldOpenNew, setShouldOpenNew] = useState(false);

  useEffect(() => {
    const search = typeof window !== "undefined" ? window.location.search : "";
    const params = new URLSearchParams(search);
    setShouldOpenNew(params.get("new") === "1");
  }, [location]);

  const clear = () => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("new")) return;
    url.searchParams.delete("new");
    window.history.replaceState({}, "", url.toString());
    setShouldOpenNew(false);
  };

  return { shouldOpenNew, clear };
}
