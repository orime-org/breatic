// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import React from 'react';

import { authApi } from '@web/data/api/auth';
import { useCurrentUserStore } from '@web/stores';
import { toCurrentUser } from '@web/stores/current-user';

interface AuthBootstrapProps {
  children: React.ReactNode;
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
  const clear = useCurrentUserStore((s) => s.clear);

  React.useEffect(() => {
    let cancelled = false;
    authApi
      .me()
      .then((u) => {
        if (cancelled) return;
        setUser(toCurrentUser(u));
      })
      .catch(() => {
        // 401 (no/expired session cookie) or network error. `clear()` says
        // "no user" through the one place that owns that fact, which also
        // clears the persisted mirror the next cold load reads (design §6.3);
        // the other three fields are already at their initial values here.
        if (cancelled) return;
        clear();
      })
      .finally(() => {
        if (cancelled) return;
        setBootstrapped(true);
      });
    return () => {
      cancelled = true;
    };
  }, [setUser, setBootstrapped, clear]);

  return <>{children}</>;
}
