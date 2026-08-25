// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';
import type { StudioType } from '@breatic/shared';

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@web/components/ui/avatar';
import { cn } from '@web/lib/utils';

/**
 * The avatar sizes in use, named after the `--avatar-*` scale
 * (20 / 26 / 32 / 40 / 64px).
 */
export type StudioAvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const SIZE_VAR: Readonly<Record<StudioAvatarSize, string>> = {
  xs: 'var(--avatar-xs)',
  sm: 'var(--avatar-sm)',
  md: 'var(--avatar-md)',
  lg: 'var(--avatar-lg)',
  xl: 'var(--avatar-xl)',
};

/**
 * Initials scale with the avatar; the two smallest share the smallest step
 * because there is no token below `2xs` and two characters still fit at 20px.
 */
const SIZE_TEXT: Readonly<Record<StudioAvatarSize, string>> = {
  xs: 'text-2xs',
  sm: 'text-2xs',
  md: 'text-xs',
  lg: 'text-sm',
  xl: 'text-lg',
};

/**
 * Derive the two-character initials shown when there is no avatar.
 *
 * A multi-word name gives the first letter of its first and last word
 * ("Songxiu Lei" → SL), which distinguishes people far better than the first
 * two letters would; a single word gives its first two characters. This is the
 * rule the project member stack already used — kept and moved here rather than
 * replaced, so every site now agrees.
 * @param name - The studio's display name.
 * @returns Two uppercase characters, or `?` when the name is blank.
 */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

interface StudioAvatarProps {
  /** The studio's display name — the initials come from it. */
  name: string;
  /** Decides the shape: personal is round, team is squared. */
  type: StudioType;
  /** The uploaded avatar, or `null` to show initials. */
  avatarUrl: string | null;
  size: StudioAvatarSize;
  /** Extra layout classes (margins, `shrink-0`); shape and colour are fixed. */
  className?: string;
  'data-testid'?: string;
}

/**
 * The studio avatar, used everywhere a studio appears: the account menu, the
 * rail, the container header, the members table, and the project member
 * stack.
 *
 * **Shape follows `studios.type`** — personal studios are round, team studios
 * squared — not where the avatar happens to be rendered. Before this
 * component the same personal studio was drawn round in the account menu and
 * squared in the rail, because each site decided for itself. Type is a real
 * column, so one studio now looks the same everywhere, and a rail listing
 * both kinds reads at a glance as "this row is me, that row is a team". It
 * matches the convention users already know from GitHub (round people,
 * squared organisations).
 *
 * A personal studio IS its owner as far as display identity goes — name and
 * avatar live on the personal studio rather than on `users` — so a member's
 * avatar is just their personal studio's avatar, round like any other
 * personal studio.
 *
 * Initials are always two characters (see `initialsOf`). They used to be one
 * in some places and two in others, which made the same person look like two
 * different people across screens.
 *
 * The radius is applied to the fallback as well as the root: the primitive
 * hardcodes `rounded-full` on that child, so a squared avatar whose fallback
 * kept its own radius shows a circular edge poking out from under the corner.
 * @param props - The studio identity, shape input and size.
 * @param props.name - Display name; the initials derive from it (see `initialsOf`).
 * @param props.type - `personal` (round) or `team` (squared).
 * @param props.avatarUrl - The uploaded image, or `null` for initials.
 * @param props.size - Which step of the `--avatar-*` scale to draw at.
 * @param props.className - Extra layout classes.
 * @param props.'data-testid' - Test hook forwarded to the root element.
 * @returns The avatar.
 */
export function StudioAvatar({
  name,
  type,
  avatarUrl,
  size,
  className,
  'data-testid': testId,
}: StudioAvatarProps): React.JSX.Element {
  const initials = initialsOf(name);
  const radius = type === 'personal' ? 'rounded-full' : 'rounded-chrome';
  const sizeStyle = { width: SIZE_VAR[size], height: SIZE_VAR[size] };

  return (
    <Avatar
      data-testid={testId}
      style={sizeStyle}
      // Radius last so it wins over the primitive's own `rounded-full`, and
      // after `className` so a caller's layout classes cannot change shape.
      className={cn('shrink-0', className, radius)}
    >
      {avatarUrl === null ? null : (
        <AvatarImage src={avatarUrl} alt='' className='object-cover' />
      )}
      <AvatarFallback
        className={cn(
          'bg-muted font-bold text-muted-foreground',
          SIZE_TEXT[size],
          radius,
        )}
      >
        {initials}
      </AvatarFallback>
    </Avatar>
  );
}
