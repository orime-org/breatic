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
import type { EditorView } from '@tiptap/pm/view';

import { viewOf, type ViewedEditor } from '@web/spaces/document/document-editor-view';
import type { LinkRange } from '@web/spaces/document/document-link';

/**
 * What floating-ui measures a control against.
 *
 * A DOM Range over the target itself. Built rather than read from
 * `getSelection()`: the selection is emptied the moment the panel takes focus,
 * while a Range keeps tracking its text — measured, it survives focus leaving,
 * moves when a peer inserts ahead of it, and follows a reflow
 * (`engineering/demo/2026-08-25-live-range-probe.mjs`). `getClientRects` is
 * what the `inline` middleware reads to pick a line out of a target that wraps.
 *
 * Built again on every rectangle asked for, because a Range tracks its text
 * only while the document keeps the nodes it was built over. Writing an address
 * gives the run a new mark, and a mark view whose mark is not `eq` is destroyed
 * and rebuilt (`prosemirror-view/src/viewdesc.ts:637`), which leaves a Range
 * from before the write measuring nodes nothing renders — the reader sees the
 * toolbar stop following the link it is pointing at. The library asks for a
 * rectangle when it is about to paint, so answering from the positions rather
 * than from held nodes is what keeps the two in step. CKEditor says the same of
 * its own (`linkui.ts:1287-1290`): a cached DOM range is very fragile.
 *
 * Null when the target has no DOM to measure at all, which happens for the
 * moment a co-editor's replacement of the whole document is landing. The caller
 * keeps the reference it already has, and the next transaction builds a fresh
 * one; a reference already handed out answers from its last good range for that
 * moment rather than reporting a rectangle at the origin.
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
  const initial = domRangeOver(editor, extentOf(view, span));
  if (!initial) return null;
  let last: Range = initial;
  /**
   * The range over the target as the document stands.
   * @returns The fresh range, or the last good one.
   */
  const live = (): Range => {
    const now = viewOf(editor);
    const fresh = now === null ? null : domRangeOver(editor, extentOf(now, span));
    if (fresh) last = fresh;
    return last;
  };
  return {
    getBoundingClientRect: () => live().getBoundingClientRect(),
    getClientRects: () => live().getClientRects(),
    contextElement,
  };
}

/**
 * Whether a pointer is over the text of a span.
 *
 * `posAtCoords` answers with the position NEAREST the coordinates rather than
 * the one under them (`prosemirror-view@1.42.2/dist/index.d.ts`), so on its own
 * it reports a link for a pointer resting in the margin beside a line, in the
 * leading between two lines, or in the gap between two blocks. The span's own
 * rectangles are what the pointer has to be inside.
 * @param editor - The editor to measure in.
 * @param span - The extent to test against.
 * @param point - The pointer event to take the coordinates from.
 * @returns True when the pointer is inside one of the span's rectangles.
 * @throws {never}
 */
export function underPointer(
  editor: ViewedEditor,
  span: LinkRange,
  point: MouseEvent,
): boolean {
  const rects = panelReference(editor, span)?.getClientRects?.();
  if (!rects) return false;
  return Array.from(rects as ArrayLike<DOMRect>).some(
    (rect) =>
      point.clientX >= rect.left &&
      point.clientX <= rect.right &&
      point.clientY >= rect.top &&
      point.clientY <= rect.bottom,
  );
}

/**
 * The extent to measure: the given one, or the selection when there is none.
 * @param view - The view to read the selection from.
 * @param span - The extent, when the caller has one.
 * @returns The extent.
 * @throws {never}
 */
function extentOf(view: EditorView, span: LinkRange | null): LinkRange {
  if (span) return span;
  return { from: view.state.selection.from, to: view.state.selection.to };
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
