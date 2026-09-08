// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Redraws the editor's decorations when the app language changes.
 *
 * Decorations — the "start writing" hint, for one — are recomputed only when
 * something dispatches to the editor. A language switch dispatches nothing, so
 * whatever was drawn last stays on screen in the old language until the user
 * happens to click into the body or type.
 *
 * Why this editor needs it where the canvas prompt editor does not: that one
 * takes its placeholder as a prop and is REBUILT when the prop changes. This
 * one cannot be rebuilt — `document-editor-cache` exists so the editor, its
 * undo stack and its selection survive a Space-tab switch — so the language has
 * to reach inside a living editor.
 *
 * The dispatch is deliberately empty: it changes no content, produces no update
 * bytes, and is marked `addToHistory: false` so it cannot land on anyone's undo
 * stack.
 */

import { createExtension, type ExtensionFactoryInstance } from '@blocknote/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

import { onLocaleChange } from '@breatic/shared';

/**
 * Builds the extension that asks for the redraw.
 * @returns The extension, for the assembly to register.
 */
export function documentLocaleRedrawExtension(): ExtensionFactoryInstance {
  return createExtension(() => ({
    key: 'documentLocaleRedraw',
    prosemirrorPlugins: [
      new Plugin({
        key: new PluginKey('documentLocaleRedraw'),
        /**
         * Subscribes for as long as this view lives.
         *
         * The plugin view's own teardown is what bounds the subscription, so
         * the language can never reach a view that has gone.
         * @param view - The editor view.
         * @returns The plugin view, whose destroy detaches the listener.
         */
        view: (view) => {
          const stopListening = onLocaleChange(() => {
            view.dispatch(view.state.tr.setMeta('addToHistory', false));
          });
          return {
            /** Detaches the listener. */
            destroy: (): void => {
              stopListening();
            },
          };
        },
      }),
    ],
  }) as never)();
}
