// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom';

import ProtectedRoute from '@web/app/ProtectedRoute';
import StudioLayout from '@web/pages/studio/shell/StudioLayout';
import StudioRecentPage from '@web/pages/studio/StudioRecentPage';
import StudioContainerPage from '@web/pages/studio/container/StudioContainerPage';
import ProjectPage from '@web/pages/project/ProjectPage';
import DecisionLandingPage from '@web/pages/decision/DecisionLandingPage';
import NoAccessPage from '@web/pages/project/access/NoAccessPage';
import LoginPage from '@web/pages/auth/LoginPage';
import RegisterPage from '@web/pages/auth/RegisterPage';
import RecoveryCodePage from '@web/pages/auth/RecoveryCodePage';
import SlugSetupPage from '@web/pages/auth/SlugSetupPage';
import ForgotPasswordPage from '@web/pages/auth/ForgotPasswordPage';
import ResetPasswordPage from '@web/pages/auth/ResetPasswordPage';
import VerifyEmailPage from '@web/pages/auth/VerifyEmailPage';
import PrimitivesGallery from '@web/pages/_dev/PrimitivesGallery';

/**
 * Top-level route table.
 *
 * `/`                      → redirect to /studio
 * `/studio`                → StudioPage (cross-studio "Recent" landing) [AUTH]
 * `/studio/:slug`          → StudioContainerPage (per-studio 6-tab)     [AUTH]
 * `/studio/:slug/:tab`     → the same page opened at one of its tabs    [AUTH]
 * `/project/:projectId`    → ProjectPage (canvas + chat)                [AUTH]
 *
 * `[AUTH]` routes are wrapped in `<ProtectedRoute>` which gates render
 * on `useCurrentUserStore.user` being non-null. While the boot
 * `/auth/me` ping is in flight, a loading shell is shown; once the
 * ping resolves with no valid session, the route bounces to `/login`.
 * Without this gate, authenticated pages mount with `user=null` and
 * any code branching on `userId` no-ops (the original Q3/Q4 bug —
 * tab activation, space creation, BellMenu etc. all silently failed
 * on cold reload because the store had not yet been hydrated).
 *
 * Space is a type / template inside a Project, NOT a route segment
 * (per `[[feedback_space_type_vs_route]]` user decision). The active
 * Space tab + open-tab list live in Yjs `meta.perUser[userId]` and
 * sync per-user across machines automatically — no URL state needed.
 * `/choose-slug`            → SlugSetupPage (step two of registration —  [AUTH,
 *                            pick a slug → personal studio). Authenticated  no studio
 *                            but exempt from the personal-studio gate.      gate]
 * `/login` `/reset-password` → auth flows (public, no guard)
 * `/dev/*`                 → dev-only routes, only mounted when
 *                            `import.meta.env.DEV` is true. Used for token
 *                            verify + visual QA, not part of the production
 *                            user surface.
 *
 * Use `createBrowserRouter` over the legacy `<BrowserRouter><Routes>`
 * pattern: data router lets future PRs add loaders / actions without
 * rewriting the tree.
 */
const baseRoutes: RouteObject[] = [
  { path: '/', element: <Navigate to='/studio' replace /> },
  {
    // The studio layout route (spec §3.1) — the rail + top bar mount ONCE in
    // `StudioLayout` and persist across `/studio` ↔ `/studio/{slug}`; the child
    // renders in the layout's <Outlet/>, so switching studio swaps only the
    // center content and the rail keeps its mount / selection / collapse state
    // (invariant #3 — switching studio keeps the rail state). Wrapped in
    // ProtectedRoute.
    path: '/studio',
    element: (
      <ProtectedRoute>
        <StudioLayout />
      </ProtectedRoute>
    ),
    children: [
      // `/studio` IS the cross-studio "Recent" view itself (URL design §5.7) —
      // there is no `/studio/recent` URL; Recent is per-user / account-bound.
      { index: true, element: <StudioRecentPage /> },
      // `/studio/{slug}` — a specific studio's container (spec §6): member view
      // (tabs) or non-member view, by `myStudioRole`. The slug is the globally-
      // unique studio locator (no id; URL design §5.7).
      { path: ':slug', element: <StudioContainerPage /> },
      // `/studio/{slug}/{tab}` — the same page opened at one of its tabs. A tab
      // holds a different set of things and each set is worth linking to, so it
      // is a path segment and not component state: the address is what a user
      // can send, what a refresh restores, and what Back walks through. The
      // segment is validated against the tab list itself; anything else, and
      // any tab on a studio the viewer is not in, resolves to `/studio/{slug}`.
      { path: ':slug/:tab', element: <StudioContainerPage /> },
    ],
  },
  {
    path: '/project/:projectId',
    element: (
      <ProtectedRoute>
        <ProjectPage />
      </ProtectedRoute>
    ),
  },
  {
    // NOT_MEMBER landing — 2026-05-28 spec § 2.1: direct project URL
    // without permission shows a "contact the owner" page. Joining a
    // project goes through the invite-confirm handshake (the owner sends a
    // pending invite from ShareDialog); ProjectPage redirects here on 403.
    path: '/project/:projectId/access',
    element: (
      <ProtectedRoute>
        <NoAccessPage />
      </ProtectedRoute>
    ),
  },
  {
    // The one landing page every waiting request is answered on —
    // `/decision?token=xxx`. It replaced `/studio-invite` and
    // `/project-invite`, which were the same page twice and only ever served
    // two of the five flows; the other three had no link you could answer from
    // at all. ProtectedRoute because both endpoints are auth-only: the token
    // names a request, it does not stand in for an identity, so an
    // unauthenticated click bounces to /login and returns here after sign-in.
    path: '/decision',
    element: (
      <ProtectedRoute>
        <DecisionLandingPage />
      </ProtectedRoute>
    ),
  },
  {
    // Onboarding step two — pick a slug → server creates the personal
    // studio. Wrapped in ProtectedRoute (the user must be signed in to
    // create their studio) but with `requirePersonalStudio={false}`: this
    // is the one authenticated page exempt from the personal-studio gate,
    // since the user lands here precisely because they have no studio yet.
    // Gating it would redirect it to itself forever.
    path: '/choose-slug',
    element: (
      <ProtectedRoute requirePersonalStudio={false}>
        <SlugSetupPage />
      </ProtectedRoute>
    ),
  },
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  // Recovery-code reveal — a post-register / post-reset auth screen reached
  // only via navigation state (the one-time code is never in the URL); a
  // direct visit bounces to /login.
  { path: '/recovery-code', element: <RecoveryCodePage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  { path: '/verify-email', element: <VerifyEmailPage /> },
];

const devRoutes: RouteObject[] = import.meta.env.DEV
  ? [{ path: '/dev/primitives', element: <PrimitivesGallery /> }]
  : [];

export const router = createBrowserRouter([
  ...baseRoutes,
  ...devRoutes,
  { path: '*', element: <Navigate to='/studio' replace /> },
]);
