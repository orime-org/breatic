// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { LoadingScreen } from '@web/pages/project/chrome/LoadingScreen';
import { useCurrentUserStore } from '@web/stores';

interface ProtectedRouteProps {
  children: React.ReactNode;
  /**
   * Whether the route additionally requires a completed personal studio
   * (`user.personalStudio !== null`). Defaults to `true`. The onboarding
   * slug page sets this to `false` to exempt itself from the personal-
   * studio gate — otherwise it would redirect to itself in an infinite
   * loop (the user has no personal studio precisely because they are on
   * the page that creates it).
   */
  requirePersonalStudio?: boolean;
}

/** Route the personal-studio gate redirects unfinished accounts to (pick a handle). */
const CHOOSE_SLUG_PATH = '/choose-slug';

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
 *     to `/login?next=`, carrying the whole requested destination —
 *     path AND search — so the login page can return the user to it
 *     after a successful sign-in.
 *
 *   - `bootstrapped && user && personalStudio === null` — authenticated
 *     but onboarding is incomplete (the account exists, but the slug
 *     step that creates the personal studio has not run). Bounce to the
 *     onboarding slug page. This is the single gate that catches both
 *     a half-finished email registration and (in future) a fresh OAuth
 *     account, no matter which protected URL they land on. Skipped when
 *     `requirePersonalStudio` is `false` (the onboarding page itself).
 *
 *   - `bootstrapped && user && personalStudio !== null` — fully
 *     onboarded. Render children.
 *
 * Use at the route-table level (`routes.tsx`), wrapping any page that
 * depends on `useCurrentUserStore.user` being non-null — Studio,
 * Project, and any future authenticated surfaces.
 * @param root0 - The component props.
 * @param root0.children - The protected page to render once the user is authenticated.
 * @param root0.requirePersonalStudio - Whether to also require a completed personal studio (default `true`).
 * @returns A loading shell while bootstrapping, a redirect to `/login` when
 *   unauthenticated, a redirect to onboarding when the personal studio is
 *   missing, or the `children` page when fully onboarded.
 */
export default function ProtectedRoute({
  children,
  requirePersonalStudio = true,
}: ProtectedRouteProps): React.ReactElement {
  const user = useCurrentUserStore((s) => s.user);
  const bootstrapped = useCurrentUserStore((s) => s.bootstrapped);
  const location = useLocation();

  if (!bootstrapped) {
    return <LoadingScreen />;
  }

  if (!user) {
    // The login page navigates to `?next=` after sign-in. The search string
    // matters as much as the path: the decision links from every notification
    // email live behind this guard as `/decision?token=...`, and dropping the
    // token would strand the recipient on /studio with no way back to the
    // thing they clicked. (The old `state.from` had no consumer at all.)
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  if (requirePersonalStudio && user.personalStudio === null) {
    return <Navigate to={CHOOSE_SLUG_PATH} replace />;
  }

  return <>{children}</>;
}
