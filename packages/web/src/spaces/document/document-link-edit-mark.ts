// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Draws one link as selected, for the toolbar's field to say which link it is
 * changing.
 *
 * `ShowSelectionExtension` — which the panel over a selection uses — draws
 * whatever the document selection covers, and the toolbar cannot use it: the
 * two ways into the toolbar leave the selection elsewhere, and putting it over
 * the link makes `getLinkAtSelection` answer with nothing
 * (`@blocknote/core/src/extensions/LinkToolbar/LinkToolbar.ts:41`), which the
 * controller answers by taking the toolbar off the screen.
 *
 * What is held is the handle from `document-link-tracking.ts`, resolved afresh
 * every time the decorations are read, so the span follows the link through a
 * co-editor's writing — the same mechanism the panel holds its link with, and
 * for the reason written down there: a remote update arrives as one step
 * spanning the whole document, so a span carried through `tr.mapping` collapses.
 *
 * The resolved span is then narrowed back to the link inside it, the step the
 * panel takes too. The handle's end names the character that followed the link
 * when it was taken, so text a peer writes at that boundary falls inside the
 * span while carrying no link of its own.
 *
 * The decoration wears `data-show-selection`, the attribute BlockNote's
 * stylesheet paints, so both faces are drawn by one rule.
 */

import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import {
  resolveTrackedSpan,
  type TrackedLink,
} from '@web/spaces/document/document-link-tracking';
import { resolveLinkInSpan } from '@web/spaces/document/document-link';

/** What is drawn: one tracked link, or nothing. */
type DrawnLink = TrackedLink | null;

/** The plugin key, so a caller can address what is drawn. */
const LINK_EDIT_MARK_KEY = new PluginKey<DrawnLink>('documentLinkEditMark');

/**
 * The extension that draws the link, for the assembly to register.
 * @returns The extension.
 */
export const documentLinkEditMarkExtension = createExtension(() => ({
  key: 'document-link-edit-mark',
  prosemirrorPlugins: [
    new Plugin<DrawnLink>({
      key: LINK_EDIT_MARK_KEY,
      state: {
        /**
         * Nothing is drawn until a caller asks for a link.
         * @returns No link.
         */
        init: (): DrawnLink => null,
        /**
         * Takes a new link from the transaction, and otherwise keeps the one
         * it holds — the handle names a place in the shared structure, so it
         * needs no mapping.
         * @param tr - The transaction.
         * @param current - The link as it stood.
         * @returns The link to draw from here on.
         */
        apply: (tr: Transaction, current: DrawnLink): DrawnLink => {
          const asked = tr.getMeta(LINK_EDIT_MARK_KEY) as DrawnLink | undefined;
          return asked === undefined ? current : asked;
        },
      },
      props: {
        /**
         * The link, drawn as the selection is drawn.
         * @param state - The editor state to resolve against.
         * @returns The decorations, empty when there is no link to draw or its
         *   text has gone.
         */
        decorations: (state: EditorState): DecorationSet => {
          const tracked = LINK_EDIT_MARK_KEY.getState(state);
          if (!tracked) return DecorationSet.empty;
          const span = resolveTrackedSpan(state, tracked);
          if (!span) return DecorationSet.empty;
          const { range } = resolveLinkInSpan(state, span.from, span.to);
          if (!range) return DecorationSet.empty;
          return DecorationSet.create(state.doc, [
            Decoration.inline(range.from, range.to, {
              'data-show-selection': 'true',
            }),
          ]);
        },
      },
    }),
  ],
}) as never);

/**
 * Ask for a link to be drawn as selected, or for none.
 * @param view - The editor view to write to.
 * @param tracked - The handle to draw, or null to stop drawing.
 */
export function showLinkEditSpan(
  view: { state: EditorState; dispatch: (tr: Transaction) => void } | undefined,
  tracked: DrawnLink,
): void {
  if (!view) return;
  view.dispatch(view.state.tr.setMeta(LINK_EDIT_MARK_KEY, tracked));
}
