// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Dragging the divider between two columns (inner#1314 design §5.4).
 */

import type { EditorView } from '@tiptap/pm/view';

import { COLUMN_DIVIDER_ZONE, columnWeight, MIN_COLUMN_WIDTH } from '@web/spaces/document/document-column-geometry';
import { rowById } from '@web/spaces/document/document-row-by-id';

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
 * A weight rounded to four places, up or down, so repeated drags do not grow
 * float noise into the stored document; a weight already on four places
 * stays.
 * @param weight - The weight.
 * @param up - Whether it rounds up.
 * @returns It, rounded.
 */
function roundedToward(weight: number, up: boolean): number {
  return up ? Math.ceil(weight * 10_000 - 1e-6) / 10_000 : Math.floor(weight * 10_000 + 1e-6) / 10_000;
}

/**
 * The two columns' weights after the divider moved. The narrower one is
 * rounded up and the wider one down, so the pair's weight never grows and a
 * column held at 96px is stored at no less: its group still holds it side
 * by side.
 * @param start - The columns at the start and the move.
 * @returns The two weights.
 */
export function resizedWeights(start: DividerStart): { left: number; right: number } {
  const total = start.leftPx + start.rightPx;
  const weights = start.leftWeight + start.rightWeight;
  if (total < 2 * MIN_COLUMN_WIDTH) return { left: start.leftWeight, right: start.rightWeight };
  const leftPx = Math.min(Math.max(start.leftPx + start.dx, MIN_COLUMN_WIDTH), total - MIN_COLUMN_WIDTH);
  const leftThinner = leftPx * 2 <= total;
  const thin = roundedToward((weights * (leftThinner ? leftPx : total - leftPx)) / total, true);
  const thick = roundedToward(weights - thin, false);
  return leftThinner ? { left: thin, right: thick } : { left: thick, right: thin };
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
  return columnWeight(column.dataset['width']);
}

/**
 * Draws the divider between two columns where the pointer is within
 * `COLUMN_DIVIDER_ZONE` of a gap's middle, and lets it be dragged: the two columns
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
   * @returns The index of the column right of it, or -1.
   */
  const gapAt = (x: number): number => {
    const all = columns();
    return all.findIndex((column, index) =>
      index > 0 && Math.abs(x - (all[index - 1]!.getBoundingClientRect().right + column.getBoundingClientRect().left) / 2) <= COLUMN_DIVIDER_ZONE);
  };

  /**
   * Stands the divider between two columns: in the middle of their gap, from
   * the top of their first blocks' own content, below the space a block
   * keeps above it, to the group's bottom.
   * @param left - The column left of the gap.
   * @param right - The column right of it.
   */
  const standBetween = (left: HTMLElement, right: HTMLElement): void => {
    const box = group.getBoundingClientRect();
    const top = Math.min(...[left, right].map((column) => {
      const first = column.firstElementChild;
      return (first?.querySelector(':scope > .bn-block > .bn-block-content') ?? first ?? column).getBoundingClientRect().top;
    }));
    divider.style.left = `${String((left.getBoundingClientRect().right + right.getBoundingClientRect().left) / 2 - box.left)}px`;
    divider.style.top = `${String(Math.max(0, top - box.top))}px`;
  };

  /**
   * Shows the divider over the gap whose middle the pointer is at.
   * @param event - The move.
   */
  const onMove = (event: PointerEvent): void => {
    if (drag !== null) return;
    const index = editor.isEditable && group.dataset['stacked'] === undefined ? gapAt(event.clientX) : -1;
    if (index < 0) {
      delete divider.dataset['shown'];
      return;
    }
    const all = columns();
    standBetween(all[index - 1]!, all[index]!);
    divider.dataset['index'] = String(index);
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
    standBetween(drag.left, drag.right);
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
    // What the document holds now: the widths written, or the old ones when
    // the Space refused the write.
    left.style.flexGrow = String(weightOf(left));
    right.style.flexGrow = String(weightOf(right));
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
