// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the block handle needs to know about the block under the pointer.
 *
 * The side menu hands over one block; two questions follow from it, and both
 * have answers the library does not give. Whether the row draws a handle at
 * all, and which range a command off that row acts on.
 */

/** The part of a BlockNote block this file reads. */
export interface HoveredBlock {
  /** Which kind of block it is. */
  readonly type: string;
  /** Its own inline content, empty for a block that carries none. */
  readonly content?: readonly unknown[];
  /** Blocks nested under it. */
  readonly children?: readonly unknown[];
}

/**
 * Block types that take up a row even with nothing in them.
 *
 * A code block draws its frame while empty, so the reader sees a row there and
 * expects to be able to grab it. Table and the media blocks join this set when
 * they arrive (#15 / #16 / #17).
 */
const DRAWS_WHILE_EMPTY: ReadonlySet<string> = new Set(['codeBlock']);

/**
 * Whether the reader sees anything on this block's row.
 *
 * The handle is offered for a row that shows something and withheld from one
 * that does not (menu system spec §5, `:457`). Emptiness cannot be read off
 * `content` alone: it carries the block's OWN inline content, while nested
 * blocks live in `children` (`BlockContainer.ts:27` is
 * `blockContent blockGroup?`), so a list item whose text was deleted still
 * draws a bullet above the items indented under it.
 * @param block - The block under the pointer.
 * @returns True when the row shows something.
 */
export function rowShowsSomething(block: HoveredBlock): boolean {
  if (DRAWS_WHILE_EMPTY.has(block.type)) return true;
  if ((block.children?.length ?? 0) > 0) return true;

  return (block.content?.length ?? 0) > 0;
}
