// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * rail-row.ts — what a row in the studio rail looks like, written once.
 *
 * The rail holds two levels: destinations and actions at the top, and the
 * studios belonging to a group one level under its heading. The 2026-06-07
 * rail spec drew that tree (§4.3, "二级展开"), and its §4.1 sketch already
 * showed the studios indented beneath their heading.
 *
 * The indent is the whole of how the second level reads — heights match, the
 * type matches, only the left edge moves. Keeping that in one file is the
 * point: when the shape lived in four hand-copied strings, two were
 * byte-identical and the other two had each drifted a different way, which is
 * where the rail's mismatched heights, indents and gaps came from.
 */

/**
 * Build a rail row's classes at a given indent.
 * @param paddingLeft - The left-padding class that places this level.
 * @returns The row's class string, indent included.
 */
function railRow(paddingLeft: string): string {
  return `group flex h-8 items-center gap-2.5 rounded-chrome ${paddingLeft} pr-2 text-sm transition-colors`;
}

/** A top-level row: Recent, the create actions, create-studio in the footer. */
export const RAIL_ROW_TOP = railRow('pl-2');

/** A row one level in, under a group heading: a studio the viewer belongs to. */
export const RAIL_ROW_NESTED = railRow('pl-3.5');

/**
 * How a row reads when it is the destination the viewer is currently on.
 * Applied on top of a level's classes, so both levels highlight alike.
 */
export const RAIL_ROW_CURRENT = 'bg-accent font-medium text-foreground';

/** How a row reads when it is not the current destination. */
export const RAIL_ROW_IDLE = 'text-foreground hover:bg-accent';

/**
 * A rail icon. One secondary grey for all of them: an icon painted louder
 * than the words beside it is what made the column read as noise. It comes up
 * with its row on hover, which is why the row carries `group`.
 */
export const RAIL_ICON =
  'h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground';
