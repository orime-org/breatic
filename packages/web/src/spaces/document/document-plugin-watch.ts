// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Telling React about a plugin's state (#18).
 *
 * A plugin state changes on transactions the editor's own events never
 * report: a dispatch carrying nothing but a meta leaves the document and the
 * text selection where they were, so `onChange` and `onSelectionChange` both
 * stay quiet while the answer under them is different. The plugin's `view`
 * update sees every state change, meta-only ones included.
 *
 * IDENTITY IS THE WHOLE COMPARISON. Every `apply` behind one of these hands
 * the same object back while its answer has not changed, and that is what
 * makes `===` enough here — and what a new branch in one of those `apply`
 * functions has to keep doing.
 */

import type { EditorState, Plugin } from '@tiptap/pm/state';

/** A plugin state's broadcast, and the view that drives it. */
export interface PluginWatch<T> {
  /**
   * Hear about every change to this state.
   * @param listener - Called after any change.
   * @returns The function that stops it.
   */
  readonly onChange: (listener: () => void) => () => void;
  /**
   * The plugin `view` that fires those listeners.
   * @param after - Run with the new answer before the listeners, for a side
   *   that has to be in step with them.
   * @returns The view.
   */
  readonly viewWith: (
    after?: (now: T, state: EditorState) => void,
  ) => NonNullable<Plugin<T>['spec']['view']>;
}

/**
 * Builds a broadcast for one plugin's state.
 * @param read - Takes the state's answer out of an editor state.
 * @returns The subscribe function and the plugin view.
 */
export function watchPluginState<T>(
  read: (state: EditorState) => T,
): PluginWatch<T> {
  const listeners = new Set<() => void>();
  return {
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    viewWith: (after) => (view) => {
      let last = read(view.state);
      return {
        /**
         * Fires the listeners when the answer is not what it was.
         * @param updated - The view after the change.
         */
        update: (updated): void => {
          const now = read(updated.state);
          if (now === last) return;
          last = now;
          after?.(now, updated.state);
          listeners.forEach((listener) => {
            listener();
          });
        },
      };
    },
  };
}
