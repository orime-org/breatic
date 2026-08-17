// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { MembershipTier, PersonalStudioRef } from '@breatic/shared';

import { apiGet, apiPost } from '@web/data/api/request';

/**
 * Server `/auth/*` response user shape — mirrors shared
 * `UserEntity` (packages/shared/src/types/entities.ts). `users` no
 * longer carries any identity field (the `username` column was
 * removed); the display name, web handle and avatar live on the user's
 * `personalStudio`, which is `null` until onboarding picks a slug.
 * Always go through `deriveDisplayName` below when projecting into UI
 * state so a null personal studio gets a graceful email-local-part
 * fallback.
 *
 * The studio ref itself is `PersonalStudioRef` from `@breatic/shared`,
 * the same type the server builds its responses from. This file used to
 * declare a second copy of that shape; two declarations of one wire
 * contract drift the moment a field is added to only one of them, which
 * is exactly what #1882 had to add (`avatarUrl`).
 */
export interface AuthUser {
  id: string;
  email: string;
  personalStudio: PersonalStudioRef | null;
  credits: number;
  /**
   * Which membership tier the account is on.
   *
   * It rides along with the session rather than being fetched: the avatar
   * menu names the tier and renders in every studio's top bar, and the tier
   * is a fixed property of the account. What that tier grants — the ceilings
   * and the usage against them — is a separate read, behind the membership
   * panel that shows it.
   */
  membershipTier: MembershipTier;
}

/**
 * Resolve a non-empty display name from a user's personal-studio name
 * and email. Prefers the personal-studio name, otherwise falls back to
 * the local-part of the email (`'justin@example.com'` → `'justin'`).
 * Used by AuthBootstrap / LoginPage / RegisterPage when populating
 * `useCurrentUserStore.user.name` — single source of truth so the
 * three callsites can't drift.
 * @param u - The display-name inputs to derive from.
 * @param u.personalStudioName - The personal studio's display name; `null` before onboarding.
 * @param u.email - Email address, used for the local-part fallback.
 * @returns A non-empty display name: the personal-studio name, else the email local-part, else the full email.
 */
export function deriveDisplayName(u: {
  personalStudioName: string | null;
  email: string;
}): string {
  if (u.personalStudioName && u.personalStudioName.trim().length > 0) {
    return u.personalStudioName;
  }
  const localPart = u.email.split('@')[0];
  return localPart && localPart.length > 0 ? localPart : u.email;
}

/**
 * Register / login responses no longer return a `token` field —
 * the server sets an httpOnly session cookie on the
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

/**
 * `POST /auth/setup-studio` response — the personal studio created by
 * the onboarding slug step. Returned so the caller can populate the
 * current-user store's `personalStudio` (lifting the onboarding gate)
 * without a follow-up `/auth/me` round-trip.
 */
interface SetupStudioResponse {
  personalStudio: PersonalStudioRef;
}

interface ResetWithRecoveryCodeResponse {
  /** A fresh recovery code that replaces the consumed one — must be saved. */
  newRecoveryCode: string;
}

export const authApi = {
  register(body: { email: string; password: string }) {
    return apiPost<RegisterResponse>('/auth/register', body);
  },
  setupStudio(body: { slug: string }) {
    return apiPost<SetupStudioResponse>('/auth/setup-studio', body);
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
