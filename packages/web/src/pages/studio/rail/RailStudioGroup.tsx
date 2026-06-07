// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { useRailCollapse } from '@web/pages/studio/rail/use-rail-collapse';
import type { StudioSummary } from '@web/pages/studio/shared/studio-types';

interface RailStudioGroupProps {
  /** Section label (resolved i18n) — e.g. "My studios" / "Joined studios". */
  title: string;
  /** Studios in this group (already split by role via `splitStudios`). */
  studios: readonly StudioSummary[];
  /** The active studio slug, for highlighting the current row. */
  activeSlug: string | null;
  /** Text shown when the group is empty — rendered, never hidden (spec §0.1). */
  emptyText: string;
  /** Stable key for persisting this section's collapse state across sessions. */
  collapseKey: string;
}

const ROW =
  'flex items-center gap-2.5 rounded-content-md px-3 py-1.5 text-sm transition-colors';

/**
 * A rail studio group (spec §4.2 / §4.3 — Discord-style two-level expand). A
 * collapsible header (title + chevron) over the studio list; each studio is a
 * one-click link to `/studio/{slug}` (the active one highlighted). When the
 * group is empty it renders `emptyText` rather than hiding it (spec §0.1 —
 * data-driven, so a future join fills it in with zero display-logic change).
 * The collapse state persists across sessions via `useRailCollapse`.
 * @param props the group's title, studios, active slug, empty text and key.
 * @param props.title the section label.
 * @param props.studios the studios in this group.
 * @param props.activeSlug the active studio slug (highlighted), or null.
 * @param props.emptyText the text shown when the group is empty.
 * @param props.collapseKey the persistence key for the collapse state.
 * @returns the collapsible studio group.
 */
export function RailStudioGroup({
  title,
  studios,
  activeSlug,
  emptyText,
  collapseKey,
}: RailStudioGroupProps): React.JSX.Element {
  const { collapsed, toggle } = useRailCollapse(collapseKey);
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <div className='flex flex-col'>
      <button
        type='button'
        onClick={toggle}
        aria-expanded={!collapsed}
        className='flex items-center gap-1.5 rounded-content-md px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted'
      >
        <Chevron className='h-3.5 w-3.5' />
        {title}
      </button>
      {collapsed ? null : studios.length === 0 ? (
        <p className='px-3 py-1 text-sm text-muted-foreground'>{emptyText}</p>
      ) : (
        <ul className='flex flex-col'>
          {studios.map((studio) => (
            <li key={studio.id}>
              <Link
                to={`/studio/${studio.slug}`}
                aria-current={studio.slug === activeSlug ? 'page' : undefined}
                className={`${ROW} ${
                  studio.slug === activeSlug
                    ? 'bg-muted text-foreground'
                    : 'text-foreground hover:bg-muted'
                }`}
              >
                <span className='flex h-6 w-6 items-center justify-center rounded-md bg-muted text-[0.65rem] font-semibold text-muted-foreground'>
                  {studio.name.slice(0, 1).toUpperCase()}
                </span>
                <span className='flex-1 truncate'>{studio.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
