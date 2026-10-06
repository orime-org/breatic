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
import type { RailSection } from '@web/lib/user-preferences-storage';
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
  section: RailSection;
}

/**
 * The group heading: a quiet label, one step below the rows it names. It sits
 * at the top level's indent, taken from there rather than typed again.
 */
const HEADING = `flex h-7 items-center ${RAIL_INDENT_TOP} pr-1`;

/** The heading's text — 11px with wider tracking, so studio names stay loudest. */
const HEADING_TEXT = 'flex-1 truncate text-left text-2xs font-semibold tracking-wider';

/**
 * The heading's one control: title and chevron together, so the group opens
 * and closes from its words as well as its arrow. Under the pointer the words
 * and the chevron brighten and no fill appears, so it does not read as a row
 * that navigates somewhere. The glyph inside takes no colour of its own and
 * follows the button's `text-*` and `hover:text-*`.
 */
const TOGGLE =
  'h-7 min-w-0 flex-1 justify-between gap-1 text-muted-foreground hover:text-foreground';

/** The chevron's slot — `--btn-compact`, so the arrow keeps a 24px box. */
const CHEVRON_SLOT = 'flex h-6 w-6 shrink-0 items-center justify-center';

/**
 * A rail studio group (spec §4.2 / §4.3 — Discord-style two-level expand): a
 * heading over the studios in this group, each a one-click link to
 * `/studio/{slug}` (the active one highlighted). When the group is empty it
 * renders `emptyText` rather than hiding it (spec §0.1 — data-driven, so a
 * future join fills it in with zero display-logic change). The collapse state
 * is remembered per account via `useRailCollapse`.
 *
 * The whole heading is one disclosure button: clicking the title or the
 * chevron opens and closes the group, and the button's own text names it.
 * @param props the group's title, studios, active slug, empty text and key.
 * @param props.title the section label.
 * @param props.studios the studios in this group.
 * @param props.activeSlug the active studio slug (highlighted), or null.
 * @param props.emptyText the text shown when the group is empty.
 * @param props.section which rail section this is; its collapse state is remembered per account.
 * @returns the collapsible studio group.
 */
export function RailStudioGroup({
  title,
  studios,
  activeSlug,
  emptyText,
  section,
}: RailStudioGroupProps): React.JSX.Element {
  const { collapsed, toggle } = useRailCollapse(section);
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const listId = React.useId();
  return (
    <div className='flex flex-col'>
      <div className={HEADING}>
        <Button
          type='button'
          onClick={toggle}
          aria-expanded={!collapsed}
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
          variant={null}
          size={null}
          className={TOGGLE}
        >
          <span className={HEADING_TEXT}>{title}</span>
          <span className={CHEVRON_SLOT}>
            <Chevron className='h-3 w-3' />
          </span>
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
