// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 *
 * Everything else about how it looks comes from the `chrome-ghost` variant,
 * which is the description of exactly this: an icon-only chrome button, muted
 * at rest, accent fill and full foreground under the pointer. Written out by
 * hand it takes fourteen classes: seven the `Button` base hands out
 * unconditionally, three that are exactly what `chrome-ghost` says, and four
 * of its own — so ten of the fourteen were a copy of something already said.
 *
 * The glyph inside takes no colour of its own. `currentColor` resolves against
 * the nearest element that sets one, so a glyph naming its own colour makes
 * the button's `text-*` and `hover:text-*` dead and needs a `group-hover:`
 * variant to win the effect back. Leaving the colour to the button is one rule
 * instead of three.
 */
const TOGGLE = 'h-6 w-6 shrink-0';

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
          // Named only while the list is mounted. Collapsing unmounts it, and
          // the collapse is persisted, so a fixed value would go on naming an
          // element that is not in the document for as long as the group stays
          // shut. ARIA files that under author error: user agents are told to
          // ignore such a reference and not to expose the attribute at all. The
          // attribute is optional on a disclosure to begin with, so rather than
          // ship a reference the platform will discard, it is named only while
          // there is something to name — which is how the patterns that do
          // require a resolvable reference (combobox, scrollbar) keep theirs.
          // `aria-expanded` carries the state either way.
          aria-controls={collapsed ? undefined : listId}
          variant='chrome-ghost'
          size={null}
          className={TOGGLE}
        >
          <Chevron className='h-3 w-3' />
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
