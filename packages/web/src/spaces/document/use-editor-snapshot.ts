// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reads a derived value off a living editor, and redraws when it moves.
 *
 * Every control on the bubble bar is this shape: look at the editor, derive
 * something small, follow it. The editor reports a document change and a
 * selection change separately and the controls depend on both — what a control
 * offers follows the content, whether it is ticked follows the selection.
 *
 * What the controls derive is rarely a scalar. Which rows are ticked and which
 * are out of reach are both sets, rebuilt on every read, and handing those
 * straight to React would report a change every time it was asked. So the value
 * is compared against the last one and the previous kept where they match.
 * Choosing the comparison is the caller's: a boolean wants identity, a set
 * wants membership.
 */

import * as React from 'react';
import type { BlockNoteEditor } from '@blocknote/core';

/** The editor these readers look at. */
export type SnapshotEditor = BlockNoteEditor<never, never, never>;

/**
 * Calls back whenever anything read off the editor may have moved.
 *
 * The editor reports a document change and a selection change separately, and
 * every reader here depends on both: what a control offers follows the
 * content, where it sits follows the selection.
 * @param editor - The editor to watch.
 * @param react - What to run.
 * @returns Unsubscribe.
 */
export function onEditorSettled(
  editor: SnapshotEditor,
  react: () => void,
): () => void {
  const stopChange = editor.onChange(react);
  const stopSelection = editor.onSelectionChange(react);
  return () => {
    stopChange?.();
    stopSelection();
  };
}

/**
 * Follows a value derived from the editor.
 * @param editor - The editor to watch.
 * @param read - Derives the value. Called on every render and on every change.
 * @param isEqual - Whether two readings mean the same thing. Identity by
 *   default, which is right for scalars and wrong for anything rebuilt per
 *   read.
 * @returns The latest value, stable while `isEqual` says nothing moved.
 */
export function useEditorSnapshot<T>(
  editor: SnapshotEditor,
  read: (editor: SnapshotEditor) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const subscribe = React.useCallback(
    (onStoreChange: () => void) => onEditorSettled(editor, onStoreChange),
    [editor],
  );

  // Held in a ref rather than in state: `useSyncExternalStore` calls the
  // snapshot during render and requires the same object back while nothing has
  // moved, so the cache has to be written during that call.
  const cache = React.useRef<{ value: T } | null>(null);
  const latest = React.useRef({ read, isEqual });
  latest.current = { read, isEqual };

  const snapshot = React.useCallback((): T => {
    const next = latest.current.read(editor);
    const held = cache.current;
    if (held !== null && latest.current.isEqual(held.value, next)) {
      return held.value;
    }
    cache.current = { value: next };
    return next;
  }, [editor]);

  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}
