// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The editors of the text nodes being written in, kept by Space and node
 * (inner#1235 A13).
 *
 * A canvas whose Space is hidden has its nodes taken down by the canvas
 * library and put back when it is shown, and the component that owned an
 * editor goes with them. The caret and the undo history live on the editor
 * instance, so the instance is kept here and the component only shows it.
 * An editor ends when its node stops being written in, when its Space's tab
 * closes, or when the project is left.
 */

import type { Editor } from '@tiptap/core';

/** Every kept editor, by Space id and then node id. */
const editors = new Map<string, Map<string, Editor>>();

/**
 * The kept editor of a node, built on first use.
 * @param spaceId - The Space the node is on.
 * @param nodeId - The node.
 * @param build - Builds the editor when none is kept.
 * @returns The editor.
 */
export function textNodeEditor(
  spaceId: string,
  nodeId: string,
  build: () => Editor,
): Editor {
  let space = editors.get(spaceId);
  if (space === undefined) {
    space = new Map();
    editors.set(spaceId, space);
  }
  const kept = space.get(nodeId);
  if (kept !== undefined && !kept.isDestroyed) return kept;
  const editor = build();
  space.set(nodeId, editor);
  return editor;
}

/**
 * Ends a node's editor, when the node stops being written in.
 * @param spaceId - The Space the node is on.
 * @param nodeId - The node.
 */
export function endTextNodeEditor(spaceId: string, nodeId: string): void {
  const space = editors.get(spaceId);
  space?.get(nodeId)?.destroy();
  space?.delete(nodeId);
}

/**
 * Ends every editor a Space kept, when its tab closes.
 * @param spaceId - The Space.
 */
export function endSpaceTextNodeEditors(spaceId: string): void {
  editors.get(spaceId)?.forEach((editor) => editor.destroy());
  editors.delete(spaceId);
}

/** Ends every kept editor, when the project is left. */
export function endAllTextNodeEditors(): void {
  [...editors.keys()].forEach(endSpaceTextNodeEditors);
}
