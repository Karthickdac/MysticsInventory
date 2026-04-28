import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      // Always treat cached data as stale so revisiting a screen
      // re-fetches in the background while showing the cached snapshot.
      // This prevents "I have to refresh to see my change" UX.
      staleTime: 0,
      // Refetch when the user re-focuses the tab or reconnects.
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      // Always re-fetch on mount, even if data exists in cache.
      refetchOnMount: "always",
      // Keep cached data around for 10 minutes after a query is unused
      // so back/forward navigation feels instant (cache is shown
      // immediately while a background refetch updates it).
      gcTime: 10 * 60_000,
    },
  },
});
