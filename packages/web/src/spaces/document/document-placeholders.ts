// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The document's two placeholders: one for an unnamed title, one for a body
 * nobody has written in.
 *
 * ## Why not the placeholder extension every other editor uses
 *
 * It decorates textblocks that EXIST in the document, and by default only the
 * one holding the caret. Neither fits this document. A body with no blocks has
 * nothing to decorate, so its placeholder could never be drawn at all; and a
 * fresh document wants both placeholders at once, which one decoration cannot
 * do. Both are properties of the installed version rather than guesses:
 * `@tiptap/extensions` skips anything that is not a textblock, and ships
 * `showOnlyCurrent: true` / `includeChildren: false`.
 *
 * The rule that extension relies on in the stylesheet is left exactly as it
 * is — the generate prompt still uses it. This document simply stops
 * depending on it.
 *
 * ## What this does instead
 *
 * Marks the two states and lets the stylesheet draw the text: a class on the
 * title when it has no text, a class on the editor when the body has no
 * blocks, each with the string to show alongside it.
 *
 * The strings are read per decoration rather than captured once, because the
 * editor is built once per document and would otherwise keep whichever
 * language was active at that moment. Redrawing on a language change is
 * `LocaleRedraw`'s job — a decoration is only rebuilt when something
 * dispatches, and switching language dispatches nothing.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { DOCUMENT_TITLE_NODE, t } from '@breatic/shared';

/** Marks a title with no text in it. */
export const DOCUMENT_TITLE_EMPTY_CLASS = 'doc-title-empty';

/** Marks an editor whose body holds no blocks. */
export const DOCUMENT_BODY_EMPTY_CLASS = 'doc-body-empty';

/**
 * Draws the two placeholders described at the top of this file.
 */
export const DocumentPlaceholders = Extension.create({
  name: 'documentPlaceholders',

  /**
   * Mark the empty title and the empty body.
   * @returns The plugin carrying both marks.
   */
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('documentPlaceholders'),
        props: {
          attributes: (state): Record<string, string> =>
            state.doc.childCount > 1
              ? {}
              : {
                class: DOCUMENT_BODY_EMPTY_CLASS,
                'data-body-placeholder': t('spaces.document.placeholder'),
              },
          decorations: (state) => {
            const title = state.doc.firstChild;
            if (
              !title ||
              title.type.name !== DOCUMENT_TITLE_NODE ||
              title.content.size > 0
            ) {
              return DecorationSet.empty;
            }
            return DecorationSet.create(state.doc, [
              Decoration.node(0, title.nodeSize, {
                class: DOCUMENT_TITLE_EMPTY_CLASS,
                'data-placeholder': t('spaces.document.titlePlaceholder'),
              }),
            ]);
          },
        },
      }),
    ];
  },
});
