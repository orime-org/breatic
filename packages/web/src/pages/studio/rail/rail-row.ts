// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * rail-row.ts — what a row in the studio rail looks like, written once.
 *
 * The rail holds two levels: destinations and actions at the top, and the
 * studios belonging to a group one level under its heading. The 2026-06-07
 * rail spec drew that tree in its §4.3 "two-level expand" section, and its
 * §4.1 sketch already showed the studios indented beneath their heading.
 *
 * The indent is the whole of how the second level reads — heights match, the
 * type matches, only the left edge moves. Keeping that in one file is the
 * point: when the shape lived in four hand-copied strings, two were
 * byte-identical and the other two had each drifted a different way, which is
 * where the rail's mismatched heights, indents and gaps came from.
 */

/**
 * Build a rail row's classes at a given indent.
 *
 * A row carries its own width and alignment rather than borrowing them from
 * whatever contains it, because both had already gone wrong that way. A
 * `<button>` sizes to its content whatever its `display` is, so the create
 * actions only filled the rail while their parent happened to be a flex
 * column stretching them; moving create-studio into the footer, where nothing
 * stretches it, left it 111px wide against the 223px rows it should match.
 * And `justify-start` undoes the `Button` primitive's centring — a comment in
 * `RailCreateActions` claimed that class was applied, but it never was, so the
 * three create actions had been sitting centred, icons 45–54px right of
 * Recent's.
 * @param paddingLeft - The left-padding class that places this level.
 * @returns The row's class string, indent included.
 */
function railRow(paddingLeft: string): string {
  return `group flex h-8 w-full items-center justify-start gap-2.5 rounded-chrome ${paddingLeft} pr-2 text-sm transition-colors`;
}

/**
 * How rail rows stack, wherever they stack: one column, one gap.
 *
 * The gap belongs to the container, so a row cannot carry it — which is how
 * the studio lists ended up with none while the top-level rows had 2px. With
 * the rows touching, a selected row and the row hovered beside it merge into
 * one filled block instead of reading as two.
 */
export const RAIL_LIST = 'flex flex-col gap-0.5';

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
