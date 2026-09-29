// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, afterEach } from 'vitest';
import { getLocale } from '@breatic/shared';

import { authApi } from '@web/data/api/auth';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { refreshCurrentUser, useCurrentUserStore } from '@web/stores/current-user';

vi.mock('@web/data/api/auth', async () => {
  const actual = await vi.importActual<typeof import('@web/data/api/auth')>(
    '@web/data/api/auth',
  );
  return { ...actual, authApi: { me: vi.fn() } };
});

describe('refreshCurrentUser', () => {
  afterEach(() => {
    changeLocale('en');
    useCurrentUserStore.getState().clear();
  });

  // The account language is applied at sign-in and on a cold load only. A
  // refresh mid-session (opening the avatar menu, returning from checkout)
  // leaves the language the reader is looking at where it is.
  it('updates the user without moving the interface language', async () => {
    changeLocale('zh-CN');
    useCurrentUserStore.getState().setUser({
      id: 'u1',
      email: 'a@b.com',
      name: 'a',
      personalStudio: null,
      membershipTier: 'base',
    });
    vi.mocked(authApi.me).mockResolvedValueOnce({
      id: 'u1',
      email: 'a@b.com',
      personalStudio: null,
      membershipTier: 'pro',
      locale: 'ja',
    });

    await refreshCurrentUser();

    expect(useCurrentUserStore.getState().user?.membershipTier).toBe('pro');
    expect(getLocale()).toBe('zh-CN');
  });
});
