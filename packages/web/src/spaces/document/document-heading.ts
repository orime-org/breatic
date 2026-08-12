// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The body's headings, capped at three levels.
 *
 * StarterKit's Heading ships with all six, each with an input rule and a
 * `Mod-Alt-N` shortcut, so on stock StarterKit a fourth level would be one
 * `#### ` away. The body has no room for one: `h3` is already 17px against a 15px
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

import type { DOMOutputSpec } from '@tiptap/pm/model';
import { Heading } from '@tiptap/extension-heading';

/**
 * The heading levels the body offers, largest first.
 *
 * `index.css` gives each of these a size and weight by hand — CSS cannot read
 * this array, and the project has no JS Tailwind config to bridge them. So
 * widening this list means adding a rule there in the same change: preflight
 * resets `h1..h6` to inherit, and a level with no rule of its own renders at
 * the paragraph's size and weight, which is the exact defect this slice exists
 * to remove. That is HELD, not merely asked for — `document-heading-levels`
 * reads the stylesheet off disk and fails on a level with no size and weight
 * of its own, so widening this array alone turns it red.
 */
export const BODY_HEADING_LEVELS = [1, 2, 3] as const;

export const BodyHeading = Heading.extend({
  /**
   * Render as Heading does, with an out-of-range level moved into range first.
   *
   * The work is delegated rather than reimplemented. Copying Heading's four
   * lines and editing one of them would leave the other three free to drift
   * from upstream unnoticed — nothing here asserts on the attributes they
   * merge, so a change to that half would go unnoticed too. Handing the level
   * back in range and calling the parent leaves exactly one line that is ours.
   * @param props - The node being rendered and the attributes resolved for it.
   * @param props.node - The heading node, whose `level` attribute may be out of range.
   * @returns The DOM output spec for this heading.
   */
  renderHTML(props) {
    // BOTH READS COME FROM `this.options.levels`, and they have to. Heading's
    // own renderHTML is the code this hands off to, and it decides whether a
    // level is in range by consulting that option; a fallback derived from
    // anywhere else can be out of range by the time it gets there, and that
    // code answers an out-of-range level with `levels[0]` — the LARGEST
    // heading, which is what this override exists to avoid.
    //
    // Reading the module constant here instead LOOKS like it removes a second
    // source of truth and does not: measured, `.configure({ levels: [1, 2] })`
    // then renders a stored level 3 as `<h1>` either way, because the option
    // is what the parent goes on. The largest number is the smallest heading.
    const levels = this.options.levels as number[];
    const stored = props.node.attrs.level as number;
    if (levels.includes(stored)) {
      return this.parent?.(props) as DOMOutputSpec;
    }
    const inRange = props.node.type.create(
      { ...props.node.attrs, level: Math.max(...levels) },
      props.node.content,
      props.node.marks,
    );
    return this.parent?.({ ...props, node: inRange }) as DOMOutputSpec;
  },
}).configure({ levels: [...BODY_HEADING_LEVELS] });
