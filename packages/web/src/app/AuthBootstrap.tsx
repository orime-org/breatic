// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import React from 'react';

import { authApi } from '@web/data/api/auth';
import { STORAGE_KEYS } from '@web/lib/storage-keys';
import { useCurrentUserStore } from '@web/stores';
import { toCurrentUser } from '@web/stores/current-user';

interface AuthBootstrapProps {
  children: React.ReactNode;
}

/**
 * Record whether this browser holds a session, for the next cold load.
 *
 * `routes.tsx` reads it before this ping can answer, to decide whether a page
 * behind the auth gate is worth fetching early. It is never a permission
 * check — the gate itself is — so a failed write costs one chunk on the next
 * visit and nothing else.
 * @param seen - True when `/auth/me` just answered with a user.
 */
function rememberSession(seen: boolean): void {
  try {
    if (seen) {
      localStorage.setItem(STORAGE_KEYS.sessionSeen, '1');
    } else {
      localStorage.removeItem(STORAGE_KEYS.sessionSeen);
    }
  } catch {
    // Storage is unavailable; the reader pays one uncached chunk.
  }
}

/**
 * AuthBootstrap — on mount, pings `/auth/me` to check whether the
 * httpOnly session cookie corresponds to a valid session
 * and, if so, populates `useCurrentUserStore`. Either way, flips
 * `bootstrapped=true` so ProtectedRoute knows the boot ping has
 * completed and can decide between rendering the protected page
 * and bouncing to `/login`.
 *
 * Lives outside `<RouterProvider>` so the single boot fetch runs
 * once per app load (StrictMode double-mount is guarded by the
 * `cancelled` flag) instead of restarting on every route change.
 *
 * Renders `children` unconditionally — the loading shell is not
 * this component's concern; ProtectedRoute owns it. That split lets
 * public routes (`/login`, `/register`, etc.) mount without waiting
 * on the ping, which would otherwise add a hundreds-of-ms flash to
 * every cold-start visit to the auth pages.
 * @param root0 - The component props.
 * @param root0.children - The subtree rendered unconditionally beneath the boot ping.
 * @returns The `children` subtree, rendered while the `/auth/me` boot ping runs.
 */
export default function AuthBootstrap({
  children,
}: AuthBootstrapProps): React.ReactElement {
  const setUser = useCurrentUserStore((s) => s.setUser);
  const setBootstrapped = useCurrentUserStore((s) => s.setBootstrapped);

  React.useEffect(() => {
    let cancelled = false;
    authApi
      .me()
      .then((u) => {
        if (cancelled) return;
        setUser(toCurrentUser(u));
        rememberSession(true);
      })
      .catch(() => {
        // 401 (no/expired session cookie) or network error — leave
        // user=null. ProtectedRoute will bounce to /login once it
        // observes bootstrapped=true + user=null.
        //
        // The mark is cleared on the same answer: the next cold load of a
        // guarded address then fetches only what it can reach without the
        // gate, which is what a bounced visitor gets to see.
        if (cancelled) return;
        rememberSession(false);
      })
      .finally(() => {
        if (cancelled) return;
        setBootstrapped(true);
      });
    return () => {
      cancelled = true;
    };
  }, [setUser, setBootstrapped]);

  return <>{children}</>;
}
