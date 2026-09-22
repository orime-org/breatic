// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every `import()` that names a page chunk, and nothing else.
 *
 * This module imports nothing statically. That is the whole point: the build
 * writes each page's hashed filename into whichever chunk holds the `import()`
 * that reaches it, so a chunk carrying these specifiers changes its own hash
 * on every release that touches any page. Keeping them alone here confines
 * that churn to one small chunk (see `manualChunks` in vite.config.mts).
 *
 * `routes.tsx` imports this module, so the entry chunk it sits in names this
 * one and is renamed along with it. That leaves a fixed residue on every
 * release that touches any page: 76,122 bytes whose content did not change —
 * the 72,488-byte entry chunk and this 3,634-byte one — re-downloaded by every
 * reader, including one who only opens the login page. An import map is what
 * removes that last step; the repo tracks it as #2207.
 *
 * Measured, editing one line of `CanvasSpace.tsx`: before this split, 32 chunk
 * hashes changed and a returning reader paid 3,418,048 bytes, 1,079,379 of it
 * unchanged content — the 768,251-byte chunk every page downloads was the
 * largest piece. Now 3 chunks change and the same reader pays 1,885,595, of
 * which 1,809,473 is the canvas that really did change.
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
  notFoundPage: () => import('@web/pages/NotFoundPage'),
  verifyEmailPage: () => import('@web/pages/auth/VerifyEmailPage'),
};
