// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The paragraph of an optional template input (inner#1811, CAP-9).
 *
 * A template's reference to an input the user may leave empty lands as a
 * mention marked optional, alone in its paragraph. While the node it names
 * holds no picture, that paragraph is left out of what generation gets and is
 * greyed in the box; once it holds one, the paragraph is sent and shown as
 * usual. Every reader of a prompt -- the box, the string it sends, the sources
 * it sends, a shot read off its fragment -- asks {@link heldBackBy}, so what
 * is greyed is exactly what is left out.
 */

import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import { MENTION_SOURCE_ID_ATTR, REFERENCE_MENTION_NODE } from '@web/features/reference-mention/mention-node';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';

/** Attr key on a reference-mention node marking a mention of an optional template input. */
export const MENTION_OPTIONAL_ATTR = 'optional';

/** Attr a held-back paragraph carries in the box, holding the names of the inputs it waits for. */
export const HELD_BACK_ATTR = 'data-prompt-held-back';

/** One mention in a paragraph, as a reader finds it: what it names and whether it is marked optional. */
export interface ParagraphMention {
  id: unknown;
  optional: unknown;
}

/**
 * The sources holding a paragraph back: each optional mention in it whose
 * source is in the pool and holds no picture. A paragraph with none is sent.
 * @param mentions - The paragraph's mentions.
 * @param pool - The node's reference rows.
 * @returns The rows holding it back, each once, in the order mentioned.
 */
export function heldBackBy(mentions: Iterable<ParagraphMention>, pool: ReadonlyArray<ReferenceRailItem>): ReferenceRailItem[] {
  const held: ReferenceRailItem[] = [];
  for (const { id, optional } of mentions) {
    if (optional !== true || typeof id !== 'string') continue;
    const row = pool.find((one) => one.sourceNodeId === id);
    if (row !== undefined && !row.mediaUrl && !held.includes(row)) held.push(row);
  }
  return held;
}

/**
 * The mentions of a ProseMirror block.
 * @param block - The block.
 * @returns Its mentions.
 */
export function blockMentions(block: PMNode): ParagraphMention[] {
  const mentions: ParagraphMention[] = [];
  block.descendants((node) => {
    if (node.type.name === REFERENCE_MENTION_NODE) {
      mentions.push({ id: node.attrs[MENTION_SOURCE_ID_ATTR], optional: node.attrs[MENTION_OPTIONAL_ATTR] });
    }
  });
  return mentions;
}

/** Where the box reads the pool it greys against: the pool every other reader of the box reads. */
export interface OptionalParagraphsOptions {
  getPool: () => ReadonlyArray<ReferenceRailItem>;
}

/**
 * Greys each paragraph the prompt leaves out, naming in {@link HELD_BACK_ATTR}
 * the inputs it waits for. Decorations are worked out on every view update, so
 * a transaction dispatched once the pool changes redraws them.
 */
export const OptionalParagraphs = Extension.create<OptionalParagraphsOptions>({
  name: 'optionalParagraphs',
  addOptions() {
    return { getPool: () => [] };
  },
  addProseMirrorPlugins() {
    const { getPool } = this.options;
    return [
      new Plugin({
        props: {
          decorations: (state) => {
            const pool = getPool();
            const decorations: Decoration[] = [];
            state.doc.forEach((block, offset) => {
              const held = heldBackBy(blockMentions(block), pool);
              if (held.length === 0) return;
              decorations.push(
                Decoration.node(offset, offset + block.nodeSize, {
                  // The words stay readable in the muted text colour; the chip fades the
                  // way a chip of a kind the mode cannot use does.
                  class: 'text-muted-foreground [&_.reference-mention]:opacity-40 [&_.reference-mention]:grayscale',
                  [HELD_BACK_ATTR]: held.map((row) => row.sourceNodeName).join(', '),
                }),
              );
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
