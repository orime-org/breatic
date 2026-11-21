// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AuthUser } from '@web/data/api/auth';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { toCurrentUser, useCurrentUserStore } from '@web/stores/current-user';

/**
 * The last steps of every sign-in: keep the user, switch to their language and
 * go where the sign-in was headed.
 * @returns A function finishing a sign-in for an account and a destination.
 */
export function useCompleteSignIn(): (user: AuthUser, next: string) => void {
  const navigate = useNavigate();
  const setUser = useCurrentUserStore((s) => s.setUser);
  return useCallback(
    (user: AuthUser, next: string): void => {
      setUser(toCurrentUser(user));
      void changeLocale(user.locale);
      navigate(next, { replace: true });
    },
    [navigate, setUser],
  );
}
