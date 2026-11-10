// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the editor area does around a table open full screen (breatic#1427
 * §5.3-§5.4): ends it on an Escape pressed outside the editor and when the
 * editor turns read-only, starts the body at the top on entry, and on the way
 * out scrolls back to where the plugin says the user came from.
 *
 * The scroll waits for a layout effect: the area is drawn as the body again in
 * the same commit, and a hidden Space runs no effects until it is shown.
 */

import * as React from 'react';

import { useEscapeInSpace } from '@web/spaces/canvas/use-escape-in-space';
import {
  clearFullscreenReturn,
  setTableFullscreen,
  type FullscreenReturn,
  type TableFullscreen,
} from '@web/spaces/document/document-table-fullscreen';
import type { HandleEditor } from '@web/spaces/document/document-handle-commands';
import { DOC_TABLE } from '@web/spaces/document/document-table-nodes';

/**
 * Scrolls the body back to where full screen was left from.
 * @param editor - The editor.
 * @param viewport - The body scroller.
 * @param to - Where to go.
 */
function scrollBack(editor: HandleEditor, viewport: HTMLElement, to: FullscreenReturn): void {
  const view = editor.prosemirrorView;
  if (view === undefined || view === null) return;
  const box = viewport.getBoundingClientRect();
  if (to.kind === 'scrollTop') {
    viewport.scrollTo({ top: to.value });
    return;
  }
  if (to.kind === 'table') {
    const element = editor.domElement?.querySelector(`[data-node-type="${DOC_TABLE}"][data-id="${to.id}"]`);
    if (!(element instanceof HTMLElement)) return;
    viewport.scrollTo({ top: viewport.scrollTop + element.getBoundingClientRect().top - box.top - to.offset });
    return;
  }
  // A write that ended full screen is shown where it starts; undo puts the
  // caret by what it took back.
  const caret = view.coordsAtPos(to.kind === 'write' && to.at !== null ? Math.min(to.at, view.state.doc.content.size) : view.state.selection.head);
  if (caret.top >= box.top && caret.bottom <= box.bottom) return;
  viewport.scrollTo({ top: viewport.scrollTop + caret.top - box.top - box.height / 2 });
}

/**
 * Runs the editor area's side of full screen.
 * @param editor - The editor.
 * @param fullscreen - Full screen as the plugin keeps it.
 * @param viewport - The body scroller, once mounted.
 * @param readOnly - Whether the editor is read-only.
 */
export function useTableFullscreenShell(
  editor: HandleEditor,
  fullscreen: TableFullscreen,
  viewport: HTMLElement | null,
  readOnly: boolean,
): void {
  const open = fullscreen.table !== null;
  const exit = React.useCallback(() => {
    setTableFullscreen(editor, null);
  }, [editor]);
  useEscapeInSpace(open, exit);

  // Only editors open a table full screen; one who stops being one leaves it.
  React.useEffect(() => {
    if (open && readOnly) exit();
  }, [open, readOnly, exit]);

  // The entry this area has started at the top. A Space shown again runs its
  // layout effects again and must leave a long table where the user was.
  const started = React.useRef<TableFullscreen | null>(null);
  React.useLayoutEffect(() => {
    if (viewport === null) return;
    if (fullscreen.table !== null) {
      if (started.current !== fullscreen) viewport.scrollTo({ top: 0 });
      started.current = fullscreen;
      return;
    }
    started.current = null;
    if (fullscreen.returnTo === null) return;
    scrollBack(editor, viewport, fullscreen.returnTo);
    clearFullscreenReturn(editor);
  }, [editor, viewport, fullscreen]);
}
