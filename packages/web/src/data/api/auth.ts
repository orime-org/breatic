// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { apiGet, apiPost } from '@web/data/api/request';

/**
 * Server `/auth/*` response user shape — mirrors shared
 * `UserEntity` (packages/shared/src/types/entities.ts). The display
 * name lives on `username` (nullable in PG), NOT `name`. Earlier
 * versions of this type declared `name: string` which silently
 * mis-mapped the server payload, making `currentUser.name` undefined
 * everywhere and breaking awareness → `meta.users` → bell sheet
 * actor rendering (rows fell back to raw UUID). Always go through
 * `deriveDisplayName` below when projecting into UI state so a null
 * username gets a graceful email-local-part fallback.
 */
export interface AuthUser {
  id: string;
  email: string;
  username: string | null;
  credits: number;
}

/**
 * Resolve a non-empty display name for an `AuthUser`. Prefers the
 * stored `username`, otherwise falls back to the local-part of the
 * email (`'justin@example.com'` → `'justin'`). Used by
 * AuthBootstrap / LoginPage / RegisterPage when populating
 * `useCurrentUserStore.user.name` — single source of truth so the
 * three callsites can't drift.
 * @param u - The authenticated user projection to derive a name from.
 * @param u.username - Stored display name; may be null when never set.
 * @param u.email - Email address, used for the local-part fallback.
 * @returns A non-empty display name: the username, else the email local-part, else the full email.
 */
export function deriveDisplayName(u: {
  username: string | null;
  email: string;
}): string {
  if (u.username && u.username.trim().length > 0) return u.username;
  const localPart = u.email.split('@')[0];
  return localPart && localPart.length > 0 ? localPart : u.email;
}

/**
 * Register / login responses no longer return a `token` field —
 * the server sets an httpOnly `breatic_session` cookie on the
 * response instead (2026-05-26 cookie migration). The frontend
 * never holds the token; subsequent calls authenticate via the
 * cookie automatically (axios `withCredentials: true`).
 */
interface RegisterResponse {
  user: AuthUser;
  /** One-time recovery code — shown ONCE on the registration confirm screen. */
  recoveryCode: string;
}

interface LoginResponse {
  user: AuthUser;
}

interface ResetWithRecoveryCodeResponse {
  /** A fresh recovery code that replaces the consumed one — must be saved. */
  newRecoveryCode: string;
}

export const authApi = {
  register(body: { email: string; password: string; name: string }) {
    return apiPost<RegisterResponse>('/auth/register', body);
  },
  login(body: { email: string; password: string }) {
    return apiPost<LoginResponse>('/auth/login', body);
  },
  google(body: { idToken: string }) {
    return apiPost<LoginResponse>('/auth/google', body);
  },
  me() {
    return apiGet<AuthUser>('/auth/me');
  },
  logout() {
    return apiPost<void>('/auth/logout');
  },
  forgotPassword(body: { email: string }) {
    return apiPost<{ message: string }>('/auth/forgot-password', body);
  },
  resetPasswordWithToken(body: { token: string; password: string }) {
    return apiPost<{ message: string }>('/auth/reset-password', body);
  },
  resetPasswordWithRecoveryCode(body: {
    email: string;
    recoveryCode: string;
    newPassword: string;
  }) {
    return apiPost<ResetWithRecoveryCodeResponse>(
      '/auth/reset-password-with-recovery-code',
      body,
    );
  },
  verifyEmail(body: { token: string }) {
    return apiPost<void>('/auth/verify-email', body);
  },
  resendVerificationEmail() {
    return apiPost<void>('/auth/resend-verification-email');
  },
};
