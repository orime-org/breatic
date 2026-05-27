import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { LoadingScreen } from '@/pages/project/chrome/LoadingScreen';
import { useCurrentUserStore } from '@/stores';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

/**
 * ProtectedRoute — gates a route on `useCurrentUserStore.user` being
 * populated. Consumes the `bootstrapped` flag from the store to
 * distinguish three states:
 *
 *   - `!bootstrapped` — the `AuthBootstrap` `/auth/me` ping has not
 *     yet completed. Render a loading shell. Bouncing to `/login`
 *     here would flash the auth page on every cold reload before
 *     the cookie check returned (the original bug — Q3 / Q4).
 *
 *   - `bootstrapped && !user` — the boot ping completed and confirmed
 *     no valid session (401 / missing cookie / network error). Bounce
 *     to `/login`, preserving the originally-requested path in router
 *     state so the login page can return the user there after a
 *     successful sign-in.
 *
 *   - `bootstrapped && user` — authenticated. Render children.
 *
 * Use at the route-table level (`routes.tsx`), wrapping any page that
 * depends on `useCurrentUserStore.user` being non-null — Studio,
 * Project, and any future authenticated surfaces.
 */
export default function ProtectedRoute({
  children,
}: ProtectedRouteProps): React.ReactElement {
  const user = useCurrentUserStore((s) => s.user);
  const bootstrapped = useCurrentUserStore((s) => s.bootstrapped);
  const location = useLocation();

  if (!bootstrapped) {
    return <LoadingScreen />;
  }

  if (!user) {
    return <Navigate to='/login' replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
