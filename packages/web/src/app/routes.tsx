// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom';

import ProtectedRoute from '@web/app/ProtectedRoute';
import StudioLayout from '@web/pages/studio/shell/StudioLayout';
import StudioRecentPage from '@web/pages/studio/StudioRecentPage';
import StudioContainerPage from '@web/pages/studio/container/StudioContainerPage';
import ProjectPage from '@web/pages/project/ProjectPage';
import NoAccessPage from '@web/pages/project/access/NoAccessPage';
import InviteConsumePage from '@web/pages/invite/InviteConsumePage';
import LoginPage from '@web/pages/auth/LoginPage';
import RegisterPage from '@web/pages/auth/RegisterPage';
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
 * `/studio/:slug`          → StudioContainerPage (per-studio 5-tab)     [AUTH]
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
 * `/choose-handle`          → SlugSetupPage (step two of registration —  [AUTH,
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
    // without permission shows a "contact the owner" page. The old
    // "request to join" flow was cut; link consume is now the only
    // way in, and ProjectPage redirects here on 403.
    path: '/project/:projectId/access',
    element: (
      <ProtectedRoute>
        <NoAccessPage />
      </ProtectedRoute>
    ),
  },
  {
    // Invite link consume landing (PR-d paths 2/3). Runs
    // inviteLinksApi.consume + navigates to the project on success
    // or to /studio fallback on failure.
    path: '/invite/:token',
    element: (
      <ProtectedRoute>
        <InviteConsumePage />
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
    path: '/choose-handle',
    element: (
      <ProtectedRoute requirePersonalStudio={false}>
        <SlugSetupPage />
      </ProtectedRoute>
    ),
  },
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
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
