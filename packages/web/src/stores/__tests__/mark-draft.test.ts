// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The markup tool's draft (inner#1303 §6.2): the object list is the only copy
 * of what is drawn, and every change to it is one undo step.
 */

import { describe, expect, it } from 'vitest';

import { createCanvasSessionStore } from '@web/stores/canvas-session';
import { BRUSH_SIZE, INK } from '@web/stores/drawing-draft';
import { markEmpty, type MarkObject } from '@web/stores/mark-draft';

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
    });
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

  it('holds each object’s size inside the size range, in whole steps, so the control can show it', () => {
    const store = withMark();
    store.getState().commitMark([{ ...A, size: 60 }, { ...B, size: 8.4 }, { ...B, id: 'c', size: 0.2 }]);
    expect(mark(store).objects.map((object) => object.size)).toEqual([BRUSH_SIZE.max, 8, BRUSH_SIZE.min]);
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
