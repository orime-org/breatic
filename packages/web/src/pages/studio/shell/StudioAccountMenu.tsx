// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { LogOut } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { authApi } from '@web/data/api/auth';
import { useTranslation } from '@web/i18n/use-translation';
import { useCurrentUserStore } from '@web/stores/current-user';

/**
 * Studio account menu — the current-user avatar in the studio top bar, opening a
 * popover with account actions. For now the only action is sign-out, which calls
 * the logout API then clears the user store; `ProtectedRoute` then redirects to
 * `/login` (no manual navigation needed). The avatar shows the user's initial,
 * or their avatar image when set.
 * @returns the avatar button + account popover.
 */
export function StudioAccountMenu(): React.JSX.Element {
  const t = useTranslation();
  const user = useCurrentUserStore((s) => s.user);
  const clear = useCurrentUserStore((s) => s.clear);
  const initial = user?.name.slice(0, 1).toUpperCase() ?? '?';

  /**
   * Sign out: invalidate the server session, then clear the local user so
   * `ProtectedRoute` redirects to `/login`. A failed logout still clears locally
   * — the user asked to leave, and a stale server session is recreated on next
   * login.
   * @returns a promise that resolves once the local session is cleared.
   */
  const handleSignOut = async (): Promise<void> => {
    try {
      await authApi.logout();
    } catch {
      // Logout API failed; still clear the local session below (user intent =
      // leave). A stale server session, if any, is replaced on next login.
    } finally {
      clear();
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label={t('studio.topBar.account')}
          className='ml-1 flex h-7 w-7 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-bold text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        >
          {user?.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt=''
              className='h-full w-full object-cover'
            />
          ) : (
            initial
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-48 p-1'
        data-testid='account-popover'
      >
        <Button
          variant='ghost'
          size='menu-item'
          className='w-full justify-start'
          onClick={handleSignOut}
        >
          <LogOut className='h-4 w-4' />
          {t('studio.topBar.signOut')}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
