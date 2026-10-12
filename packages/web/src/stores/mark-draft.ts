// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The markup tool's draft (inner#1303 §6.2). The object list is the only copy
 * of what is drawn; the canvas on the node renders from it and writes the
 * reader's gestures back. Positions are shares of the source, as a drawing's
 * are, so one list draws the preview at the node's size and the export at the
 * source's. Size is a percent of the source's shorter side, as the brush's is.
 */

import { BRUSH_SIZE, INK } from '@web/stores/drawing-draft';

/** What a press on the node does. */
export type MarkTool = 'select' | 'arrow' | 'rect' | 'ellipse' | 'line' | 'pen' | 'text';

/** The tools in the order the panel shows them. */
export const MARK_TOOLS: readonly MarkTool[] = ['select', 'arrow', 'rect', 'ellipse', 'line', 'pen', 'text'];

/** One drawn object. */
export type MarkObject =
  | {
      readonly id: string;
      readonly kind: 'arrow' | 'line';
      readonly color: string;
      readonly size: number;
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
    }
  | {
      readonly id: string;
      readonly kind: 'rect' | 'ellipse';
      readonly color: string;
      readonly size: number;
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
    }
  | {
      readonly id: string;
      readonly kind: 'pen';
      readonly color: string;
      readonly size: number;
      readonly points: readonly (readonly [number, number])[];
    }
  | {
      readonly id: string;
      readonly kind: 'text';
      readonly color: string;
      readonly size: number;
      readonly x: number;
      readonly y: number;
      readonly text: string;
    };

/** The markup tool's draft. */
export interface MarkDraft {
  readonly tool: MarkTool;
  /** The colour a new object takes, and the selected one's when it changes. */
  readonly color: string;
  /** The size a new object takes, and the selected one's when it changes. */
  readonly size: number;
  readonly objects: readonly MarkObject[];
  /** The object lists before each step, oldest first. */
  readonly undo: readonly (readonly MarkObject[])[];
  /** The object lists undone, newest last; emptied by any new step. */
  readonly redo: readonly (readonly MarkObject[])[];
  readonly selectedId: string | null;
  /** The text being edited, as typed so far; null when no text is being edited. */
  readonly editingText: string | null;
}

/** The draft the markup tool opens with. */
export const EMPTY_MARK: Readonly<MarkDraft> = Object.freeze({
  tool: 'select',
  color: INK[0],
  size: BRUSH_SIZE.initial,
  objects: [],
  undo: [],
  redo: [],
  selectedId: null,
  editingText: null,
});

/**
 * The draft with a new object list, as one step when it differs from the one
 * held. A write that changes nothing is no step, so a canvas echoing back what
 * it was just told leaves undo and redo alone.
 * @param draft - The draft.
 * @param objects - The new list.
 * @returns The draft.
 */
export function withObjects(draft: MarkDraft, objects: readonly MarkObject[]): MarkDraft {
  if (JSON.stringify(objects) === JSON.stringify(draft.objects)) return draft;
  return { ...draft, objects, undo: [...draft.undo, draft.objects], redo: [] };
}

/**
 * The draft one step back.
 * @param draft - The draft.
 * @returns The draft.
 */
export function undoneMark(draft: MarkDraft): MarkDraft {
  const before = draft.undo.at(-1);
  if (before === undefined) return draft;
  return { ...draft, objects: before, undo: draft.undo.slice(0, -1), redo: [...draft.redo, draft.objects], selectedId: null };
}

/**
 * The draft one undone step forward.
 * @param draft - The draft.
 * @returns The draft.
 */
export function redoneMark(draft: MarkDraft): MarkDraft {
  const after = draft.redo.at(-1);
  if (after === undefined) return draft;
  return { ...draft, objects: after, undo: [...draft.undo, draft.objects], redo: draft.redo.slice(0, -1), selectedId: null };
}

/**
 * The draft with a style change: the pen always, and the selected object as
 * one step when no text is being edited (the canvas sets an edited text's
 * style itself and writes it back on leaving the edit).
 * @param draft - The draft.
 * @param style - The colour or size.
 * @param style.color - A new colour.
 * @param style.size - A new size.
 * @returns The draft.
 */
export function restyled(draft: MarkDraft, style: { color?: string; size?: number }): MarkDraft {
  const next = { ...draft, ...style };
  if (draft.editingText !== null || draft.selectedId === null) return next;
  const objects = draft.objects.map((object) => (object.id === draft.selectedId ? { ...object, ...style } : object));
  return withObjects(next, objects);
}

/**
 * Whether the markup leaves nothing on the picture: no object, and no text
 * with content being edited.
 * @param draft - The draft.
 * @returns True when nothing is drawn.
 */
export function markEmpty(draft: MarkDraft): boolean {
  return draft.objects.length === 0 && (draft.editingText ?? '').trim() === '';
}
