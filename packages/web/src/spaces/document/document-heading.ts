// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The body's headings, capped at three levels.
 *
 * StarterKit's Heading ships with all six, each with an input rule and a
 * `Mod-Alt-N` shortcut, so a fourth level is reachable today by typing
 * `#### `. The body has no room for one: `h3` is already 17px against a 15px
 * paragraph, and a fourth would have to fit in the two pixels left. Notion and
 * Feishu both stop at three for the same reason.
 *
 * Narrowing `levels` does NOT delete anything already stored — the option
 * governs input rules, shortcuts and rendering, not the range of the `level`
 * attribute, and a document holding a fourth-level heading opens with it
 * intact. What it does change is how that heading RENDERS, and the stock
 * behaviour is the wrong way round: `renderHTML` falls back to `levels[0]`,
 * which is the LARGEST level we keep, so a minor heading would come back as
 * the biggest text on the page. The fallback is overridden to land on the
 * smallest level instead.
 *
 * Two things still put such a heading in front of that fallback, and pasting
 * is not one of them — `parseHTML` is built from `levels`, so an `<h4>` no
 * longer matches any rule and arrives as a paragraph:
 *
 * - a document written before the cap, or by a peer still on the six-level
 *   bundle, which reaches this client through Yjs;
 * - splitting one of those headings, which mints another node at the same
 *   out-of-range level. Verified: Enter inside a stored level-4 heading leaves
 *   two of them, both rendered as `h3`.
 */

import { mergeAttributes } from '@tiptap/core';
import { Heading } from '@tiptap/extension-heading';

/** The heading levels the body offers, largest first. */
export const BODY_HEADING_LEVELS = [1, 2, 3] as const;

/** Where a level outside {@link BODY_HEADING_LEVELS} renders instead. */
const FALLBACK_LEVEL = BODY_HEADING_LEVELS[BODY_HEADING_LEVELS.length - 1];

export const BodyHeading = Heading.extend({
  /**
   * Render at the stored level, or at the smallest level we keep.
   *
   * Only the fallback differs from the stock implementation, and it is the
   * whole reason this override exists.
   * @param props - The node being rendered and the attributes resolved for it.
   * @param props.node - The heading node, whose `level` attribute may be out of range.
   * @param props.HTMLAttributes - Attributes the editor resolved for this node.
   * @returns The DOM output spec for this heading.
   */
  renderHTML({ node, HTMLAttributes }) {
    const stored = node.attrs.level as number;
    const level = (this.options.levels as number[]).includes(stored)
      ? stored
      : FALLBACK_LEVEL;
    return [
      `h${level}`,
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
      0,
    ];
  },
}).configure({ levels: [...BODY_HEADING_LEVELS] });
