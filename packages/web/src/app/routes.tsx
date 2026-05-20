import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom';

import StudioPage from '@/pages/studio/StudioPage';
import ProjectPage from '@/pages/project/ProjectPage';
import LoginPage from '@/pages/auth/LoginPage';
import ResetPasswordPage from '@/pages/auth/ResetPasswordPage';
import PrimitivesGallery from '@/pages/_dev/PrimitivesGallery';

/**
 * Top-level route table.
 *
 * `/`                      → redirect to /studio
 * `/studio`                → StudioPage (project list + nav)
 * `/project/:projectId`    → ProjectPage (canvas + chat)
 * `/project/:projectId/space/:spaceId?` → ProjectPage (space-scoped deep link)
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
  { path: '/project/:projectId/space/:spaceId', element: <ProjectPage /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
];

const devRoutes: RouteObject[] = import.meta.env.DEV
  ? [{ path: '/dev/primitives', element: <PrimitivesGallery /> }]
  : [];

export const router = createBrowserRouter([
  ...baseRoutes,
  ...devRoutes,
  { path: '*', element: <Navigate to='/studio' replace /> },
]);
