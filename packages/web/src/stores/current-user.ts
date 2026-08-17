// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import type { MembershipTier, PersonalStudioRef } from '@breatic/shared';

import { deriveDisplayName, type AuthUser } from '@web/data/api/auth';

/**
 * Current user store — auth identity + role + boot/loading flags.
 *
 * Session token used to live here as `token` + `setToken`, exposed
 * to JS so axios / SSE / WS could attach it as a Bearer / URL param.
 * Removed 2026-05-26 (cookie migration) — the token is now an
 * httpOnly cookie set by the server and never reachable from JS.
 * Authentication state from the frontend's perspective is now
 * binary: `user` is non-null after a successful `/auth/me` ping
 * (cookie was valid), or null otherwise.
 *
 * `bootstrapped` distinguishes "we haven't pinged `/auth/me` yet"
 * from "we pinged and the user is unauthenticated". ProtectedRoute
 * shows a loading shell while `!bootstrapped` and only redirects
 * to `/login` once the boot ping has completed — otherwise a fresh
 * page load would briefly flash the login page before the cookie
 * check returned.
 */
export type UserRole = 'owner' | 'editor' | 'viewer' | null;

export interface CurrentUser {
  id: string;
  /** Display name, derived via `deriveDisplayName` (personal-studio name → email fallback). */
  name: string;
  email: string;
  avatarUrl?: string;
  /**
   * The user's personal studio (`{ name, slug }`), or `null` when the
   * account has not yet completed onboarding (the slug step that
   * creates it). `ProtectedRoute` reads this null as the onboarding
   * gate — a non-null personal studio is required to enter the app.
   */
  personalStudio: PersonalStudioRef | null;
  /**
   * Which membership tier the account is on.
   *
   * The avatar menu names it, and the membership panel opens from there.
   * It arrives with the session payload, so it is as fresh as the last
   * `/auth/me` — a tier changed elsewhere reaches this tab on the next boot
   * (#110 makes that immediate, and belongs with the upgrade flow that can
   * change it).
   */
  membershipTier: MembershipTier;
}

/**
 * Project an `/auth/*` response user onto the store shape.
 *
 * Every writer that populates the store from a server response goes through
 * here — boot, login, register. Before #1882 each one hand-built the object
 * and they disagreed: none of them carried the avatar at all, so the only
 * code that ever set it was the studio-settings save handler and a reload
 * dropped it. One projection means adding a field is one edit, not four.
 * @param u - The user as returned by `/auth/me`, `/auth/login` or `/auth/register`.
 * @returns The store shape, with the display name and avatar resolved from the personal studio.
 */
export function toCurrentUser(u: AuthUser): CurrentUser {
  return {
    id: u.id,
    name: deriveDisplayName({
      personalStudioName: u.personalStudio?.name ?? null,
      email: u.email,
    }),
    email: u.email,
    // `?? undefined` and not `?? ''`: StudioAvatar picks between the image and
    // the initials fallback on this value, and an empty string reads as a
    // present-but-broken source.
    avatarUrl: u.personalStudio?.avatarUrl ?? undefined,
    personalStudio: u.personalStudio,
    membershipTier: u.membershipTier,
  };
}

/**
 * Re-derive the identity fields of an already-populated store user from a
 * personal studio that just changed.
 *
 * Used where the studio itself is the news rather than the user: finishing
 * onboarding (the slug step creates the studio) and saving personal-studio
 * settings (a rename or a new avatar). Display name and avatar both follow
 * the studio, so they are re-derived together — updating one without the
 * other is how they drifted apart in the first place.
 * @param user - The current store user.
 * @param ref - The personal studio as it now stands.
 * @returns A new store user carrying the studio's name and avatar.
 */
export function applyPersonalStudio(
  user: CurrentUser,
  ref: PersonalStudioRef,
): CurrentUser {
  return {
    ...user,
    name: deriveDisplayName({ personalStudioName: ref.name, email: user.email }),
    avatarUrl: ref.avatarUrl ?? undefined,
    personalStudio: ref,
  };
}

interface CurrentUserState {
  user: CurrentUser | null;
  role: UserRole;
  loading: boolean;
  bootstrapped: boolean;
  setUser: (user: CurrentUser | null) => void;
  setRole: (role: UserRole) => void;
  setLoading: (loading: boolean) => void;
  setBootstrapped: (bootstrapped: boolean) => void;
  clear: () => void;
}

export const useCurrentUserStore = create<CurrentUserState>()(
  immer((set) => ({
    user: null,
    role: null,
    loading: false,
    bootstrapped: false,
    setUser: (user) =>
      set((s) => {
        s.user = user;
      }),
    setRole: (role) =>
      set((s) => {
        s.role = role;
      }),
    setLoading: (loading) =>
      set((s) => {
        s.loading = loading;
      }),
    setBootstrapped: (bootstrapped) =>
      set((s) => {
        s.bootstrapped = bootstrapped;
      }),
    clear: () =>
      set((s) => {
        s.user = null;
        s.role = null;
        s.loading = false;
        // bootstrapped intentionally preserved — see store docstring.
      }),
  })),
);
