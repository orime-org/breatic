import React, { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import Loading from '@/components/loading/Loading';

const Project = lazy(() => import('@/apps/project/index'));
const Workspace = lazy(() => import('@/apps/workspace/index'));
const VideoEditor = lazy(() => import('@/apps/videoEditor/index'));
const LoginPage = lazy(() => import('@/apps/auth/LoginPage'));
const ResetPasswordPage = lazy(() => import('@/apps/auth/ResetPasswordPage'));

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
    path: '/video_editor',
    element: (
      <Suspense fallback={<Loading />}>
        <VideoEditor />
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
