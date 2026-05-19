import { createBrowserRouter, Navigate } from 'react-router-dom';

import StudioPage from '@/pages/studio/StudioPage';
import ProjectPage from '@/pages/project/ProjectPage';
import LoginPage from '@/pages/auth/LoginPage';
import ResetPasswordPage from '@/pages/auth/ResetPasswordPage';

/**
 * Top-level route table.
 *
 * `/`                      → redirect to /studio
 * `/studio`                → StudioPage (project list + nav)
 * `/project/:projectId`    → ProjectPage (canvas + chat)
 * `/project/:projectId/space/:spaceId?` → ProjectPage (space-scoped deep link)
 * `/login` `/reset-password` → auth flows
 *
 * Use `createBrowserRouter` over the legacy `<BrowserRouter><Routes>`
 * pattern: data router lets future PRs add loaders / actions without
 * rewriting the tree.
 */
export const router = createBrowserRouter([
  { path: '/', element: <Navigate to='/studio' replace /> },
  { path: '/studio', element: <StudioPage /> },
  { path: '/project/:projectId', element: <ProjectPage /> },
  { path: '/project/:projectId/space/:spaceId', element: <ProjectPage /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  { path: '*', element: <Navigate to='/studio' replace /> },
]);
