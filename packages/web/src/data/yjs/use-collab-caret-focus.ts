// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Dims a collaborator's caret while their window is in the background, so a
 * cursor sitting still reads as "they stepped away" rather than "they are
 * about to type".
 *
 * Both halves live here because either alone is dead weight: an editor that
 * publishes focus but never applies the incoming flag shows nothing, and one
 * that applies it but never publishes leaves its own caret looking permanently
 * attentive to everyone else.
 */

import type { Editor } from '@tiptap/react';
import * as React from 'react';

import type { CaretUserIdentity } from '@web/data/yjs/use-caret-user';

/** The slice of awareness this hook reads. */
interface FocusAwareness {
  getStates: () => Map<number, { user?: { focused?: boolean } }>;
  on: (event: string, fn: () => void) => void;
  off: (event: string, fn: () => void) => void;
}

/** Class the caret renderer looks for on a backgrounded collaborator. */
const BLURRED_CLASS = 'collaboration-carets__caret--blurred';

/**
 * Publish this window's focus, and dim the carets of collaborators who have
 * left theirs.
 * @param editor - The collaborative editor, or null before it mounts.
 * @param caretProvider - Provider whose awareness carries carets.
 * @param caretUser - This user's caret identity; focus is published alongside it.
 */
export function useCollabCaretFocus(
  editor: Editor | null,
  caretProvider: { awareness: unknown } | null | undefined,
  caretUser: CaretUserIdentity | null | undefined,
): void {
  // Publish. Receivers dim on a literal `false` only, so a client that never
  // publishes the field simply renders normally.
  React.useEffect(() => {
    if (!editor || !caretProvider || !caretUser) return undefined;
    /**
     * Publishes the current focus state into the awareness user field.
     * @param focused - Whether this window has focus.
     */
    const publish = (focused: boolean): void => {
      if (editor.isDestroyed) return;
      editor.commands.updateUser({ ...caretUser, focused });
    };
    /**
     * Publishes focused=true on window focus.
     * @returns Nothing.
     */
    const onFocus = (): void => publish(true);
    /**
     * Publishes focused=false on window blur.
     * @returns Nothing.
     */
    const onBlur = (): void => publish(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    // Seed the real state on mount — the editor can open in a background window.
    publish(document.hasFocus());
    return (): void => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, [editor, caretProvider, caretUser]);

  // Receive. A parked caret's widget is keyed by client id and prosemirror-view
  // reuses its DOM on key equality WITHOUT re-invoking the builder, so a
  // collaborator's focus flip never re-renders it. Toggle the class on the
  // existing DOM instead; freshly built widgets get it from the builder.
  React.useEffect(() => {
    const awareness = caretProvider?.awareness as
      | FocusAwareness
      | null
      | undefined;
    if (!editor || !awareness) return undefined;
    /** Syncs every rendered remote caret's dim class to its client's focus. */
    const applyDim = (): void => {
      if (editor.isDestroyed) return;
      const states = awareness.getStates();
      editor.view.dom
        .querySelectorAll<HTMLElement>(
          '.collaboration-carets__caret[data-client-id]',
        )
        .forEach((el) => {
          const state = states.get(Number(el.dataset.clientId));
          el.classList.toggle(BLURRED_CLASS, state?.user?.focused === false);
        });
    };
    awareness.on('change', applyDim);
    // This listener is the ONLY one needed. There used to be a second
    // subscription on `editor.on('transaction')`, guarding the window where the
    // cursor plugin's batched refresh had not run yet and the decorations still
    // carried thunks capturing the pre-flip user. Under @tiptap/y-tiptap 3.0.8
    // no transaction reaches that window any more — its yCursorPlugin.apply has
    // exactly four outcomes, and none rebuilds a widget from a stale thunk:
    //   local structural edit   → DecorationSet.empty, so there is no caret
    //   remote / awareness bump → decorations rebuilt, builder reads the
    //                             CURRENT awareness, so the class is right
    //   local non-structural    → prevState.map() keeps them, and the widget is
    //                             keyed by client id so prosemirror-view reuses
    //                             the same DOM node without re-invoking the
    //                             builder (measured: insert before / after / at
    //                             the caret and delete around it all keep both
    //                             the node identity and the class)
    //   anything else           → prevState untouched
    applyDim();
    return (): void => {
      awareness.off('change', applyDim);
    };
  }, [editor, caretProvider]);
}
