// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
 * Marks the empty state and lets the stylesheet draw the text: a class on the
 * editor when the document has no blocks, with the string to show alongside
 * it.
 *
 * The string is read per render rather than captured once, because the
 * editor is built once per document and would otherwise keep whichever
 * language was active at that moment. Redrawing on a language change is
 * `LocaleRedraw`'s job — an attribute is only recomputed when something
 * dispatches, and switching language dispatches nothing.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { t } from '@breatic/shared';

/** Marks an editor whose document shows nothing a reader could see. */
export const DOCUMENT_BODY_EMPTY_CLASS = 'doc-body-empty';

/** The top-level blocks that paint nothing at all while they hold no text. */
const INVISIBLE_WHEN_EMPTY = new Set(['paragraph', 'heading']);

/**
 * Whether the document paints nothing a reader could see.
 * @param doc - The document node to judge.
 * @returns True for zero blocks, or nothing but empty paragraphs and headings.
 */
function looksEmpty(doc: PMNode): boolean {
  for (let i = 0; i < doc.childCount; i += 1) {
    const child = doc.child(i);
    if (!INVISIBLE_WHEN_EMPTY.has(child.type.name)) return false;
    if (child.content.size > 0) return false;
  }
  return true;
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
            looksEmpty(state.doc)
              ? {
                class: DOCUMENT_BODY_EMPTY_CLASS,
                'data-body-placeholder': t('spaces.document.placeholder'),
              }
              : {},
        },
      }),
    ];
  },
});
