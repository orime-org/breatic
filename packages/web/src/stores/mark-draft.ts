// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The markup tool's draft (inner#1303 §6.2). The object list is the only copy
 * of what is drawn; the canvas on the node renders from it and writes the
 * reader's gestures back. Positions are shares of the source, as a drawing's
 * are, so one list draws the preview at the node's size and the export at the
 * source's. Size is the brush slider's value, taken against the source's
 * shorter side: a stroke is size/400 of it and a text's font size/100 of it
 * (`markStrokePx`, `markFontPx`).
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
  /** Whether the size changed since the text edit began; the text then shows the panel's size. */
  readonly editResized: boolean;
}

/** How the handlers outside the markup's canvas ask it to leave a text edit or drop its selection. */
export interface MarkChannel {
  /** Leave the text being edited, writing it back by the usual rules. */
  exitEditing: () => void;
  /** Drop the selection. */
  discardSelection: () => void;
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
  editResized: false,
});

/**
 * An object's size as the size slider shows it, held to the slider's range
 * and steps: a text scaled on the canvas keeps whatever size the scale gave
 * (§6.2), which the slider can only show at its nearest step.
 * @param size - The object's size.
 * @returns The size on the slider.
 * @throws {never} Never.
 */
export function sliderSizeOf(size: number): number {
  const stepped = Math.round(size / BRUSH_SIZE.step) * BRUSH_SIZE.step;
  return Math.min(BRUSH_SIZE.max, Math.max(BRUSH_SIZE.min, stepped));
}

/**
 * The draft with a new object list, as one step when it differs from the one
 * held. A write that changes nothing is no step, so a canvas echoing back what
 * it was just told leaves undo and redo alone. The selected object's style
 * becomes the controls' own.
 * @param draft - The draft.
 * @param objects - The new list, as the canvas wrote it.
 * @returns The draft.
 */
export function withObjects(draft: MarkDraft, objects: readonly MarkObject[]): MarkDraft {
  if (JSON.stringify(objects) === JSON.stringify(draft.objects)) return draft;
  const next = { ...draft, objects, undo: [...draft.undo, draft.objects], redo: [] };
  // The controls show the selected object's style, also after the canvas
  // changed it (a scaled text), by the rule selecting it applies.
  return draft.selectedId === null ? next : selectedMark(next, draft.selectedId);
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
 * The draft with a style change: the colour and size new objects take always,
 * and the selected object as
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
  const editing = editStyleOf(draft);
  if (editing !== null) {
    return { ...next, editResized: draft.editResized || (style.size !== undefined && style.size !== editing.size) };
  }
  if (draft.selectedId === null) return next;
  const objects = draft.objects.map((object) => (object.id === draft.selectedId ? { ...object, ...style } : object));
  return withObjects(next, objects);
}

/**
 * The draft with an object selected, or none. The selected object's colour
 * and size become the controls' own, so the panel shows them and a change to
 * them restyles it; they stay for the next object when it is let go. As no step.
 * @param draft - The draft.
 * @param id - The object, or null for none.
 * @returns The draft.
 */
export function selectedMark(draft: MarkDraft, id: string | null): MarkDraft {
  const object = id === null ? undefined : draft.objects.find((candidate) => candidate.id === id);
  return object === undefined
    ? { ...draft, selectedId: id }
    : { ...draft, selectedId: id, color: object.color, size: sliderSizeOf(object.size) };
}

/**
 * The draft with the text being edited as typed so far, or with no edit. An
 * edit begins with the size untouched.
 * @param draft - The draft.
 * @param text - The text, or null when the edit ends.
 * @returns The draft.
 * @throws {never} Never.
 */
export function withEditingText(draft: MarkDraft, text: string | null): MarkDraft {
  const resized = draft.editingText !== null && text !== null && draft.editResized;
  return { ...draft, editingText: text, editResized: resized };
}

/**
 * The colour and size the text being edited shows: the panel's colour, and
 * the panel's size once that changed in the edit, else the text's own (a text
 * scaled past the slider keeps its size). Leaving the edit writes these back.
 * @param draft - The draft.
 * @returns The style, or null when no text is being edited.
 * @throws {never} Never.
 */
export function editStyleOf(draft: MarkDraft): { color: string; size: number } | null {
  if (draft.editingText === null) return null;
  const held = draft.objects.find((object) => object.id === draft.selectedId);
  return { color: draft.color, size: held === undefined || draft.editResized ? draft.size : held.size };
}

/**
 * The selected text as it shows during its edit: as typed, in the style the
 * edit shows (`editStyleOf`).
 * @param draft - The draft, with a text being edited.
 * @param held - The text as the list holds it.
 * @returns The text as it shows.
 * @throws {never} Never.
 */
function shownInEdit(draft: MarkDraft, held: MarkObject): MarkObject {
  const style = editStyleOf(draft) ?? { color: held.color, size: held.size };
  if (held.kind !== 'text') return { ...held, ...style };
  return { ...held, text: draft.editingText ?? held.text, ...style };
}

/**
 * How many objects leaving the text edit would leave (§6.6: a press during
 * the edit leaves it first and acts on what is left), and whether leaving
 * records a step. The text being edited is the selected one; it is already in
 * the list when it existed before the edit, and a blank one is dropped.
 * @param draft - The draft.
 * @returns The count after leaving, and whether leaving changes the list.
 * @throws {never} Never.
 */
function afterLeavingEdit(draft: MarkDraft): { count: number; steps: boolean } {
  const typed = draft.editingText;
  if (typed === null) return { count: draft.objects.length, steps: false };
  const blank = typed.trim() === '';
  const held = draft.objects.find((object) => object.id === draft.selectedId);
  if (held === undefined) return { count: draft.objects.length + (blank ? 0 : 1), steps: !blank };
  if (blank) return { count: draft.objects.length - 1, steps: true };
  return { count: draft.objects.length, steps: JSON.stringify(shownInEdit(draft, held)) !== JSON.stringify(held) };
}

/**
 * Whether the markup would leave nothing on the picture once the text edit,
 * if any, is left.
 * @param draft - The draft.
 * @returns True when nothing would be drawn.
 * @throws {never} Never.
 */
export function markEmpty(draft: MarkDraft): boolean {
  return afterLeavingEdit(draft).count === 0;
}

/**
 * Whether Clear has something to take, once the text edit, if any, is left.
 * @param draft - The draft.
 * @returns True when it does.
 * @throws {never} Never.
 */
export function markCanClear(draft: MarkDraft): boolean {
  return !markEmpty(draft);
}

/**
 * Whether Redo has a step to put back once the text edit, if any, is left:
 * leaving it records a step whenever the text, its colour or its size changed,
 * and a new step empties what redo held.
 * @param draft - The draft.
 * @returns True when it does.
 * @throws {never} Never.
 */
export function markCanRedo(draft: MarkDraft): boolean {
  return draft.redo.length > 0 && !afterLeavingEdit(draft).steps;
}

/**
 * The size one press of `[` or `]` gives: one step from the selected object's
 * size as it shows, or from the size new objects take with nothing selected, held to the slider's
 * range. A text scaled past either end keeps its size until the key moves it
 * back toward the range.
 * @param draft - The draft.
 * @param step - -1 for smaller, 1 for larger.
 * @returns The new size, or null when the press would not move it the way it asks.
 * @throws {never} Never.
 */
export function steppedMarkSize(draft: MarkDraft, step: number): number | null {
  const held = draft.selectedId === null ? undefined : draft.objects.find((object) => object.id === draft.selectedId);
  const shown = held !== undefined && draft.editingText !== null ? shownInEdit(draft, held) : held;
  const from = shown?.size ?? draft.size;
  const next = Math.min(BRUSH_SIZE.max, Math.max(BRUSH_SIZE.min, from + step * BRUSH_SIZE.step));
  return (next - from) * step > 0 ? next : null;
}

/**
 * Whether Undo has a step to take back, counting the step leaving the text
 * edit would record.
 * @param draft - The draft.
 * @returns True when it does.
 * @throws {never} Never.
 */
export function markCanUndo(draft: MarkDraft): boolean {
  return draft.undo.length > 0 || afterLeavingEdit(draft).steps;
}
