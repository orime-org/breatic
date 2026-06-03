// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom';

import ProtectedRoute from '@web/app/ProtectedRoute';
import StudioPage from '@web/pages/studio/StudioPage';
import ProjectPage from '@web/pages/project/ProjectPage';
import NoAccessPage from '@web/pages/project/access/NoAccessPage';
import InviteConsumePage from '@web/pages/invite/InviteConsumePage';
import LoginPage from '@web/pages/auth/LoginPage';
import RegisterPage from '@web/pages/auth/RegisterPage';
import ForgotPasswordPage from '@web/pages/auth/ForgotPasswordPage';
import ResetPasswordPage from '@web/pages/auth/ResetPasswordPage';
import VerifyEmailPage from '@web/pages/auth/VerifyEmailPage';
import PrimitivesGallery from '@web/pages/_dev/PrimitivesGallery';

/**
 * Top-level route table.
 *
 * `/`                      → redirect to /studio
 * `/studio`                → StudioPage (project list + nav)            [AUTH]
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
    path: '/studio',
    element: (
      <ProtectedRoute>
        <StudioPage />
      </ProtectedRoute>
    ),
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
