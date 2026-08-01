// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Keeps this client's caret PRESENCE published, and applies everyone else's.
 *
 * Presence is the whole awareness payload behind a caret: who you are — name
 * and colour — and whether your window is in the foreground, so a cursor
 * sitting still reads as "they stepped away" rather than "they are about to
 * type". Both halves live here because either alone is dead weight: an editor
 * that publishes but never applies the incoming flag shows nothing, and one
 * that applies but never publishes leaves its own caret looking permanently
 * attentive to everyone else.
 *
 * ## Identity is published here, not baked into the editor
 *
 * The caret extension takes a `user` at construction, and the editor is
 * constructed ONCE per document — it survives Space-tab switches by design, and
 * a rebuild with a new identity would take the undo stack and selection with
 * it. So the identity configured on the extension is only ever the one that was
 * current when the document was first opened. If the user renames themselves,
 * or their derived colour changes, that configured value is stale for the rest
 * of the session.
 *
 * This hook is what keeps it true: it publishes the FULL identity on every
 * change, not just the focus flag, which overwrites the awareness field the
 * extension seeded. That makes `caretUser` in the publish effect's dependencies
 * load-bearing rather than incidental — narrow that list to the focus flag and
 * collaborators will see a stale name for as long as the tab stays open, with
 * every test still green unless one pins this.
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
export function useCollabCaretPresence(
  editor: Editor | null,
  caretProvider: { awareness: unknown } | null | undefined,
  caretUser: CaretUserIdentity | null | undefined,
): void {
  // Depend on the awareness instance, not on the object wrapping it, so that
  // neither effect below re-runs merely because a caller rebuilt its provider
  // wrapper. This buys tidiness, not safety, and the reason is worth stating
  // precisely because it is easy to state too strongly:
  //
  // Publishing presence writes NOTHING to the document — measured at five focus
  // flips: zero updates, zero update bytes, against five awareness updates.
  // It does not follow that the document is untouched. `updateUser` is an
  // editor command, so each call dispatches, and every dispatch has ProseMirror
  // reconcile its view of the body against the fragment inside a Y.Doc
  // transaction. Same measurement: six transactions, all of them empty.
  //
  // Empty is not the same as inert. `beforeTransaction` / `afterTransaction`
  // fire regardless, and `CollabUndoSelection` listens to them. What keeps the
  // reconciliation itself harmless is `seedEmptyBody` in `document-yjs`, which
  // removes the layer disagreement the write would otherwise be resolving —
  // without it, a reconciliation after an undo destroys the redo stack.
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
