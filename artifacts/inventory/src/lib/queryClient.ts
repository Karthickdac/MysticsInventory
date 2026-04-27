import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      // Cache results for 1 minute so navigating between menu sections
      // is instant — no spinner flash on revisit.
      staleTime: 60_000,
      // Keep cached data around for 10 minutes after a query is unused
      // so back/forward navigation also feels immediate.
      gcTime: 10 * 60_000,
    },
  },
});
