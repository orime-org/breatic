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

/** The padding a rail segment insets its contents by. */
export const RAIL_SEGMENT = 'p-2';

/** How far in a top-level row sits. */
export const RAIL_INDENT_TOP = 'pl-2';

/**
 * How far in a row one level under a heading sits. The 6px between this and
 * {@link RAIL_INDENT_TOP} is the whole of how the second level reads, so both
 * live here rather than being typed out wherever a row happens to be built.
 */
export const RAIL_INDENT_NESTED = 'pl-3.5';

/**
 * Build a rail row's classes at a given indent.
 *
 * A row carries its own width, alignment, weight and focus ring rather than
 * borrowing them from whatever contains it, because each had already gone wrong
 * that way. A `<button>` sizes to its content whatever its `display` is, so the
 * create actions only filled the rail while their parent happened to be a flex
 * column stretching them. `justify-start` undoes the `Button` primitive's
 * centring — a comment in `RailCreateActions` claimed that class was applied,
 * but it never was, so the three create actions had been sitting centred. And
 * `font-normal` is here to be overridden: without a weight of its own the
 * primitive's `font-medium` came through, leaving the three buttons permanently
 * at the weight {@link RAIL_ROW_CURRENT} uses to mark where the viewer is.
 *
 * The focus ring and the wrapping are the same story told by the element type.
 * The rail's rows are a mix of `<Link>` and `<Button>`; `variant={null}
 * size={null}` suppresses the primitive's variants but never its cva base, and
 * that base carries both a focus ring and `whitespace-nowrap`. So the buttons
 * had a ring the links did not, and refused to wrap where the links were free
 * to. Naming both here is what makes a row a row rather than whichever element
 * it happens to be built on.
 * @param paddingLeft - The left-padding class that places this level.
 * @returns The row's class string, indent included.
 */
function railRow(paddingLeft: string): string {
  return `flex h-8 w-full items-center justify-start gap-2 whitespace-nowrap rounded-chrome ${paddingLeft} pr-2 text-sm font-normal transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`;
}

/**
 * An icon-only button in the rail's chrome at a given size — the group
 * chevron, the narrow-screen hamburger.
 *
 * These two were written out separately and came out identical in all thirteen
 * classes, including the focus ring {@link railRow} names as its own. That is
 * not a coincidence to leave standing: the chevron sits in the same tab order
 * as the rows, so the reason the ring is stated in one place applies to it too.
 * Only the size ever differs.
 *
 * The glyph inside takes no colour of its own. `currentColor` resolves against
 * the nearest element that sets one, so a glyph that names its own colour
 * makes the button's `text-*` and `hover:text-*` dead classes and needs a
 * `group-hover:` variant to get the effect back. Leaving the colour to the
 * button is one rule instead of three.
 * @param size - The height and width classes for this button.
 * @returns The button's class string.
 */
export function railIconButton(size: string): string {
  return `flex ${size} items-center justify-center rounded-chrome text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`;
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
export const RAIL_ROW_TOP = railRow(RAIL_INDENT_TOP);

/** A row one level in, under a group heading: a studio the viewer belongs to. */
export const RAIL_ROW_NESTED = railRow(RAIL_INDENT_NESTED);

/**
 * How a row reads when it is the destination the viewer is currently on.
 * Applied on top of a level's classes, so both levels highlight alike.
 */
export const RAIL_ROW_CURRENT = 'group bg-accent font-medium text-foreground';

/** How a row reads when it is not the current destination. */
export const RAIL_ROW_IDLE = 'group text-foreground hover:bg-accent';

/**
 * How a row reads when it cannot be used. It keeps `cursor-not-allowed` rather
 * than `pointer-events: none` so the hover still explains itself — and it does
 * NOT carry `group`, which is what would otherwise let the pointer light its
 * icon brighter than its own dimmed label.
 *
 * The dimming names the `disabled:` modifier because the only rows that use it
 * are disabled `Button`s, and the primitive dims those to 50% through
 * `disabled:opacity-50`. Written without that prefix it never landed: a plain
 * class loses on specificity to a class plus a pseudo-class, and twMerge leaves
 * both standing because the modifiers differ. Named the same way, twMerge drops
 * the primitive's and this value is the one that renders.
 *
 * Keep class names out of prose here: Tailwind scans this file as text, so a
 * name written only in a comment still ships a rule nothing uses.
 */
export const RAIL_ROW_DISABLED =
  'cursor-not-allowed text-muted-foreground disabled:opacity-65';

/**
 * The column a row leads with — 20px wide, whatever sits in it.
 *
 * Where a row's label starts is its indent plus this width plus the gap, so
 * the levels only read as one step apart if this width is the same on both.
 * A studio row leads with a 20px avatar; without a column of its own a
 * top-level row would lead with its bare 14px glyph and start its label six
 * short, turning the deliberate 6px step into ten.
 */
export const RAIL_ICON_BOX = 'flex h-5 w-5 shrink-0 items-center justify-center';

/**
 * The glyph inside {@link RAIL_ICON_BOX}. One secondary grey for all of them:
 * an icon painted louder than the words beside it is what made the column read
 * as noise. It comes up with its row under the pointer, and on the row the
 * viewer is actually on — that second half matters because without it, hovering
 * a row you are not on lights it brighter than the one you are. Both reach the
 * icon through the `group` its row carries, which is why a disabled row does
 * not carry one.
 */
export const RAIL_ICON =
  'h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-foreground group-aria-[current=page]:text-foreground';
