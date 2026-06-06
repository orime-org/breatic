// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Link } from 'react-router-dom';
import { Clock, Plus } from 'lucide-react';

import { useTranslation } from '@web/i18n/use-translation';
import type { StudioSummary } from '@web/pages/studio/shared/studio-types';

interface StudioSwitcherPanelProps {
  /** The viewer's own studios (personal + teams) — NOT guest studios. */
  studios: readonly StudioSummary[];
  /** The active studio slug, or `null` when on the cross-studio Recent view. */
  activeSlug: string | null;
  /** How many guest (shared-with-me) projects the viewer has (shown as a count). */
  guestProjectCount: number;
  /** Called when a destination link is chosen, so the host can close the popover. */
  onNavigate?: () => void;
  /** Called when "New Studio" is chosen, so the host can open the create dialog. */
  onNewStudio?: () => void;
}

/**
 * Order studios with the personal studio first (spec §3.2 / invariant §4:
 * "personal studio always first"), preserving relative order within each group.
 * @param studios the viewer's studios in arbitrary order.
 * @returns a new array with personal studios hoisted to the front.
 */
function personalFirst(
  studios: readonly StudioSummary[],
): readonly StudioSummary[] {
  return [...studios].sort(
    (a, b) =>
      Number(b.type === 'personal') - Number(a.type === 'personal'),
  );
}

/**
 * The studio switcher panel (spec §3.2) — the double-column dropdown opened
 * from the top-bar switcher trigger. Left: a nav column with the Recent entry,
 * the viewer's studios (personal first), a guest-projects count, and a New
 * Studio action. Right: three guidance lines. The active destination (Recent
 * or a studio) is highlighted exactly once (`aria-current="page"`, invariant
 * §4). Guest studios never appear as rows here — only their project count.
 * @param props the studios, active slug, guest count and close callback.
 * @param props.studios the viewer's studios.
 * @param props.activeSlug the active studio slug, or null on the Recent view.
 * @param props.guestProjectCount the viewer's guest project count.
 * @param props.onNavigate called when a destination link is chosen.
 * @param props.onNewStudio called when New Studio is chosen.
 * @returns the switcher panel content.
 */
export function StudioSwitcherPanel({
  studios,
  activeSlug,
  guestProjectCount,
  onNavigate,
  onNewStudio,
}: StudioSwitcherPanelProps): React.JSX.Element {
  const t = useTranslation();
  const ordered = personalFirst(studios);
  const rowBase =
    'flex items-center gap-2.5 rounded-content-md px-3 py-2 text-sm transition-colors';
  const activeRow = 'bg-muted text-foreground';
  const idleRow = 'text-foreground hover:bg-muted';
  return (
    <div className='grid w-[640px] max-w-[88vw] grid-cols-[300px_1fr] gap-4'>
      <nav aria-label={t('studio.container.switcher.myStudios')} className='flex flex-col'>
        <Link
          to='/studio'
          onClick={onNavigate}
          aria-current={activeSlug === null ? 'page' : undefined}
          className={`${rowBase} ${activeSlug === null ? activeRow : idleRow}`}
        >
          <span className='flex h-6 w-6 items-center justify-center rounded-md bg-muted text-muted-foreground'>
            <Clock className='h-3.5 w-3.5' />
          </span>
          {t('studio.container.switcher.recent')}
        </Link>

        <hr className='my-1.5 border-border' />

        <p className='px-3 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
          {t('studio.container.switcher.myStudios')}
        </p>
        {ordered.map((studio) => (
          <Link
            key={studio.id}
            to={`/studio/${studio.slug}`}
            onClick={onNavigate}
            aria-current={studio.slug === activeSlug ? 'page' : undefined}
            className={`${rowBase} ${studio.slug === activeSlug ? activeRow : idleRow}`}
          >
            <span className='flex h-6 w-6 items-center justify-center rounded-md bg-muted text-[0.65rem] font-semibold text-muted-foreground'>
              {studio.name.slice(0, 1).toUpperCase()}
            </span>
            <span className='flex-1 truncate'>{studio.name}</span>
            <span className='text-xs text-muted-foreground'>
              {studio.type === 'team'
                ? t('studio.container.badge.typeTeam')
                : t('studio.container.badge.typePersonal')}
            </span>
          </Link>
        ))}

        <hr className='my-1.5 border-border' />

        <p className='px-3 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
          {t('studio.container.switcher.collaboration')}
        </p>
        <p className='px-3 py-1 text-sm text-muted-foreground'>
          {t('studio.container.switcher.guestProjects', {
            count: guestProjectCount,
          })}
        </p>

        <hr className='my-1.5 border-border' />

        <button
          type='button'
          onClick={onNewStudio}
          className={`${rowBase} text-foreground hover:bg-muted`}
        >
          <span className='flex h-6 w-6 items-center justify-center'>
            <Plus className='h-4 w-4' />
          </span>
          {t('studio.container.switcher.newStudio')}
        </button>
      </nav>

      <div className='flex flex-col gap-2 border-l border-border pl-4 pt-2 text-sm text-muted-foreground'>
        <p>{t('studio.container.switcher.guideRecent')}</p>
        <p>{t('studio.container.switcher.guideEnter')}</p>
        <p>{t('studio.container.switcher.guideTools')}</p>
      </div>
    </div>
  );
}
