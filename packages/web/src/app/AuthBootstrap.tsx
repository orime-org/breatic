import React from 'react';

import { authApi, deriveDisplayName } from '@/data/api/auth';
import { useCurrentUserStore } from '@/stores';

interface AuthBootstrapProps {
  children: React.ReactNode;
}

/**
 * AuthBootstrap — on mount, pings `/auth/me` to check whether the
 * httpOnly `breatic_session` cookie corresponds to a valid session
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
        setUser({ id: u.id, name: deriveDisplayName(u), email: u.email });
      })
      .catch(() => {
        // 401 (no/expired session cookie) or network error — leave
        // user=null. ProtectedRoute will bounce to /login once it
        // observes bootstrapped=true + user=null.
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
