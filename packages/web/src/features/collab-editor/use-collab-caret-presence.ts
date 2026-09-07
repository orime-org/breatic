// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Keeps this client's caret PRESENCE published, and applies everyone else's.
 *
 * Presence is what a caret says about the moment rather than about the person:
 * whether your window is in the foreground, so a cursor sitting still reads as
 * "they stepped away" rather than "they are about to type". Both halves live
 * here because either alone is dead weight: an editor that publishes but never
 * applies the incoming flag shows nothing, and one that applies but never
 * publishes leaves its own caret looking permanently attentive to everyone
 * else.
 *
 * ## Identity is NOT published — the server writes it
 *
 * This used to be the file that kept a renamed user's caret current, by
 * re-publishing the whole identity whenever it changed. It had to: the caret
 * extension takes its `user` at construction and the editor is built once per
 * document (it survives Space-tab switches by design), so a name baked in at
 * construction would stay frozen for the session.
 *
 * #1882 removed most of the need: peers resolve the display name from the
 * project member roster and derive the colour from the id, so a rename needs no
 * re-publish. #1886 removed the rest. The id is not ours to state either — the
 * server already resolved this connection's user from the credential it
 * validated at the handshake, and it writes that id onto every awareness entry
 * belonging to the connection. So this hook publishes one field, focus, and the
 * `user` field it lands in is the server's from then on.
 *
 * ## Why both effects below write to the DOM directly
 *
 * A caret that is not moving is never rebuilt — prosemirror-view keys the
 * widget on the client id and reuses its DOM on key equality WITHOUT
 * re-invoking the builder. So neither a focus flip nor a name arriving late
 * reaches the builder, and both have to be written onto the element found by
 * the `data-client-id` the builder stamps. The focus half learned this the
 * hard way (an adversarial round found both flip directions dead); the name
 * half is the same lesson applied before it could bite.
 */

import * as React from 'react';

import { applyCaretName } from '@web/features/collab-editor/caret-render';
import { useCollaboratorNames } from '@web/features/collab-editor/collaborator-names-context';

/** The slice of awareness this hook reads. */
interface FocusAwareness {
  getStates: () => Map<number, { user?: { focused?: boolean; id?: string } }>;
  on: (event: string, fn: () => void) => void;
  off: (event: string, fn: () => void) => void;
}

/** The slice of awareness this hook writes. */
interface PresenceAwareness {
  setLocalStateField: (field: string, value: unknown) => void;
}

/**
 * An editor this hook can find carets in.
 *
 * The two shapes are the two editors in the repository: `@tiptap/react`'s,
 * which reports its own death and keeps its view under `view`, and BlockNote's,
 * which has no such flag and keeps it under `prosemirrorView`, absent until the
 * editor is mounted.
 */
export type CollabCaretEditor =
  | { readonly isDestroyed: boolean; readonly view: { readonly dom: HTMLElement } }
  // Declared present-but-possibly-undefined rather than optional, so that an
  // `in` check narrows the union in BOTH directions: against an optional
  // property, the branch where it is absent cannot rule the member out.
  | { readonly prosemirrorView: { readonly dom: HTMLElement } | undefined };

/**
 * The element remote carets are drawn into.
 *
 * A BlockNote editor answers this question by THROWING once it has been
 * unmounted: every route to its view ends at tiptap's `view` accessor, which
 * raises rather than returning nothing (`@tiptap/core/src/Editor.ts:347`), and
 * the wrapper offers no flag to ask first. That window is an ordinary Space-tab
 * switch — the body unmounts the editor while the hook's own effects, which
 * belong to a component further up, have not been cleaned up yet, so an
 * awareness event arriving in between lands here.
 * @param editor - The editor to look in.
 * @returns That element, or null when this editor has none right now.
 */
function caretHost(editor: CollabCaretEditor): HTMLElement | null {
  if ('prosemirrorView' in editor) {
    try {
      return editor.prosemirrorView?.dom ?? null;
    } catch {
      return null;
    }
  }
  return editor.isDestroyed ? null : editor.view.dom;
}

/** Class the caret renderer looks for on a backgrounded collaborator. */
const BLURRED_CLASS = 'collaboration-carets__caret--blurred';

/**
 * Publish this window's focus, dim the carets of collaborators who have left
 * theirs, and keep every rendered caret's name in step with the roster.
 * The roster comes from context rather than from an argument. It is a
 * project-level fact and every editor wants the same one, so making it a
 * parameter meant each layer between the project page and the editor writing a
 * line to pass it along — lines that were optional, and whose absence nothing
 * reported. Three rounds of adversarial review found four places where cutting
 * one left types, lint and the whole suite green while every remote caret lost
 * its name (#1882). Carets render as bare colour lines with no provider above
 * them, which is also the honest answer while the roster is still loading.
 * @param editor - The collaborative editor, or null before it mounts.
 * @param caretProvider - Provider whose awareness carries carets.
 */
export function useCollabCaretPresence(
  editor: CollabCaretEditor | null,
  caretProvider: { awareness: unknown } | null | undefined,
): void {
  const names = useCollaboratorNames();
  // Depend on the awareness instance, not on the object wrapping it, so that
  // neither effect below re-runs merely because a caller rebuilt its provider
  // wrapper.
  //
  // Publishing presence writes NOTHING to the document, and nothing to the
  // editor either: the field goes straight onto awareness, which is where both
  // editors' `updateUser` commands put it and all either of them does
  // (`extension-collaboration-caret/dist/index.js:61-64`,
  // `@blocknote/core/dist/yjs.js:132-134`). Measured at five focus flips
  // through the command: zero document updates, zero update bytes, against
  // five awareness updates.
  const awareness = caretProvider?.awareness ?? null;

  // Publish. Receivers dim on a literal `false` only, so a client that never
  // publishes the field simply renders normally.
  React.useEffect(() => {
    const presence = awareness as PresenceAwareness | null;
    // Gated on there being an editor even though publishing no longer needs
    // one: presence describes a window someone is reading a document in, and
    // before the editor exists there is nothing to read.
    if (!editor || !presence) return undefined;
    /**
     * Publishes the current focus state into the awareness user field.
     * @param focused - Whether this window has focus.
     */
    const publish = (focused: boolean): void => {
      // Focus is the only thing we put here. Who this caret belongs to is
      // written by the server from the credential this connection presented,
      // so sending an id would at best be ignored and at worst be a claim we
      // have no standing to make (#1886).
      presence.setLocalStateField('user', { focused });
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
      // Withdraw the caret. The editor is NOT destroyed when this unmounts —
      // it is cached per document and survives a Space-tab switch — so the
      // cursor plugin never gets its own teardown, and everyone else would go
      // on seeing this client parked where they left off, indefinitely.
      presence.setLocalStateField('cursor', null);
    };
  }, [editor, awareness]);

  // Receive. A parked caret's widget is keyed by client id and prosemirror-view
  // reuses its DOM on key equality WITHOUT re-invoking the builder, so a
  // collaborator's focus flip never re-renders it. Toggle the class on the
  // existing DOM instead; freshly built widgets get it from the builder.
  React.useEffect(() => {
    const focusAwareness = awareness as FocusAwareness | null;
    if (!editor || !focusAwareness) return undefined;
    /** Syncs every rendered remote caret's dim class to its client's focus. */
    const applyDim = (): void => {
      const host = caretHost(editor);
      if (!host) return;
      const states = focusAwareness.getStates();
      host
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

  // Names. Same problem as the dim above, same shape of fix: a caret sitting
  // still is never rebuilt, so a name that resolves after it was drawn has to
  // be written onto the existing DOM. This runs both when the roster changes
  // (a rename, a re-fetch landing) and when awareness changes (a peer whose
  // caret was just built by a builder that could not name them).
  React.useEffect(() => {
    const nameAwareness = awareness as FocusAwareness | null;
    if (!editor || !nameAwareness || !names) return undefined;
    const { resolve } = names;
    /** Re-derives every rendered caret's label from the current roster. */
    const applyNames = (): void => {
      const host = caretHost(editor);
      if (!host) return;
      const states = nameAwareness.getStates();
      host
        .querySelectorAll<HTMLElement>(
          '.collaboration-carets__caret[data-client-id]',
        )
        .forEach((el) => {
          const state = states.get(Number(el.dataset.clientId));
          const userId = state?.user?.id;
          // No id means the peer is gone from awareness — there is nothing to
          // resolve, and clearing the label would only strip a name off a
          // caret that is still on screen waiting to be swept.
          if (typeof userId !== 'string') return;
          applyCaretName(el, resolve(userId), el.style.borderColor);
        });
    };
    nameAwareness.on('change', applyNames);
    applyNames();
    return (): void => {
      nameAwareness.off('change', applyNames);
    };
  }, [editor, awareness, names]);
}
