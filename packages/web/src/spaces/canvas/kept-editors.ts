// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The canvas editors kept across a hidden Space, by Space and key
 * (inner#1235 A13).
 *
 * A canvas whose Space is hidden has its nodes and their panels taken down by
 * the canvas library and put back when it is shown, and the component that
 * owned an editor goes with them. The caret and the undo history live on the
 * editor instance, so the instance is kept here and the component only shows
 * it. Each owner ends its editor when what it was for ends — a text node
 * stops being written in, a panel closes — and a closed tab or a left project
 * ends them all.
 */

import type { Editor } from '@tiptap/core';

/** Every kept editor, by Space id and then key. */
const editors = new Map<string, Map<string, Editor>>();

/**
 * The kept editor under a key, built on first use.
 * @param spaceId - The Space the editor is on.
 * @param key - What the editor is for, unique within the Space.
 * @param build - Builds the editor when none is kept, or the kept one no
 *   longer fits.
 * @param fits - Whether a kept editor still fits what the caller has now.
 * @returns The editor.
 */
export function keptEditor(
  spaceId: string,
  key: string,
  build: () => Editor,
  fits: (kept: Editor) => boolean = () => true,
): Editor {
  let space = editors.get(spaceId);
  if (space === undefined) {
    space = new Map();
    editors.set(spaceId, space);
  }
  const kept = space.get(key);
  if (kept !== undefined && !kept.isDestroyed && fits(kept)) return kept;
  kept?.destroy();
  const editor = build();
  space.set(key, editor);
  return editor;
}

/**
 * Ends the editor under a key, when what it was for ends.
 * @param spaceId - The Space the editor is on.
 * @param key - What the editor is for.
 */
export function endKeptEditor(spaceId: string, key: string): void {
  const space = editors.get(spaceId);
  space?.get(key)?.destroy();
  space?.delete(key);
}

/**
 * Ends every editor a Space kept, when its tab closes.
 * @param spaceId - The Space.
 */
export function endSpaceKeptEditors(spaceId: string): void {
  editors.get(spaceId)?.forEach((editor) => editor.destroy());
  editors.delete(spaceId);
}

/** Ends every kept editor, when the project is left. */
export function endAllKeptEditors(): void {
  [...editors.keys()].forEach(endSpaceKeptEditors);
}
