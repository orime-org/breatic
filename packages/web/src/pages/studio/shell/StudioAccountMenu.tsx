// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { LogOut, Settings, Sparkles, Star } from 'lucide-react';
import { getLocale } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { authApi } from '@web/data/api/auth';
import { CheckoutWaitOverlay } from '@web/features/credits/CheckoutWaitOverlay';
import { CreditsOverlay } from '@web/features/credits/CreditsOverlay';
import { useCheckoutReturn } from '@web/features/credits/use-checkout-return';
import { paymentApi } from '@web/data/api/payment';
import { MembershipPanel } from '@web/features/membership/MembershipPanel';
import { useTranslation } from '@web/i18n/use-translation';
import { studioTabPath } from '@web/pages/studio/container/studio-tabs';
import { useCurrentUserStore } from '@web/stores/current-user';
import { StudioAvatar } from '@web/ui/StudioAvatar';

/**
 * The backstop for a wait the server never named.
 *
 * The configured value arrives with the pack list, and the wait is re-armed
 * with it the moment it does. This is what governs the wait while that list
 * has not answered, and what it settles on if it never does — a minute, long
 * enough that a slow answer still gets to replace it. A copy of the
 * configured number here would drift the day somebody changed the file.
 */
const CONFIRM_WAIT_BACKSTOP_MS = 60_000;

/**
 * Studio account menu — the current-user avatar in the studio top bar, opening
 * the account's own entries: who is signed in, credits, membership, account
 * settings, and sign out.
 *
 * A menu rather than a popover. Every entry here either navigates or acts, and
 * Radix's menu closes itself on select; a popover does not, and this one is
 * mounted by the layout route, so navigating swaps the content underneath it
 * and leaves it sitting open over the page it just opened. It is also what the
 * canvas's own menus use — its context menu, node menu, edge menu and
 * floating menu are all `DropdownMenu`. Two menus are still on `Popover`
 * (`MemberRowMenu` and `BellMenu`) and predate this.
 *
 * Credits and membership each open a panel rather than navigating, because
 * both are things a person looks up rather than places they go.
 *
 * Account settings goes to the personal studio's Settings tab: a personal
 * studio's avatar and slug ARE the account's, so a second settings page would
 * hold the same two fields.
 * @returns the avatar button + account menu.
 */
export function StudioAccountMenu(): React.JSX.Element {
  const t = useTranslation();
  const navigate = useNavigate();
  const user = useCurrentUserStore((s) => s.user);
  const clear = useCurrentUserStore((s) => s.clear);
  const personalStudio = user?.personalStudio ?? null;
  const [membershipOpen, setMembershipOpen] = React.useState(false);
  const [creditsOpen, setCreditsOpen] = React.useState(false);

  // How long the return page may wait comes from the server, on the list the
  // buy screen reads anyway. Until it arrives there is nothing to wait for.
  const packs = useQuery({
    // The refund rule comes back in the reader's language, so the language is
    // part of what was asked for. Left out of the key, switching language
    // leaves that block in the previous one until the answer goes stale.
    queryKey: ['payment', 'tiers', getLocale()],
    queryFn: () => paymentApi.tiers(),
    staleTime: 5 * 60 * 1000,
  });
  const back = useCheckoutReturn({
    confirmTimeoutMs: packs.data?.confirmTimeoutMs ?? CONFIRM_WAIT_BACKSTOP_MS,
  });
  // Taken out of the object it arrives in: the hook returns a fresh one every
  // render, so a callback depending on the whole thing is rebuilt every time.
  const { close: closeReturn } = back;

  // Two things open this overlay — the menu entry and coming back from a
  // payment — and closing it has to put both down, or it reopens on the next
  // render from whichever is still set.
  const closeCredits = React.useCallback(
    (next: boolean) => {
      setCreditsOpen(next);
      if (!next) closeReturn();
    },
    [closeReturn],
  );

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

  /**
   * Open the account's own settings — the personal studio's Settings tab.
   *
   * Nothing happens while the personal studio is absent, which is the state an
   * account is in between registering and picking a handle. That account is
   * held on the onboarding page by `ProtectedRoute` and cannot reach this menu,
   * so the guard is about not constructing `/studio/undefined/settings` rather
   * than about a path a user can walk.
   */
  const handleAccountSettings = (): void => {
    if (personalStudio === null) return;
    navigate(studioTabPath(personalStudio.slug, 'settings'));
  };

  /**
   * Open the credits overlay over whatever page is showing.
   *
   * It does not navigate, for the reason the membership panel does not:
   * somebody checking their balance is looking something up, and what they
   * were doing is still underneath when they close it.
   */
  const handleCredits = (): void => {
    setCreditsOpen(true);
  };

  /**
   * Open the membership panel over whatever page is showing.
   *
   * It does not navigate: a person checking their tier is looking something
   * up, not going somewhere, and what they were doing stays underneath.
   */
  const handleMembership = (): void => {
    setMembershipOpen(true);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type='button'
            aria-label={t('studio.topBar.account')}
            variant={null}
            size={null}
            // Hover dims rather than tinting the background: with an avatar set
            // the background is covered by the image, so a background hover is
            // invisible. Opacity also leaves the element's box untouched — this
            // button is the menu's anchor, and anything that resizes it
            // (a scale, a border) makes the menu jump on hover.
            className='ml-1 flex shrink-0 items-center justify-center rounded-full transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
          >
            <StudioAvatar
              name={user?.name ?? '?'}
              // The signed-in user is shown through their personal studio —
              // display identity lives there, not on the user row.
              type='personal'
              avatarUrl={user?.avatarUrl ?? null}
              size='sm'
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align='end'
          // 8, not the primitive's 6: the language and theme popovers sitting
          // beside this one hang 8 below the bar, and three controls on one
          // row at two different distances reads as a mistake.
          sideOffset={8}
          // The rows carry their own highlight, so with nothing between them
          // two adjacent highlights touch and read as one block. The language
          // popover spaces its rows the same way.
          className='flex w-60 flex-col gap-0.5'
          data-testid='account-menu'
        >
          <DropdownMenuLabel className='flex items-center gap-2'>
            <StudioAvatar
              name={user?.name ?? '?'}
              type='personal'
              avatarUrl={user?.avatarUrl ?? null}
              size='sm'
              data-testid='account-menu-avatar'
            />
            <span className='flex min-w-0 flex-col gap-0.5'>
              {/* `text-foreground` explicitly: DropdownMenuLabel sets
                `text-muted-foreground` on the whole block, so a name that only
                overrides size and weight inherits it — and then the handle's
                own muted class says nothing, because both halves paint the
                same grey. Whose account this is should be the loudest thing in
                the header, not the quietest. */}
              <span className='truncate text-sm font-medium text-foreground'>
                {user?.name}
              </span>
              {personalStudio === null ? null : (
              // The handle is how other people find this account, so it is
              // worth being able to read off without going anywhere.
                <span className='truncate text-xs font-normal text-muted-foreground'>
                @{personalStudio.slug}
                </span>
              )}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleCredits}>
            <Star className='h-4 w-4' />
            {t('studio.topBar.credits')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleMembership}>
            <Sparkles className='h-4 w-4' />
            {t('studio.topBar.membership')}
            {/* The tier itself, not just the word: this entry is where a person
              checks which one they are on, and reading it off the menu saves
              the trip. */}
            <span className='ml-auto text-xs font-medium text-muted-foreground'>
              {user === null ? null : t(`membership.tier.${user.membershipTier}`)}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAccountSettings}>
            <Settings className='h-4 w-4' />
            {t('studio.topBar.accountSettings')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleSignOut}>
            <LogOut className='h-4 w-4' />
            {t('studio.topBar.signOut')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <MembershipPanel open={membershipOpen} onOpenChange={setMembershipOpen} />
      <CheckoutWaitOverlay open={back.waiting} />
      <CreditsOverlay
        open={creditsOpen || back.overlayOpen}
        onOpenChange={closeCredits}
        initialSection={back.initialSection}
      />
    </>
  );
}
