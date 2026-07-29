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
  // Depend on the awareness instance, not on the object wrapping it, so that
  // neither effect below re-runs merely because a caller rebuilt its provider
  // wrapper. This buys tidiness, not safety: publishing presence never touches
  // the document at all — five `updateUser` calls produce zero Y.Doc
  // transactions and zero update bytes against five awareness updates, where a
  // single `insertContent` produces one transaction of 28 bytes.
  //
  // Focus does reach the document, by an unrelated route: any dispatch has
  // ProseMirror reconcile its view of the body against the fragment, and a
  // focus is a dispatch. What stops that write from destroying a redo stack is
  // `seedEmptyBody` in `document-yjs`, which removes the disagreement the write
  // would otherwise be reconciling.
  const awareness = caretProvider?.awareness ?? null;

  // Publish. Receivers dim on a literal `false` only, so a client that never
  // publishes the field simply renders normally.
  React.useEffect(() => {
    if (!editor || !awareness || !caretUser) return undefined;
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
  }, [editor, awareness, caretUser]);

  // Receive. A parked caret's widget is keyed by client id and prosemirror-view
  // reuses its DOM on key equality WITHOUT re-invoking the builder, so a
  // collaborator's focus flip never re-renders it. Toggle the class on the
  // existing DOM instead; freshly built widgets get it from the builder.
  React.useEffect(() => {
    const focusAwareness = awareness as FocusAwareness | null;
    if (!editor || !focusAwareness) return undefined;
    /** Syncs every rendered remote caret's dim class to its client's focus. */
    const applyDim = (): void => {
      if (editor.isDestroyed) return;
      const states = focusAwareness.getStates();
      editor.view.dom
        .querySelectorAll<HTMLElement>(
          '.collaboration-carets__caret[data-client-id]',
        )
        .forEach((el) => {
          const state = states.get(Number(el.dataset.clientId));
          el.classList.toggle(BLURRED_CLASS, state?.user?.focused === false);
        });
    };
    focusAwareness.on('change', applyDim);
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
      focusAwareness.off('change', applyDim);
    };
  }, [editor, awareness]);
}
