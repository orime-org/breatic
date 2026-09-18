// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import React from 'react';

import { authApi } from '@web/data/api/auth';
// The store's own module, not the `@web/stores` barrel. This file and
// `ProtectedRoute` are the two that gate every route, so they can never be
// lazy — and the barrel would put the canvas, mini-tool, inpaint, project and
// toast stores, plus zundo, in the chunk every reader downloads. Measured:
// 9679 bytes of the entry chunk, 3034 of them over the wire.
import {
  toCurrentUser,
  useCurrentUserStore,
} from '@web/stores/current-user';

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
      // Both branches answer about the session this ping was sent with, and a
      // sign-in that completed while it was out makes that answer stale — on a
      // slow link that ordering is reachable either way. A reader signed in as
      // someone else would be signed out by a 401 about the session they no
      // longer have, or renamed to the previous account by a 200 about it
      // while every request carries the new cookie. So both speak only when
      // nobody has spoken first, and `clear()` also clears the persisted
      // mirror the next cold load reads (design §6.3).
      .then((u) => {
        if (cancelled) return;
        if (useCurrentUserStore.getState().user === null) {
          setUser(toCurrentUser(u));
        }
      })
      .catch(() => {
        if (cancelled) return;
        if (useCurrentUserStore.getState().user === null) {
          clear();
        }
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
