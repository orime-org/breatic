// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The drawing layer on the node (inner#1302 §6.2): a left-button drag writes
 * one step in source fractions, nothing else draws. Painting is checked in
 * Playwright; jsdom has no rasteriser.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cropCanvas, installLayout } from '@web/spaces/canvas/crop/__tests__/crop-harness';
import { canvasSessions } from '@web/stores/canvas-session';

const NODE = { id: 'n1', kind: 'img' as const, src: 'https://cdn/a.png' };

/** The session store the canvas under test reads. */
const store = () => canvasSessions.of('').getState();

beforeEach(() => {
  installLayout();
  canvasSessions.clear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * Render the node (shown 400×300 at 100,50) and open a tool on it.
 * @param toolId - The tool.
 */
function mount(toolId: string): void {
  render(cropCanvas([NODE], null));
  act(() => store().openMiniTool('n1', toolId, { sourceContent: NODE.src, params: {} }));
}

/**
 * Drag on the drawing layer, in screen coordinates.
 * @param points - Down, the moves, then up at the last.
 * @param button - The button pressed.
 */
function drag(points: ReadonlyArray<[number, number]>, button = 0): void {
  const layer = screen.getByTestId('mini-tool-draw-layer');
  const [first, ...rest] = points;
  if (first === undefined) return;
  fireEvent.pointerDown(layer, { clientX: first[0], clientY: first[1], button, pointerId: 1 });
  for (const [x, y] of rest) fireEvent.pointerMove(layer, { clientX: x, clientY: y, pointerId: 1 });
  fireEvent.pointerUp(layer, { pointerId: 1 });
}

describe('NodeDrawLayer', () => {
  it('shows only while a drawing tool is open on the node', () => {
    mount('image.upscale');
    expect(screen.queryByTestId('mini-tool-draw-layer')).toBeNull();
    act(() => store().openMiniTool('n1', 'image.inpaint', { sourceContent: NODE.src, params: {} }));
    const layer = screen.getByTestId('mini-tool-draw-layer');
    expect(layer).toHaveClass('nodrag', 'nopan');
  });

  it('writes a brush drag as one stroke in source fractions with the draft size and ink', () => {
    mount('image.inpaint');
    drag([[150, 80], [300, 200]]);
    expect(store().miniTool?.drawing?.steps).toEqual([
      { kind: 'stroke', erase: false, size: 5, color: '#FF3B30', points: [[0.125, 0.1], [0.5, 0.5]] },
    ]);
  });

  it('marks an eraser stroke', () => {
    mount('image.erase');
    act(() => store().setDrawingTool('eraser'));
    drag([[150, 80], [300, 200]]);
    expect(store().miniTool?.drawing?.steps[0]).toMatchObject({ kind: 'stroke', erase: true });
  });

  it('writes a shape dragged up and left with its corner at the top left', () => {
    mount('image.sketch');
    act(() => store().setDrawingTool('ellipse'));
    drag([[300, 200], [150, 80]]);
    expect(store().miniTool?.drawing?.steps).toEqual([
      { kind: 'ellipse', size: 5, color: '#FF3B30', x: 0.125, y: 0.1, w: 0.375, h: 0.4 },
    ]);
  });

  it('writes nothing for a shape that was only clicked', () => {
    mount('image.inpaint');
    act(() => store().setDrawingTool('rect'));
    drag([[150, 80]]);
    expect(store().miniTool?.drawing?.steps).toEqual([]);
  });

  it('leaves the right button to the node menu', () => {
    mount('image.inpaint');
    drag([[150, 80], [300, 200]], 2);
    expect(store().miniTool?.drawing?.steps).toEqual([]);
  });

  it('drops a stroke the browser cancels', () => {
    mount('image.inpaint');
    const layer = screen.getByTestId('mini-tool-draw-layer');
    fireEvent.pointerDown(layer, { clientX: 150, clientY: 80, button: 0, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 300, clientY: 200, pointerId: 1 });
    fireEvent.pointerCancel(layer, { pointerId: 1 });
    fireEvent.pointerUp(layer, { pointerId: 1 });
    expect(store().miniTool?.drawing?.steps).toEqual([]);
  });

  it('takes no pointer while the run is exporting', () => {
    mount('image.inpaint');
    act(() => store().setMiniToolExporting(true, store().panelSession));
    expect(screen.getByTestId('mini-tool-draw-layer')).toHaveClass('pointer-events-none');
  });

  it('hides while a slot pick is under way', () => {
    mount('image.sketch');
    act(() => store().startMiniToolSlotPick('n1', 'reference'));
    expect(screen.queryByTestId('mini-tool-draw-layer')).toBeNull();
  });

  // inner#1302 §6.2: a pointer move repaints only the stroke under way; the
  // committed layer is repainted while an eraser cuts into it.
  describe('repainting', () => {
    const clears = new Map<HTMLCanvasElement, number>();

    /**
     * A 2D context that counts how often it is cleared.
     * @param canvas - The canvas it belongs to.
     * @returns The context.
     */
    const countingContext = (canvas: HTMLCanvasElement): CanvasRenderingContext2D =>
      new Proxy({} as Record<string, unknown>, {
        get: (target, key: string) =>
          key in target
            ? target[key]
            : (): void => {
              if (key === 'clearRect') clears.set(canvas, (clears.get(canvas) ?? 0) + 1);
            },
        set: (target, key: string, value: unknown) => {
          target[key] = value;
          return true;
        },
      }) as unknown as CanvasRenderingContext2D;

    beforeEach(() => {
      clears.clear();
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
        return countingContext(this);
      });
    });

    /**
     * Press, move five times, and report what was repainted during the moves.
     * @returns How often the committed layer was cleared, and how often the theme was read.
     */
    function strokeAndCount(): { committed: number; styleReads: number } {
      const layer = screen.getByTestId('mini-tool-draw-layer');
      const [committed] = Array.from(layer.querySelectorAll('canvas'));
      fireEvent.pointerDown(layer, { clientX: 150, clientY: 80, button: 0, pointerId: 1 });
      clears.clear();
      const styleSpy = vi.spyOn(window, 'getComputedStyle');
      for (let x = 160; x < 210; x += 10) fireEvent.pointerMove(layer, { clientX: x, clientY: 100, pointerId: 1 });
      const counted = { committed: clears.get(committed!) ?? 0, styleReads: styleSpy.mock.calls.length };
      styleSpy.mockRestore();
      fireEvent.pointerUp(layer, { pointerId: 1 });
      return counted;
    }

    it('leaves the committed layer alone while a brush stroke moves, and reads no theme', () => {
      mount('image.inpaint');
      expect(strokeAndCount()).toEqual({ committed: 0, styleReads: 0 });
    });

    it('repaints the committed layer while an eraser stroke moves', () => {
      mount('image.inpaint');
      act(() => store().setDrawingTool('eraser'));
      expect(strokeAndCount().committed).toBe(5);
    });

    it('leaves the committed layer alone when only the brush size changes', () => {
      mount('image.inpaint');
      const [committed] = Array.from(screen.getByTestId('mini-tool-draw-layer').querySelectorAll('canvas'));
      clears.clear();
      act(() => store().setDrawingSize(12));
      expect(clears.get(committed!) ?? 0).toBe(0);
    });
  });
});

