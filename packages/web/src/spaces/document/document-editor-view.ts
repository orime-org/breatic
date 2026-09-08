// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Asking a document editor whether it has a view on screen.
 *
 * The overlays that sit above the body — the selection bar, the link panel —
 * can outlive the editor's mount by a frame, because closing a tab evicts the
 * editor (which IS the teardown, see `document-editor-cache`) while their own
 * effects belong to components further up and have not been cleaned up yet.
 * They ask through here rather than reaching for `prosemirrorView` themselves.
 *
 * Measured across the three states an editor can be in, reading
 * `prosemirrorView` is not the question:
 *
 * ```
 *                  prosemirrorView   .dom      .state
 * before mounting  an object         throws    ok
 * mounted          an object         ok        ok
 * after unmount    an object         throws    ok
 * ```
 *
 * The getter hands back an object in all three, so a `try` around it alone
 * answers "yes" for an editor with nothing on screen. What separates them is
 * `dom`, which reaches tiptap's own accessor and raises there
 * (`@tiptap/core/src/Editor.ts:347`). That property is therefore what gets
 * touched, and both states with no view on screen come back null — which is
 * the answer an overlay wants from either: it has nothing to anchor to.
 */

import type { BlockNoteEditor } from '@blocknote/core';
import type { EditorView } from '@tiptap/pm/view';

/** A document editor, as far as these two questions need to know. */
export type ViewedEditor = BlockNoteEditor<never, never, never>;

/**
 * The editor's view, or null when it has none on screen.
 * @param editor - The editor to ask.
 * @returns The view, or null.
 */
export function viewOf(editor: ViewedEditor): EditorView | null {
  const view = editor.prosemirrorView;
  if (view === undefined) return null;
  try {
    // Touched rather than returned: reading it is the whole test.
    void view.dom;
  } catch {
    return null;
  }
  return view;
}

/**
 * The editable element, or null when the editor has none on screen.
 * @param editor - The editor to ask.
 * @returns The element, or null.
 */
export function domElementOf(editor: ViewedEditor): HTMLElement | null {
  return viewOf(editor)?.dom ?? null;
}
