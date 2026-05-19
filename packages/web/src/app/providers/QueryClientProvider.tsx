import { QueryClient, QueryClientProvider as RqProvider } from '@tanstack/react-query';
import * as React from 'react';

import { ApiException } from '@/data/api/types';

/**
 * Global TanStack Query client.
 *
 * Defaults tuned for an SPA backed by REST + Yjs:
 *   - 30s stale time — most lists / details are fine for half a minute
 *     before re-fetching (Yjs handles real-time canvas state separately).
 *   - 3 retries on transient failures; skip retry on 4xx (caller error).
 *   - Throw on 401 (caller decides whether to logout / redirect).
 */
const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        if (error instanceof ApiException && error.status >= 400 && error.status < 500) {
          return false;
        }
        return failureCount < 3;
      },
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});

export function QueryClientProvider({ children }: { children: React.ReactNode }) {
  return <RqProvider client={client}>{children}</RqProvider>;
}

/** Exposed for test fixtures that need to seed cache or invalidate keys. */
export const queryClient = client;
