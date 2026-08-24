// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The document's one placeholder: "start writing", shown while the document
 * LOOKS empty — no blocks at all, or nothing but empty paragraphs and
 * headings, the two blocks that paint nothing when they hold no text. To the
 * person looking at the screen those states are identical (click into a new
 * document, type nothing, come back: one empty paragraph, blank screen), so
 * the hint has to be identical too (user 2026-08-18). An empty code block
 * shows its background, an empty quote its border, an empty list its bullet,
 * a stand-in its labelled box — those are visible content and keep the
 * placeholder away.
 *
 * ## Why not the placeholder extension every other editor uses
 *
 * It decorates textblocks that EXIST in the document, and a document with no
 * blocks has nothing to decorate — so its placeholder could never be drawn at
 * all. That is a property of the installed version rather than a guess:
 * `@tiptap/extensions` skips anything that is not a textblock.
 *
 * The rule that extension relies on in the stylesheet is left exactly as it
 * is — the generate prompt still uses it. This document simply does not
 * depend on it.
 *
 * ## What this does instead
 *
 * Marks the empty state and lets the stylesheet draw the text, through two
 * mechanisms that between them cover both shapes of emptiness:
 *
 * - **No blocks at all**: a class and the string on the EDITOR element, since
 *   there is no node to decorate. index.css paints it and gives it a
 *   paragraph's top margin, so it lands on the line a first paragraph would.
 * - **Blocks that paint nothing**: a `data-block-placeholder` decoration on
 *   the FIRST such block, painted as a zero-height float inside it — the
 *   mechanism tiptap's own Placeholder uses. The hint sits on the line where
 *   typing will land, which is the same line the zero-block hint occupies:
 *   the two states are indistinguishable on screen, so their hints have to be
 *   too (user 2026-08-18).
 *
 * The string is read per render rather than captured once, because the
 * editor is built once per document and would otherwise keep whichever
 * language was active at that moment. Redrawing on a language change is
 * `LocaleRedraw`'s job — an attribute is only recomputed when something
 * dispatches, and switching language dispatches nothing.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { t } from '@breatic/shared';

/** Marks an editor whose document holds no blocks at all. */
export const DOCUMENT_BODY_EMPTY_CLASS = 'doc-body-empty';

/** The top-level blocks that paint nothing at all while they hold no text. */
const INVISIBLE_WHEN_EMPTY = new Set(['paragraph', 'heading']);

/**
 * Whether one top-level block paints nothing a reader could see: an empty
 * paragraph or heading, including one holding nothing but hard breaks —
 * a Shift+Enter line paints exactly as much as an empty one (user
 * 2026-08-18: the judgement is what the READER sees, not the node count).
 * @param child - The top-level block to judge.
 * @returns True when the block shows nothing.
 */
function paintsNothing(child: PMNode): boolean {
  if (!INVISIBLE_WHEN_EMPTY.has(child.type.name)) return false;
  let visible = false;
  child.content.forEach((inline) => {
    if (inline.type.name !== 'hardBreak') visible = true;
  });
  return !visible;
}

/**
 * Whether the document paints nothing a reader could see.
 * @param doc - The document node to judge.
 * @returns True for zero blocks, or nothing but invisible-when-empty blocks.
 */
function looksEmpty(doc: PMNode): boolean {
  for (let i = 0; i < doc.childCount; i += 1) {
    if (!paintsNothing(doc.child(i))) return false;
  }
  return true;
}

/**
 * The in-line hint on the first block of a looks-empty document.
 *
 * Where the hint draws follows the industry mechanism (tiptap's official
 * Placeholder decorates the empty node itself and paints through a zero-height
 * float): the FIRST invisible block carries the string, so the hint sits on
 * the line where typing will land. The zero-block state has no block to
 * decorate — the editor-level attribute below covers it, and index.css aligns
 * that hint to this same line position so the two states are visually
 * identical (user 2026-08-18).
 * @param state - The editor state to read.
 * @returns The decoration set, or null when the document has visible content
 *   or no blocks at all.
 */
function firstBlockHint(state: EditorState): DecorationSet | null {
  const { doc } = state;
  if (doc.childCount === 0 || !looksEmpty(doc)) return null;
  return DecorationSet.create(doc, [
    Decoration.node(0, doc.child(0).nodeSize, {
      'data-block-placeholder': t('spaces.document.placeholder'),
    }),
  ]);
}

/**
 * Draws the placeholder described at the top of this file.
 */
export const DocumentPlaceholders = Extension.create({
  name: 'documentPlaceholders',

  /**
   * Mark the empty document.
   * @returns The plugin carrying the mark.
   */
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('documentPlaceholders'),
        props: {
          attributes: (state): Record<string, string> =>
            state.doc.childCount === 0
              ? {
                class: DOCUMENT_BODY_EMPTY_CLASS,
                'data-body-placeholder': t('spaces.document.placeholder'),
              }
              : {},
          decorations: firstBlockHint,
        },
      }),
    ];
  },
});
