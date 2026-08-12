// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { Coins, LogOut, Settings, Sparkles } from 'lucide-react';

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
import { useTranslation } from '@web/i18n/use-translation';
import { studioTabPath } from '@web/pages/studio/container/studio-tabs';
import { useCurrentUserStore } from '@web/stores/current-user';
import { StudioAvatar } from '@web/ui/StudioAvatar';

/** An entry that names a feature not built yet. */
interface ComingEntryProps {
  /** The entry's label. */
  label: string;
  /** The muted note saying it is not available. */
  note: string;
  /** The entry's icon. */
  icon: React.ReactNode;
}

/**
 * An entry for something that will live here and does not exist yet.
 *
 * It is deliberately NOT given the `disabled` prop. Radix takes a disabled
 * item out of the menu's roving focus (`react-menu`'s item is built with
 * `focusable: !disabled`), and HTML's `disabled` attribute does the same to
 * the tab order — either way the entry stops being reachable by moving focus.
 * These entries exist to be FOUND: showing them is how a reader learns the
 * feature is coming, and the audience most reliant on that is the one that
 * navigates by focus. W3C's ARIA practices name this exact case — when a
 * disabled element needs to stay discoverable, `aria-disabled` is applied so
 * that it remains focusable.
 *
 * `onSelect` is prevented rather than omitted: Radix closes the menu after a
 * select, and a menu that shuts on the press would read as though something
 * happened. Nothing did.
 *
 * VISUALLY it follows what every other unavailable thing in this product does:
 * dim the whole element at once, and let the tokens inside keep their own
 * order. The disabled sort button in the container toolbar dims "Sort" and
 * its value together, and "Sort" stays the quieter of the two; the unavailable
 * Timeline card in the space-kind picker dims its icon, title, subtitle and
 * "not available" badge together. The note here is that badge, borrowed
 * class-for-class — the muted fill behind it is what keeps it readable once
 * the whole entry is at half strength.
 *
 * The one place this departs is WHERE the dimming hangs, and it has to. Radix
 * expresses the highlight as a background on the row, and `opacity` composites
 * an element against its backdrop with its own background included — so
 * dimming the ROW dims its highlight too, leaving a step of five levels out of
 * 255. The entry would be reachable and invisible: exactly the outcome the
 * `disabled` attribute was rejected for. Dimming all of the content instead
 * covers the same pixels and leaves the row free to take the highlight at full
 * strength.
 *
 * That highlight is then narrowed to the KEYBOARD. Radix focuses an
 * undisabled item on pointer-move, so the shared `focus:bg-accent` would light
 * this row exactly like the two that can be clicked — an affordance for
 * something that does not respond. Every other disabled control here simply
 * has no hover class; this one has to cancel an inherited one, which is what
 * `focus:bg-transparent` does, with `focus-visible:bg-accent` putting it back
 * for the case that matters. (`cn` cannot drop the inherited rule: twMerge
 * treats different modifiers as different properties — see `rail-row.ts` for
 * the same trap.)
 * @param props - The entry's label, note and icon.
 * @param props.label - The entry's label.
 * @param props.note - The muted note saying it is not available.
 * @param props.icon - The entry's icon.
 * @returns The menu entry.
 */
function ComingEntry({
  label,
  note,
  icon,
}: ComingEntryProps): React.JSX.Element {
  return (
    <DropdownMenuItem
      aria-disabled='true'
      onSelect={(event) => event.preventDefault()}
      className='cursor-not-allowed focus:bg-transparent focus-visible:bg-accent'
    >
      <span className='flex flex-1 items-center gap-2 opacity-50'>
        {icon}
        {label}
        <span className='ml-auto rounded-chrome bg-muted px-1 py-0.5 text-2xs font-medium text-muted-foreground'>
          {note}
        </span>
      </span>
    </DropdownMenuItem>
  );
}

/**
 * Studio account menu — the current-user avatar in the studio top bar, opening
 * the account's own entries: who is signed in, credits, membership, account
 * settings, and sign out.
 *
 * A menu rather than a popover. Every entry here either navigates or acts, and
 * Radix's menu closes itself on select; a popover does not, and this one is
 * mounted by the layout route, so navigating swaps the content underneath it
 * and leaves it sitting open over the page it just opened. It is also what the
 * rest of the app's action menus use.
 *
 * Credits and membership are shown before either feature exists, so that the
 * shape of the account is visible and nothing has to be added to the menu
 * later — see {@link ComingEntry} for why they are not `disabled`.
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

  return (
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
        className='w-60'
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
        <ComingEntry
          label={t('studio.topBar.credits')}
          note={t('studio.topBar.notOpenYet')}
          icon={<Coins className='h-4 w-4' />}
        />
        <ComingEntry
          label={t('studio.topBar.membership')}
          note={t('studio.topBar.notOpenYet')}
          icon={<Sparkles className='h-4 w-4' />}
        />
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
  );
}
