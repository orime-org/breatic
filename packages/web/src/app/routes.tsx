import React, { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import Loading from '@/app/shell/loading/Loading';

const Project = lazy(() => import('@/pages/project/Page'));
const Workspace = lazy(() => import('@/pages/studio/Page'));
const LoginPage = lazy(() => import('@/pages/auth/LoginPage'));
const ResetPasswordPage = lazy(() => import('@/pages/auth/ResetPasswordPage'));

const router = createBrowserRouter([
  {
    path: '/',
    element: <Navigate to='/workspace' replace />,
  },
  {
    path: '/workspace',
    element: (
      <Suspense fallback={<Loading />}>
        <Workspace />
      </Suspense>
    ),
  },
  {
    path: '/project/:projectId',
    element: (
      <Suspense fallback={<Loading />}>
        <Project />
      </Suspense>
    ),
  },
  {
    path: '/login',
    element: (
      <Suspense fallback={<Loading />}>
        <LoginPage />
      </Suspense>
    ),
  },
  {
    path: '/reset-password',
    element: (
      <Suspense fallback={<Loading />}>
        <ResetPasswordPage />
      </Suspense>
    ),
  },
  {
    path: '*',
    element: <Navigate to='/workspace' replace />,
  },
]);

export default router;
