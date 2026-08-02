// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Redraws the editor's decorations when the app language changes.
 *
 * Decorations — the empty-document placeholder, for one — are recomputed only
 * when something dispatches to the editor. A language switch dispatches
 * nothing, so whatever was drawn last stays on screen in the old language until
 * the user happens to click into the body or type.
 *
 * Why this editor needs an extension where the canvas prompt editor does not:
 * that one takes its placeholder as a prop and is REBUILT when the prop
 * changes. This one cannot be rebuilt — `document-editor-cache` exists so the
 * editor, its undo stack and its selection survive a Space-tab switch — so the
 * language has to reach inside a living editor.
 *
 * The dispatch is deliberately empty: it changes no content, produces no update
 * bytes, and is marked `addToHistory: false` so it cannot land on anyone's undo
 * stack. It does open one empty Y.Doc transaction, the same way publishing
 * caret focus does; see `features/collab-editor/use-collab-caret-presence` for
 * why that is harmless here and what keeps it so.
 */

import { Extension } from '@tiptap/core';

import { onLocaleChange } from '@breatic/shared';

interface LocaleRedrawStorage {
  /** Detaches the locale subscription; null before `onCreate`. */
  stopListening: (() => void) | null;
}

export const LocaleRedraw = Extension.create<
  Record<string, never>,
  LocaleRedrawStorage
>({
  name: 'localeRedraw',

  /**
   * Starts with nothing to detach.
   * @returns The extension's initial storage.
   */
  addStorage(): LocaleRedrawStorage {
    return { stopListening: null };
  },

  /**
   * Subscribes to locale changes for this editor's lifetime.
   * @throws {never}
   */
  onCreate(): void {
    this.storage.stopListening = onLocaleChange(() => {
      const { view } = this.editor;
      if (this.editor.isDestroyed) return;
      view.dispatch(view.state.tr.setMeta('addToHistory', false));
    });
  },

  /**
   * Detaches the subscription — the editor outlives the component that built
   * it, so this is the only point at which it is known to be over.
   * @throws {never}
   */
  onDestroy(): void {
    this.storage.stopListening?.();
    this.storage.stopListening = null;
  },
});
