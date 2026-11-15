// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { useFollowStore } from '@web/stores/follow';

interface FollowBarProps {
  /** The followed member's display name. */
  leaderName: string;
  /** The followed member's collaboration colour, a CSS colour reference. */
  leaderColor: string;
}

/**
 * The "Following X · Stop" bar floating at the top of the Space area, and the
 * outline around that area in the leader's colour, while this user follows a
 * member (#920). Renders nothing otherwise. Its parent is the positioned
 * element that hosts the open Space bodies.
 * @param root0 - Follow bar props.
 * @param root0.leaderName - The followed member's display name.
 * @param root0.leaderColor - The followed member's collaboration colour.
 * @returns The bar and outline, or null while not following.
 */
export function FollowBar({ leaderName, leaderColor }: FollowBarProps): React.JSX.Element | null {
  const t = useTranslation();
  const following = useFollowStore((s) => s.targetUserId !== null);
  const stop = React.useCallback((): void => useFollowStore.getState().stop('button'), []);
  if (!following) return null;
  return (
    <>
      {/* 2px inset outline in the leader's colour: approved by the maintainer
          for this one place in the #920 design, against the 1px line rule. */}
      <div
        data-testid='follow-outline'
        aria-hidden='true'
        className='pointer-events-none absolute inset-0 z-20'
        style={{ boxShadow: `inset 0 0 0 2px ${leaderColor}` }}
      />
      <div
        data-testid='follow-bar'
        className='absolute inset-x-0 top-0 z-20 flex h-8 items-center justify-center gap-2 text-xs text-[color:var(--color-on-palette)]'
        style={{ background: leaderColor }}
      >
        <span className='truncate'>{t('members.follow.bar', { name: leaderName })}</span>
        <Button
          variant={null}
          size='compact'
          data-testid='follow-bar-stop'
          className='rounded-chrome bg-[color-mix(in_srgb,var(--color-on-palette)_20%,transparent)] text-xs hover-enabled:bg-[color-mix(in_srgb,var(--color-on-palette)_30%,transparent)]'
          onClick={stop}
        >
          {t('members.follow.stop')}
        </Button>
      </div>
    </>
  );
}
