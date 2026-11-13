// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Dragging the divider between two columns (inner#1314 design §5.4).
 */

import type { EditorView } from '@tiptap/pm/view';

import { MIN_COLUMN_WIDTH } from '@web/spaces/document/document-column-geometry';
import { COLUMN_RESIZE_ZONE } from '@web/spaces/document/document-table-nodes';
import { rowById } from '@web/spaces/document/document-row-by-id';

/**
 * A weight rounded to four places, so repeated drags do not grow float noise
 * into the stored document.
 * @param weight - The weight.
 * @returns It, rounded.
 */
function rounded(weight: number): number {
  return Math.round(weight * 10_000) / 10_000;
}

/** The two columns either side of a divider when the drag started. */
export interface DividerStart {
  readonly leftPx: number;
  readonly rightPx: number;
  readonly leftWeight: number;
  readonly rightWeight: number;
  /** How far the pointer has moved since. */
  readonly dx: number;
}

/**
 * The two columns' weights after the divider moved.
 * @param start - The columns at the start and the move.
 * @returns The two weights.
 */
export function resizedWeights(start: DividerStart): { left: number; right: number } {
  const total = start.leftPx + start.rightPx;
  const weights = start.leftWeight + start.rightWeight;
  if (total < 2 * MIN_COLUMN_WIDTH) return { left: start.leftWeight, right: start.rightWeight };
  const leftPx = Math.min(Math.max(start.leftPx + start.dx, MIN_COLUMN_WIDTH), total - MIN_COLUMN_WIDTH);
  const left = rounded((weights * leftPx) / total);
  return { left, right: rounded(weights - left) };
}

/**
 * Writes columns' widths in one step.
 * @param view - The editor view.
 * @param widths - Each column's id and weight.
 */
export function writeColumnWidths(view: EditorView, widths: readonly { id: string; width: number }[]): void {
  const tr = view.state.tr;
  for (const { id, width } of widths) {
    const column = rowById(tr.doc, id);
    if (column !== undefined) tr.setNodeMarkup(column.from, undefined, { ...column.node.attrs, width });
  }
  if (tr.docChanged) view.dispatch(tr);
}

/** The part of the editor the divider reads and writes. */
export interface DividerEditor {
  readonly prosemirrorView: EditorView | undefined;
  readonly isEditable: boolean;
}

/** A divider drag in progress. */
interface DividerDrag extends Omit<DividerStart, 'dx'> {
  readonly startX: number;
  readonly left: HTMLElement;
  readonly right: HTMLElement;
  last: { left: number; right: number };
}

/**
 * A column's weight as its element carries it.
 * @param column - The column's element.
 * @returns Its weight.
 */
function weightOf(column: HTMLElement): number {
  const weight = Number(column.dataset['width'] ?? '1');
  return Number.isFinite(weight) && weight > 0 ? weight : 1;
}

/**
 * Draws the divider between two columns where the pointer is within the
 * resize zone of a gap's middle, and lets it be dragged: the two columns
 * follow the pointer in view only, and the release writes both widths once.
 * @param group - The group's element, the divider's container.
 * @param row - The element the columns stand in.
 * @param editor - The editor.
 * @returns What takes the divider away again.
 */
export function attachDivider(group: HTMLElement, row: HTMLElement, editor: DividerEditor): () => void {
  const divider = document.createElement('div');
  divider.className = 'doc-column-divider';
  divider.contentEditable = 'false';
  group.appendChild(divider);
  let drag: DividerDrag | null = null;

  /**
   * The columns, in order.
   * @returns Their elements.
   */
  const columns = (): HTMLElement[] => [...row.querySelectorAll<HTMLElement>(':scope > .doc-column')];

  /**
   * The gap whose middle the pointer is at.
   * @param x - The pointer's x.
   * @returns The index of the column right of it and the middle's x, or null.
   */
  const gapAt = (x: number): { index: number; middle: number } | null => {
    const all = columns();
    for (let index = 1; index < all.length; index += 1) {
      const middle = (all[index - 1]!.getBoundingClientRect().right + all[index]!.getBoundingClientRect().left) / 2;
      if (Math.abs(x - middle) <= COLUMN_RESIZE_ZONE) return { index, middle };
    }
    return null;
  };

  /**
   * Stands the divider at an x.
   * @param middle - The x.
   */
  const standAt = (middle: number): void => {
    divider.style.left = `${String(middle - group.getBoundingClientRect().left)}px`;
  };

  /**
   * Shows the divider over the gap whose middle the pointer is at.
   * @param event - The move.
   */
  const onMove = (event: PointerEvent): void => {
    if (drag !== null) return;
    const gap = editor.isEditable && group.dataset['stacked'] === undefined ? gapAt(event.clientX) : null;
    if (gap === null) {
      delete divider.dataset['shown'];
      return;
    }
    standAt(gap.middle);
    divider.dataset['index'] = String(gap.index);
    divider.dataset['shown'] = '';
  };
  /** Hides the divider once the pointer leaves the group, unless it is dragged. */
  const onLeave = (): void => {
    if (drag === null) delete divider.dataset['shown'];
  };
  // A press here is the divider's (macOS holds a press for a native drag,
  // `DocumentMediaBlock.tsx`).
  /**
   * Keeps the browser from starting a drag of the content around a press.
   * @param event - The press.
   */
  const onMouseDown = (event: MouseEvent): void => {
    event.preventDefault();
  };
  /**
   * Starts dragging the divider.
   * @param event - The press.
   */
  const onDown = (event: PointerEvent): void => {
    const index = Number(divider.dataset['index']);
    const all = columns();
    const left = all[index - 1];
    const right = all[index];
    if (left === undefined || right === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    divider.setPointerCapture(event.pointerId);
    const leftWeight = weightOf(left);
    const rightWeight = weightOf(right);
    drag = {
      startX: event.clientX,
      left,
      right,
      leftPx: left.getBoundingClientRect().width,
      rightPx: right.getBoundingClientRect().width,
      leftWeight,
      rightWeight,
      last: { left: leftWeight, right: rightWeight },
    };
    divider.dataset['dragging'] = '';
  };
  /**
   * Moves the two columns with the pointer, in view only.
   * @param event - The move.
   */
  const onDrag = (event: PointerEvent): void => {
    if (drag === null) return;
    drag.last = resizedWeights({ ...drag, dx: event.clientX - drag.startX });
    drag.left.style.flexGrow = String(drag.last.left);
    drag.right.style.flexGrow = String(drag.last.right);
    standAt((drag.left.getBoundingClientRect().right + drag.right.getBoundingClientRect().left) / 2);
  };
  /** Writes the two widths once, on release. */
  const onUp = (): void => {
    if (drag === null) return;
    const { left, right, last } = drag;
    drag = null;
    delete divider.dataset['dragging'];
    const view = editor.prosemirrorView;
    const leftId = left.getAttribute('data-id');
    const rightId = right.getAttribute('data-id');
    if (view !== undefined && leftId !== null && rightId !== null) {
      writeColumnWidths(view, [
        { id: leftId, width: last.left },
        { id: rightId, width: last.right },
      ]);
    }
  };
  /** Puts the two columns back when the drag is cancelled. */
  const onCancel = (): void => {
    if (drag === null) return;
    drag.left.style.flexGrow = String(drag.leftWeight);
    drag.right.style.flexGrow = String(drag.rightWeight);
    drag = null;
    delete divider.dataset['dragging'];
  };

  group.addEventListener('pointermove', onMove);
  group.addEventListener('pointerleave', onLeave);
  divider.addEventListener('mousedown', onMouseDown);
  divider.addEventListener('pointerdown', onDown);
  divider.addEventListener('pointermove', onDrag);
  divider.addEventListener('pointerup', onUp);
  divider.addEventListener('pointercancel', onCancel);
  return (): void => {
    group.removeEventListener('pointermove', onMove);
    group.removeEventListener('pointerleave', onLeave);
    divider.remove();
  };
}
