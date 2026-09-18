// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one judgement of whether a block's own content paints anything.
 *
 * The looks-empty hint asks it, so it can offer the words "Start writing…" on a
 * block a reader sees nothing on (user 2026-08-18 settled which types those
 * are).
 *
 * WHICH TYPES CAN BE INVISIBLE is the whole of the judgement: a paragraph and
 * a heading draw nothing but their words, and every other type draws something
 * of its own — a marker, a number, a frame — so it is visible whatever it
 * holds. Written as the small list rather than the large one, because the
 * small one is the one that stays small: a type added to the schema draws
 * something, or it would not be worth adding.
 */

/** The block types that paint nothing at all while they hold no text. */
const INVISIBLE_WHEN_EMPTY: ReadonlySet<string> = new Set(['paragraph', 'heading']);

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
