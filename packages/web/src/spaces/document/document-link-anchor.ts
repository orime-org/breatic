// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What floating-ui measures a link control against.
 *
 * Both link controls hang off a span of the document — the panel off the text
 * a link is being put on, the toolbar off the link it opened over — and both
 * need the same thing from it: a live rectangle that follows the text through
 * a reflow, a peer's writing, and the focus leaving.
 */

import type { ReferenceType } from '@floating-ui/react';

import { viewOf, type ViewedEditor } from '@web/spaces/document/document-editor-view';
import type { LinkRange } from '@web/spaces/document/document-link';

/**
 * What floating-ui measures a control against.
 *
 * A DOM Range over the target itself. Held rather than re-read from
 * `getSelection()`: the selection is emptied the moment the panel takes focus,
 * while a Range keeps tracking its text — measured, it survives focus leaving,
 * moves when a peer inserts ahead of it, and follows a reflow
 * (`engineering/demo/2026-08-25-live-range-probe.mjs`). `getClientRects` is
 * what the `inline` middleware reads to pick a line out of a target that wraps.
 *
 * Null when the target has no DOM to measure, which happens for the moment a
 * co-editor's replacement of the whole document is landing. The caller keeps
 * the reference it already has, and the next transaction builds a fresh one.
 * @param editor - The editor to measure in.
 * @param span - The target's extent in the document, when it has one.
 * @returns The reference, or null while the target cannot be measured.
 * @throws {never}
 */
export function panelReference(
  editor: ViewedEditor,
  span: LinkRange | null,
): ReferenceType | null {
  const view = viewOf(editor);
  if (view === null) return null;
  const contextElement = view.dom as HTMLElement;
  const extent = span ?? {
    from: view.state.selection.from,
    to: view.state.selection.to,
  };
  const range = domRangeOver(editor, extent);
  if (!range) return null;
  return {
    getBoundingClientRect: () => range.getBoundingClientRect(),
    getClientRects: () => range.getClientRects(),
    contextElement,
  };
}

/**
 * A live DOM Range over a span of the document.
 *
 * `domAtPos` gives the node and offset ProseMirror renders a position at, which
 * is exactly what a Range's boundary points take.
 * @param editor - The editor to read.
 * @param span - The extent to cover.
 * @returns The range, or null when the positions have no DOM yet.
 * @throws {never}
 */
function domRangeOver(editor: ViewedEditor, span: LinkRange): Range | null {
  try {
    const view = viewOf(editor);
    if (view === null) return null;
    const start = view.domAtPos(span.from);
    const end = view.domAtPos(span.to);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  } catch {
    // Positions outside the rendered document, which happens while a co-editor's
    // replacement of the whole doc is landing. The caller keeps the reference
    // it already has, and the next transaction builds a fresh one.
    return null;
  }
}
