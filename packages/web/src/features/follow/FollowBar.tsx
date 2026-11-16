// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { SpaceType } from '@breatic/shared';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { userPaletteColor } from '@web/lib/user-color';
import { stopFollowing, useFollowStore } from '@web/stores/follow';

/** The bar's height in pixels (`h-8`); a followed canvas view is aligned below it, so it stays visible. */
export const FOLLOW_BAR_HEIGHT = 32;

/**
 * Whether the bar lies over a Space of this type. The user pans Canvas and 3D
 * freely, so nothing is lost under the bar; any other Space would hide its top
 * lines under it, so there the bar takes its own row and the Space moves down.
 */
const BAR_OVER_SPACE: Record<SpaceType, boolean> = { canvas: true, '3d': true, document: false, timeline: false };

/**
 * The "Following X · Stop" bar at the top of the Space area, and the outline
 * around that area in the leader's colour, while this user follows a member
 * (#920). Renders nothing otherwise. Its parent is the positioned flex column
 * that hosts the open Space bodies below it.
 * @param props - The bar's input.
 * @param props.spaceType - The type of the Space on screen; null when none is open.
 * @returns The bar and outline, or null while not following.
 */
export function FollowBar({ spaceType }: { spaceType: SpaceType | null }): React.JSX.Element | null {
  const t = useTranslation();
  const leaderId = useFollowStore((s) => s.targetUserId);
  const leaderName = useFollowStore((s) => s.targetName);
  const stop = React.useCallback((): void => stopFollowing('button'), []);
  if (leaderId === null || leaderName === null) return null;
  const leaderColor = userPaletteColor(leaderId);
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
        className={`${spaceType !== null && BAR_OVER_SPACE[spaceType] ? 'absolute inset-x-0 top-0' : 'relative shrink-0'} z-20 flex h-8 items-center justify-center gap-2 text-xs text-[color:var(--color-on-palette)]`}
        style={{ background: leaderColor }}
      >
        <span className='truncate font-semibold'>{t('members.follow.bar', { name: leaderName })}</span>
        <Button
          variant={null}
          size='compact'
          data-testid='follow-bar-stop'
          // Toward the theme foreground, away from the on-palette text: at least
          // 4.5:1 for every collaborator colour in both themes.
          className='rounded-chrome bg-[color-mix(in_srgb,var(--color-foreground)_20%,transparent)] text-xs hover-enabled:bg-[color-mix(in_srgb,var(--color-foreground)_30%,transparent)]'
          onClick={stop}
        >
          {t('members.follow.stop')}
        </Button>
      </div>
    </>
  );
}
