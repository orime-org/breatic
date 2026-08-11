// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { cn } from '@web/lib/utils';
import {
  RAIL_INDENT_NESTED,
  RAIL_INDENT_TOP,
  RAIL_LIST,
  RAIL_ROW_CURRENT,
  RAIL_ROW_IDLE,
  RAIL_ROW_NESTED,
} from '@web/pages/studio/rail/rail-row';
import { useRailCollapse } from '@web/pages/studio/rail/use-rail-collapse';
import type { StudioSummary } from '@web/pages/studio/shared/studio-types';
import { StudioAvatar } from '@web/ui/StudioAvatar';

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

/**
 * The group heading: a quiet label, one step below the rows it names. It sits
 * at the top level's indent, taken from there rather than typed again.
 */
const HEADING = `flex h-7 items-center gap-1 ${RAIL_INDENT_TOP} pr-1`;

/** The heading's text — 11px with wider tracking, so studio names stay loudest. */
const HEADING_TEXT =
  'flex-1 truncate text-2xs font-semibold tracking-wider text-muted-foreground';

/**
 * The chevron's own hit area — `--btn-compact`, the smallest step on the
 * chrome ladder. Small, but far larger than the 12px glyph inside it.
 */
const TOGGLE =
  'group flex h-6 w-6 shrink-0 items-center justify-center rounded-chrome text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

/**
 * A rail studio group (spec §4.2 / §4.3 — Discord-style two-level expand): a
 * heading over the studios in this group, each a one-click link to
 * `/studio/{slug}` (the active one highlighted). When the group is empty it
 * renders `emptyText` rather than hiding it (spec §0.1 — data-driven, so a
 * future join fills it in with zero display-logic change). The collapse state
 * persists across sessions via `useRailCollapse`.
 *
 * Collapsing answers to the chevron alone. The heading is a label, not a
 * control: a whole row lighting up under the pointer reads as "this row goes
 * somewhere", and this one only opens and closes — the reach and what it does
 * did not match. Keeping the heading a plain element also leaves room to put
 * something else on that line later without nesting one button inside another.
 *
 * The chevron takes its accessible name from the heading through
 * `aria-labelledby`, so the group is named once, in one translated string.
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
  const titleId = React.useId();
  const listId = React.useId();
  return (
    <div className='flex flex-col'>
      <div className={HEADING}>
        <span id={titleId} className={HEADING_TEXT}>
          {title}
        </span>
        <Button
          type='button'
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-labelledby={titleId}
          aria-controls={listId}
          variant={null}
          size={null}
          className={TOGGLE}
        >
          <Chevron className='h-3 w-3 text-muted-foreground transition-colors group-hover:text-foreground' />
        </Button>
      </div>
      {collapsed ? null : (
        <div id={listId}>
          {studios.length === 0 ? (
            <p
              className={`py-1.5 ${RAIL_INDENT_NESTED} pr-2 text-xs text-muted-foreground`}
            >
              {emptyText}
            </p>
          ) : (
            <ul className={RAIL_LIST}>
              {studios.map((studio) => (
                <li key={studio.id}>
                  <Link
                    to={`/studio/${studio.slug}`}
                    aria-current={
                      studio.slug === activeSlug ? 'page' : undefined
                    }
                    className={cn(
                      RAIL_ROW_NESTED,
                      studio.slug === activeSlug
                        ? RAIL_ROW_CURRENT
                        : RAIL_ROW_IDLE,
                    )}
                  >
                    <StudioAvatar
                      name={studio.name}
                      type={studio.type}
                      avatarUrl={studio.avatarUrl}
                      size='xs'
                    />
                    <span className='flex-1 truncate'>{studio.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
