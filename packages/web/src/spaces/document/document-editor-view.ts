// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Asking a document editor for its view, safely.
 *
 * An editor that has been unmounted answers every route to its view by raising
 * rather than by returning nothing: `prosemirrorView` reaches tiptap's own
 * accessor, which throws on the first property read
 * (`@tiptap/core/src/Editor.ts:347`). The wrapper offers no flag to ask first.
 *
 * The overlays that sit above the body — the selection bar, the link panel —
 * can outlive the editor by a frame, because closing a tab evicts the editor
 * (which IS the teardown, see `document-editor-cache`) while their own effects
 * belong to components further up and have not been cleaned up yet. So they ask
 * through here.
 */

import type { BlockNoteEditor } from '@blocknote/core';
import type { EditorView } from '@tiptap/pm/view';

/** A document editor, as far as these two questions need to know. */
export type ViewedEditor = BlockNoteEditor<never, never, never>;

/**
 * The editor's view, or null once it has been unmounted.
 * @param editor - The editor to ask.
 * @returns The view, or null.
 */
export function viewOf(editor: ViewedEditor): EditorView | null {
  try {
    return editor.prosemirrorView ?? null;
  } catch {
    return null;
  }
}

/**
 * The editable element, or null once the editor has been unmounted.
 * @param editor - The editor to ask.
 * @returns The element, or null.
 */
export function domElementOf(editor: ViewedEditor): HTMLElement | null {
  return viewOf(editor)?.dom ?? null;
}
