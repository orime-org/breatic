// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The markup tool's draft (inner#1303 §6.2): the object list is the only copy
 * of what is drawn, and every change to it is one undo step.
 */

import { describe, expect, it } from 'vitest';

import { createCanvasSessionStore } from '@web/stores/canvas-session';
import { BRUSH_SIZE, INK } from '@web/stores/drawing-draft';
import { markCanClear, markCanRedo, markCanUndo, markEmpty, steppedMarkSize, type MarkObject } from '@web/stores/mark-draft';

const OPEN = { sourceContent: 'https://cdn.example.com/a.png', params: {} };
const A: MarkObject = { id: 'a', kind: 'rect', color: INK[0], size: 5, x: 0.1, y: 0.1, w: 0.3, h: 0.2 };
const B: MarkObject = { id: 'b', kind: 'line', color: INK[1], size: 5, x1: 0.2, y1: 0.2, x2: 0.6, y2: 0.4 };

/**
 * A store with the markup tool open.
 * @returns The store.
 */
function withMark(): ReturnType<typeof createCanvasSessionStore> {
  const store = createCanvasSessionStore();
  store.getState().openMiniTool('node-a', 'image.mark', OPEN);
  return store;
}

/**
 * The open markup draft.
 * @param store - The store.
 * @returns The draft.
 */
function mark(store: ReturnType<typeof createCanvasSessionStore>) {
  const draft = store.getState().miniTool?.mark;
  if (!draft) throw new Error('no markup draft');
  return draft;
}

describe('the markup draft', () => {
  it('opens with the select tool, the first ink, the brush size and nothing drawn', () => {
    expect(mark(withMark())).toEqual({
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
  });

  // The markup canvas loads apart from the page and reads the edit's style here.
  it('says the style the text being edited shows, and none outside an edit', () => {
    const store = withMark();
    expect(store.getState().markEditStyle()).toBeNull();
    store.getState().setMarkEditingText('eye');
    store.getState().setMarkColor(INK[2]);
    expect(store.getState().markEditStyle()).toEqual({ color: INK[2], size: BRUSH_SIZE.initial });
  });

  it('holds no markup on another tool', () => {
    const store = createCanvasSessionStore();
    store.getState().openMiniTool('node-a', 'image.crop', OPEN);
    expect(store.getState().miniTool?.mark).toBeNull();
  });

  it('takes each change to the objects as one step, and an unchanged write as none', () => {
    const store = withMark();
    store.getState().commitMark([A]);
    store.getState().commitMark([A, B]);
    store.getState().commitMark([A, B]);
    expect(mark(store).objects).toEqual([A, B]);
    expect(mark(store).undo).toHaveLength(2);
  });

  // §6.2: a text's scale folds into its size as it was scaled, a continuous value.
  it('keeps each object’s size as it was written', () => {
    const store = withMark();
    store.getState().commitMark([{ ...A, size: 60 }, { ...B, size: 8.4 }, { ...B, id: 'c', size: 0.2 }]);
    expect(mark(store).objects.map((object) => object.size)).toEqual([60, 8.4, 0.2]);
  });

  it('shows a selected object’s size on the slider within its range and steps', () => {
    const store = withMark();
    store.getState().commitMark([{ ...A, size: 60 }, { ...B, size: 8.4 }]);
    store.getState().selectMark('a');
    expect(mark(store).size).toBe(BRUSH_SIZE.max);
    store.getState().selectMark('b');
    expect(mark(store).size).toBe(8);
  });

  it('brings an undone object back on redo, and a write that changes nothing leaves the redo there', () => {
    const store = withMark();
    store.getState().commitMark([A]);
    store.getState().commitMark([A, B]);
    store.getState().undoMark();
    store.getState().undoMark();
    store.getState().redoMark();
    expect(mark(store).objects).toEqual([A]);
    store.getState().commitMark([A]);
    expect(mark(store).redo).toHaveLength(1);
  });

  it('clears everything as one step, and does nothing on an empty markup', () => {
    const store = withMark();
    store.getState().clearMark();
    expect(mark(store).undo).toHaveLength(0);
    store.getState().commitMark([A, B]);
    store.getState().clearMark();
    expect(mark(store).objects).toEqual([]);
    expect(mark(store).undo).toHaveLength(2);
  });

  it('restyles the selected object as one step', () => {
    const store = withMark();
    store.getState().commitMark([A]);
    store.getState().selectMark('a');
    store.getState().setMarkColor(INK[3]);
    store.getState().setMarkSize(9);
    expect(mark(store).objects[0]).toMatchObject({ color: INK[3], size: 9 });
    expect(mark(store).undo).toHaveLength(3);
  });

  it('shows the selected object’s colour and size in the controls, as no step', () => {
    const store = withMark();
    store.getState().commitMark([A, { ...B, size: 12 }]);
    store.getState().selectMark('b');
    expect(mark(store)).toMatchObject({ color: INK[1], size: 12, selectedId: 'b' });
    expect(mark(store).undo).toHaveLength(1);
    store.getState().selectMark(null);
    expect(mark(store)).toMatchObject({ color: INK[1], size: 12, selectedId: null });
  });

  it('lets go of the selection when a drawing tool is picked, and keeps it on select', () => {
    const store = withMark();
    store.getState().commitMark([A]);
    store.getState().selectMark('a');
    store.getState().setMarkTool('select');
    expect(mark(store).selectedId).toBe('a');
    store.getState().setMarkTool('rect');
    expect(mark(store).selectedId).toBeNull();
  });

  it('only changes the pen while a text is being edited', () => {
    const store = withMark();
    store.getState().commitMark([A]);
    store.getState().selectMark('a');
    store.getState().setMarkEditingText('hi');
    store.getState().setMarkColor(INK[3]);
    expect(mark(store).color).toBe(INK[3]);
    expect(mark(store).objects[0]).toMatchObject({ color: INK[0] });
    expect(mark(store).undo).toHaveLength(1);
  });

  it('drops the objects, the steps, the selection and the edit when the source changes', () => {
    const store = withMark();
    store.getState().commitMark([A]);
    store.getState().selectMark('a');
    store.getState().setMarkEditingText('hi');
    store.getState().setMarkTool('pen');
    store.getState().resetMiniToolSource('https://cdn.example.com/b.png', {});
    expect(mark(store)).toMatchObject({ objects: [], undo: [], redo: [], selectedId: null, editingText: null, tool: 'pen' });
  });
});

// §6.2: with an object selected the size slider shows its size, also after
// the canvas scaled it.
describe('the panel with an object selected', () => {
  it('shows the size the canvas gave the selected object', () => {
    const store = withMark();
    store.getState().commitMark([A]);
    store.getState().selectMark('a');
    store.getState().commitMark([{ ...A, size: 10 }]);
    expect(mark(store).size).toBe(10);
  });

  it('keeps the pen size when another object changes', () => {
    const store = withMark();
    store.getState().commitMark([A, B]);
    store.getState().selectMark('a');
    store.getState().commitMark([A, { ...B, size: 12 }]);
    expect(mark(store).size).toBe(A.size);
  });
});

describe('markEmpty', () => {
  it('counts a text still being edited', () => {
    const store = withMark();
    expect(markEmpty(mark(store))).toBe(true);
    store.getState().setMarkEditingText('  ');
    expect(markEmpty(mark(store))).toBe(true);
    store.getState().setMarkEditingText('note');
    expect(markEmpty(mark(store))).toBe(false);
  });
});

// §6.6: a press while a text is being edited leaves the edit first and acts on
// what is left, so every judgement reads the list as leaving would make it.
describe('the markup as leaving the text edit would leave it', () => {
  const T: MarkObject = { id: 't', kind: 'text', color: INK[0], size: 5, x: 0.1, y: 0.1, text: 'hi' };

  it('is empty when the only object is a text emptied in its edit', () => {
    const store = withMark();
    store.getState().commitMark([T]);
    store.getState().selectMark('t');
    store.getState().setMarkEditingText('');
    expect(markEmpty(mark(store))).toBe(true);
    expect(markCanClear(mark(store))).toBe(false);
  });

  it('is not empty while a text emptied in its edit sits beside another object', () => {
    const store = withMark();
    store.getState().commitMark([A, T]);
    store.getState().selectMark('t');
    store.getState().setMarkEditingText(' ');
    expect(markEmpty(mark(store))).toBe(false);
  });

  it('can be cleared and undone while the first text is being typed', () => {
    const store = withMark();
    store.getState().selectMark('new');
    store.getState().setMarkEditingText('hello');
    expect(markCanClear(mark(store))).toBe(true);
    expect(markCanUndo(mark(store))).toBe(true);
  });

  it('has nothing to clear or undo while a new text is still blank', () => {
    const store = withMark();
    store.getState().selectMark('new');
    store.getState().setMarkEditingText('');
    expect(markCanClear(mark(store))).toBe(false);
    expect(markCanUndo(mark(store))).toBe(false);
  });

  it('has a step to undo once an existing text is changed in its edit', () => {
    const fresh = withMark();
    fresh.getState().commitMark([T]);
    // The commit above is itself a step; the undo stack is emptied to read the
    // edit alone.
    fresh.getState().selectMark('t');
    fresh.getState().setMarkEditingText('hi');
    expect(markCanUndo({ ...mark(fresh), undo: [] })).toBe(false);
    fresh.getState().setMarkEditingText('hi there');
    expect(markCanUndo({ ...mark(fresh), undo: [] })).toBe(true);
  });
});

describe('redo as leaving the text edit would leave it', () => {
  const T: MarkObject = { id: 't', kind: 'text', color: INK[0], size: 5, x: 0.1, y: 0.1, text: 'hi' };

  it('has nothing to redo once leaving the edit would write a changed text back', () => {
    const store = withMark();
    store.getState().commitMark([A]);
    store.getState().undoMark();
    expect(markCanRedo(mark(store))).toBe(true);
    store.getState().selectMark('new');
    store.getState().setMarkEditingText('hi');
    expect(markCanRedo(mark(store))).toBe(false);
  });

  // Leaving the edit writes the text's new colour or size back as a step, and
  // a new step empties redo.
  it.each([
    ['colour', (store: ReturnType<typeof createCanvasSessionStore>) => store.getState().setMarkColor(INK[1])],
    ['size', (store: ReturnType<typeof createCanvasSessionStore>) => store.getState().setMarkSize(20)],
  ])('has nothing to redo once the %s of the text being edited changed', (_, restyle) => {
    const store = withMark();
    store.getState().commitMark([T]);
    store.getState().commitMark([T, A]);
    store.getState().undoMark();
    store.getState().selectMark('t');
    store.getState().setMarkEditingText('hi');
    restyle(store);
    expect(markCanRedo(mark(store))).toBe(false);
  });

  // Moved and moved back, the slider's size is what the text shows; a text
  // scaled past it no longer has its own.
  it('has nothing to redo once a scaled text\'s size was moved and moved back in its edit', () => {
    const store = withMark();
    const scaled = { ...T, size: 40.5 };
    store.getState().commitMark([scaled]);
    store.getState().commitMark([scaled, A]);
    store.getState().undoMark();
    store.getState().selectMark('t');
    store.getState().setMarkEditingText('hi');
    store.getState().setMarkSize(20);
    store.getState().setMarkSize(BRUSH_SIZE.max);
    expect(markCanRedo(mark(store))).toBe(false);
    store.getState().setMarkEditingText(null);
    store.getState().setMarkEditingText('hi');
    expect(mark(store).editResized).toBe(false);
  });

  it('keeps redo while a text scaled past the slider is edited without a change', () => {
    const store = withMark();
    const scaled = { ...T, size: 40.5 };
    store.getState().commitMark([scaled]);
    store.getState().commitMark([scaled, A]);
    store.getState().undoMark();
    store.getState().selectMark('t');
    store.getState().setMarkEditingText('hi');
    expect(markCanRedo(mark(store))).toBe(true);
  });

  it('keeps redo while the text being edited is unchanged', () => {
    const store = withMark();
    store.getState().commitMark([T]);
    store.getState().commitMark([T, A]);
    store.getState().undoMark();
    store.getState().selectMark('t');
    store.getState().setMarkEditingText('hi');
    expect(markCanRedo(mark(store))).toBe(true);
  });
});

describe('steppedMarkSize', () => {
  const big: MarkObject = { id: 'b', kind: 'text', color: INK[0], size: 40.5, x: 0.1, y: 0.1, text: 'big' };
  const small: MarkObject = { ...big, id: 's', size: 0.5 };

  it('steps from the selected object\'s own size, never against the key', () => {
    const store = withMark();
    store.getState().commitMark([big, small]);
    store.getState().selectMark('b');
    expect(steppedMarkSize(mark(store), 1)).toBeNull();
    expect(steppedMarkSize(mark(store), -1)).toBe(BRUSH_SIZE.max);
    store.getState().selectMark('s');
    expect(steppedMarkSize(mark(store), -1)).toBeNull();
    expect(steppedMarkSize(mark(store), 1)).toBe(1.5);
  });

  // In its edit a text shows the panel's size once that changed; the canvas
  // writes it back only when the edit ends.
  it('steps from the size a text shows in its edit', () => {
    const store = withMark();
    store.getState().commitMark([{ ...big, size: 5 }]);
    store.getState().selectMark('b');
    store.getState().setMarkEditingText('big');
    store.getState().setMarkSize(20);
    expect(steppedMarkSize(mark(store), 1)).toBe(20 + BRUSH_SIZE.step);
  });

  it('steps from a scaled text\'s own size in its edit while the size is untouched', () => {
    const store = withMark();
    store.getState().commitMark([big]);
    store.getState().selectMark('b');
    store.getState().setMarkEditingText('big');
    expect(steppedMarkSize(mark(store), 1)).toBeNull();
    expect(steppedMarkSize(mark(store), -1)).toBe(BRUSH_SIZE.max);
  });

  it('steps the pen size with nothing selected, holding at the ends', () => {
    const store = withMark();
    expect(steppedMarkSize(mark(store), 1)).toBe(BRUSH_SIZE.initial + BRUSH_SIZE.step);
    store.getState().setMarkSize(BRUSH_SIZE.max);
    expect(steppedMarkSize(mark(store), 1)).toBeNull();
  });
});
