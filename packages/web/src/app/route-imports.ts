// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every `import()` that names a page chunk, and nothing else.
 *
 * This module imports nothing statically. That is the whole point: the build
 * writes each page's hashed filename into whichever chunk holds the `import()`
 * that reaches it, so a chunk carrying these specifiers changes its own hash
 * on every release that touches any page. Keeping them alone here confines
 * that churn to one small chunk (see `manualChunks` in vite.config.mts);
 * `routes.tsx` and the shared code it sits with stay byte-identical when an
 * unrelated page changes.
 *
 * Measured before this split: editing one line of `CanvasSpace.tsx` changed 32
 * chunk hashes and cost a returning reader 3,418,048 bytes, of which 1,079,379
 * was unchanged content — the 768,251-byte chunk every page downloads was the
 * largest piece.
 */
export const routeImports = {
  studioLayout: () => import('@web/pages/studio/shell/StudioLayout'),
  studioRecentPage: () => import('@web/pages/studio/StudioRecentPage'),
  studioContainerPage: () => import('@web/pages/studio/container/StudioContainerPage'),
  projectPage: () => import('@web/pages/project/ProjectPage'),
  decisionLandingPage: () => import('@web/pages/decision/DecisionLandingPage'),
  noAccessPage: () => import('@web/pages/project/access/NoAccessPage'),
  loginPage: () => import('@web/pages/auth/LoginPage'),
  registerPage: () => import('@web/pages/auth/RegisterPage'),
  recoveryCodePage: () => import('@web/pages/auth/RecoveryCodePage'),
  slugSetupPage: () => import('@web/pages/auth/SlugSetupPage'),
  forgotPasswordPage: () => import('@web/pages/auth/ForgotPasswordPage'),
  resetPasswordPage: () => import('@web/pages/auth/ResetPasswordPage'),
  verifyEmailPage: () => import('@web/pages/auth/VerifyEmailPage'),
};
