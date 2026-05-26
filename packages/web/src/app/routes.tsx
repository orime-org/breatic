import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom';

import StudioPage from '@/pages/studio/StudioPage';
import ProjectPage from '@/pages/project/ProjectPage';
import LoginPage from '@/pages/auth/LoginPage';
import RegisterPage from '@/pages/auth/RegisterPage';
import ForgotPasswordPage from '@/pages/auth/ForgotPasswordPage';
import ResetPasswordPage from '@/pages/auth/ResetPasswordPage';
import VerifyEmailPage from '@/pages/auth/VerifyEmailPage';
import PrimitivesGallery from '@/pages/_dev/PrimitivesGallery';

/**
 * Top-level route table.
 *
 * `/`                      → redirect to /studio
 * `/studio`                → StudioPage (project list + nav)
 * `/project/:projectId`    → ProjectPage (canvas + chat)
 *
 * Space is a type / template inside a Project, NOT a route segment
 * (per `[[feedback_space_type_vs_route]]` user decision). The active
 * Space tab + open-tab list live in Yjs `meta.perUser[userId]` and
 * sync per-user across machines automatically — no URL state needed.
 * `/login` `/reset-password` → auth flows
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
  { path: '/studio', element: <StudioPage /> },
  { path: '/project/:projectId', element: <ProjectPage /> },
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
