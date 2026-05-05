import { useQuery } from "@tanstack/react-query";
import { signObjectViewUrl } from "@workspace/api-client-react";

/**
 * Resolve a stored image reference to a browser-loadable URL.
 *
 * Three cases:
 *   1. null / empty           → returns null (no image).
 *   2. absolute http(s) URL   → returned as-is (e.g. Shopify CDN images).
 *   3. `/objects/...` path    → asks the API for a short-lived signed
 *                               GCS GET URL via `POST /storage/sign-view`
 *                               and returns that. Cached for 50 minutes
 *                               (signed URLs live for 60 minutes).
 *
 * We can't just hit `/api/storage/objects/...` from an `<img src>` tag
 * because that route requires a Bearer token, and image requests can't
 * carry custom headers. The signed URL hits GCS directly with auth
 * baked into the query string.
 */
export function useImageSrc(value: string | null | undefined): {
  src: string | null;
  isLoading: boolean;
} {
  const trimmed = value?.trim() || "";
  const isAbsolute = /^https?:\/\//i.test(trimmed);
  const isObject = trimmed.startsWith("/objects/");
  const needsSigning = isObject;

  const query = useQuery({
    queryKey: ["storage", "sign-view", trimmed],
    queryFn: async () => {
      const res = await signObjectViewUrl({ path: trimmed });
      return res.url;
    },
    enabled: needsSigning,
    staleTime: 50 * 60 * 1000,
    gcTime: 55 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  if (!trimmed) return { src: null, isLoading: false };
  if (isAbsolute) return { src: trimmed, isLoading: false };
  if (needsSigning) {
    return { src: query.data ?? null, isLoading: query.isLoading };
  }
  return { src: trimmed, isLoading: false };
}
