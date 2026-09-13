// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Draws one span of the body as selected, for the toolbar's field to say which
 * link it is changing.
 *
 * `ShowSelectionExtension` — which the panel over a selection uses — draws
 * whatever the document selection covers, and the toolbar cannot use it: the
 * two ways into the toolbar leave the selection elsewhere, and putting it over
 * the link makes `getLinkAtSelection` answer with nothing
 * (`@blocknote/core/src/extensions/LinkToolbar/LinkToolbar.ts:41`), which the
 * controller answers by taking the toolbar off the screen.
 *
 * So the span is carried in the plugin's own state and the selection is never
 * touched. The decoration wears `data-show-selection`, the attribute
 * BlockNote's stylesheet paints, so both faces are drawn by one rule.
 */

import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/** The span to draw, or null for none. */
export type LinkEditSpan = { from: number; to: number } | null;

/** The plugin key, so a caller can address the span. */
const LINK_EDIT_MARK_KEY = new PluginKey<LinkEditSpan>('documentLinkEditMark');

/**
 * The extension that draws the span, for the assembly to register.
 * @returns The extension.
 */
export const documentLinkEditMarkExtension = createExtension(() => ({
  key: 'document-link-edit-mark',
  prosemirrorPlugins: [
    new Plugin<LinkEditSpan>({
      key: LINK_EDIT_MARK_KEY,
      state: {
        /**
         * Nothing is drawn until a caller asks for a span.
         * @returns The empty span.
         */
        init: (): LinkEditSpan => null,
        /**
         * Takes a new span from the transaction, and maps the standing one
         * through whatever the transaction did to the document — a co-editor
         * typing ahead of the link moves the span with it.
         * @param tr - The transaction.
         * @param current - The span as it stood.
         * @returns The span to draw from here on.
         */
        apply: (tr: Transaction, current: LinkEditSpan): LinkEditSpan => {
          const asked = tr.getMeta(LINK_EDIT_MARK_KEY) as
            | LinkEditSpan
            | undefined;
          if (asked !== undefined) return asked;
          if (current === null) return null;
          const from = tr.mapping.map(current.from);
          const to = tr.mapping.map(current.to);
          return to > from ? { from, to } : null;
        },
      },
      props: {
        /**
         * The span, drawn as the selection is drawn.
         * @param state - The editor state to read the span from.
         * @returns The decorations, empty when no span is set.
         */
        decorations: (state: EditorState): DecorationSet => {
          const span = LINK_EDIT_MARK_KEY.getState(state);
          if (!span) return DecorationSet.empty;
          return DecorationSet.create(state.doc, [
            Decoration.inline(span.from, span.to, {
              'data-show-selection': 'true',
            }),
          ]);
        },
      },
    }),
  ],
}) as never);

/**
 * Ask for a span to be drawn as selected, or for none.
 * @param view - The editor view to write to.
 * @param span - The span, or null to stop drawing.
 */
export function showLinkEditSpan(
  view: { state: EditorState; dispatch: (tr: Transaction) => void } | undefined,
  span: LinkEditSpan,
): void {
  if (!view) return;
  view.dispatch(view.state.tr.setMeta(LINK_EDIT_MARK_KEY, span));
}
