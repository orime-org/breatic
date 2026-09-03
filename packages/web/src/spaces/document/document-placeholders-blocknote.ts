// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The document's one hint: "start writing", shown while the document LOOKS
 * empty.
 *
 * What counts as empty is what the READER sees rather than what the node count
 * says (user 2026-08-18). An empty code block shows its background, an empty
 * quote its border, an empty list its marker, a stand-in its labelled box —
 * all of those are content, and all of them keep the hint away. What is left
 * is a paragraph or a heading with nothing in it.
 *
 * ## What the flat model moved
 *
 * Two of the things a reader can see stopped being node types and became
 * props. A quote is `quoted` on the block; a numbered heading is `numbered`.
 * Each paints while holding no text — a border, a number — and neither is
 * visible to a check that reads only the node's name, so both are read here.
 *
 * The zero-block half of the previous placeholder is gone with the state it
 * drew for: `BlockGroup.ts:11` is `blockGroupChild+`, so a document with no
 * blocks is not a state this editor can rest in, and a fresh Space arrives
 * from the backend holding one paragraph.
 *
 * ## Why not the placeholder extension every other editor uses
 *
 * That one decorates a textblock by emptiness alone, which would put the hint
 * inside an empty quote and an empty list item as well. The mechanism is the
 * same one: a `data-block-placeholder` attribute that index.css paints as a
 * zero-height float. Where that float lands is a question for a real browser,
 * because this model wraps the text in one element more than the old one did;
 * the styling step measures it.
 *
 * The string is read per render rather than captured once, because the editor
 * is built once per document and would otherwise keep whichever language was
 * active at that moment. Asking for the redraw is `locale-redraw`'s job: an
 * attribute is recomputed only when something dispatches, and switching
 * language dispatches nothing.
 */

import { createExtension, type ExtensionFactoryInstance } from '@blocknote/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import { t } from '@breatic/shared';

import { QUOTED } from '@web/spaces/document/document-list-block';

/** The block types that paint nothing at all while they hold no text. */
const INVISIBLE_WHEN_EMPTY = new Set(['paragraph', 'heading']);

/**
 * Whether a block's own content node paints nothing a reader could see.
 * @param content - The `blockContent` node — the block's own type and props.
 * @returns True when the block shows nothing.
 */
function paintsNothing(content: PMNode): boolean {
  if (!INVISIBLE_WHEN_EMPTY.has(content.type.name)) return false;
  if (content.attrs[QUOTED] === true) return false;
  if (content.attrs['numbered'] === true) return false;
  let visible = false;
  content.content.forEach((inline) => {
    if (inline.type.name !== 'hardBreak') visible = true;
  });
  return !visible;
}

/**
 * The first block's own content node, and where it sits.
 *
 * The shape is `doc > blockGroup > blockContainer > blockContent`, and the
 * decoration goes on the CONTENT node — the innermost one there is. It renders
 * as `div.bn-block-content`, holding the paragraph as `p.bn-inline-content`;
 * that paragraph is not a node, so it cannot be decorated, and this is as
 * close to the text as ProseMirror reaches.
 * @param doc - The document node.
 * @returns The content node and its position; null when the document has no
 *   block at all.
 */
function firstBlock(doc: PMNode): { node: PMNode; pos: number } | null {
  const group = doc.childCount > 0 ? doc.child(0) : null;
  if (group === null || group.childCount === 0) return null;
  const container = group.child(0);
  if (container.childCount === 0) return null;
  // 1 enters the group, 1 more enters the container.
  return { node: container.child(0), pos: 2 };
}

/**
 * Whether every block in the document paints nothing.
 * @param doc - The document node.
 * @returns True when a reader would see an empty page.
 */
function looksEmpty(doc: PMNode): boolean {
  const group = doc.childCount > 0 ? doc.child(0) : null;
  if (group === null) return false;
  for (let i = 0; i < group.childCount; i += 1) {
    const container = group.child(i);
    // A container holding a nested group holds blocks below it, which are
    // content whatever the first one paints.
    if (container.childCount !== 1) return false;
    if (!paintsNothing(container.child(0))) return false;
  }
  return true;
}

/**
 * The hint on the first block of a document that looks empty.
 * @param state - The editor state to read.
 * @returns The decoration set, or null when anything is written.
 */
function firstBlockHint(state: EditorState): DecorationSet | null {
  const { doc } = state;
  if (!looksEmpty(doc)) return null;
  const first = firstBlock(doc);
  if (first === null) return null;
  return DecorationSet.create(doc, [
    Decoration.node(first.pos, first.pos + first.node.nodeSize, {
      'data-block-placeholder': t('spaces.document.placeholder'),
    }),
  ]);
}

/**
 * Builds the extension that draws the hint.
 * @returns The extension, for the assembly to register.
 */
export function documentPlaceholderExtension(): ExtensionFactoryInstance {
  return createExtension(() => ({
    key: 'documentPlaceholder',
    prosemirrorPlugins: [
      new Plugin({
        key: new PluginKey('documentPlaceholder'),
        props: { decorations: firstBlockHint },
      }),
    ],
  }) as never)();
}
