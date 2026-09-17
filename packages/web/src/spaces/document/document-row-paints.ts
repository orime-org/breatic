// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one judgement of whether a block's own content paints anything.
 *
 * Two features ask it, and they used to answer it separately. The looks-empty
 * hint asks so it can offer the words "Start writing…" on a block a reader
 * sees nothing on (user 2026-08-18 settled which types those are); the block
 * strip asks so it can offer a handle for a row a reader can see. They
 * disagreed: an empty bulleted item draws its marker, so the hint stays away
 * from it, while the strip's own list of "types that draw while empty" held
 * only `codeBlock` and so withheld the handle — measured 2026-09-17, a bullet
 * with its text deleted showed a marker, a plus, and no handle.
 *
 * WHICH TYPES CAN BE INVISIBLE is the whole of the judgement: a paragraph and
 * a heading draw nothing but their words, and every other type draws something
 * of its own — a marker, a number, a frame — so it is visible whatever it
 * holds. Written as the small list rather than the large one, because the
 * small one is the one that stays small: a type added to the schema draws
 * something, or it would not be worth adding.
 *
 * WHAT EACH CALLER ADDS. The hint asks about one content node, which is all a
 * decoration can be put on. The strip asks about a row, which also has blocks
 * nested under it — a row whose own text is gone still stands above them. So
 * the shared part is this, and the nesting stays with the caller that has it.
 */

/** The block types that paint nothing at all while they hold no text. */
export const INVISIBLE_WHEN_EMPTY: ReadonlySet<string> = new Set(['paragraph', 'heading']);

/** What the judgement needs to know about a block's own content. */
export interface OwnContent {
  /** The content type's name, as the schema spells it. */
  readonly type: string;
  /** Whether it stands in a quote, which draws a rule beside it. */
  readonly quoted: boolean;
  /** Whether it carries a document number, which is drawn before it. */
  readonly numbered: boolean;
  /** How many of its inline children a reader can see. */
  readonly visibleInlines: number;
}

/**
 * Whether the reader sees anything of this block's own content.
 * @param content - See {@link OwnContent}.
 * @returns True when something is drawn.
 */
export function ownContentPaints(content: OwnContent): boolean {
  if (!INVISIBLE_WHEN_EMPTY.has(content.type)) return true;
  if (content.quoted || content.numbered) return true;

  return content.visibleInlines > 0;
}
