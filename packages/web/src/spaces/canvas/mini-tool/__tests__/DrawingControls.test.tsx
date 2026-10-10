// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The drawing controls in a mask or sketch tool's panel (inner#1302 §6.3).
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { DrawingControls } from '@web/spaces/canvas/mini-tool/DrawingControls';
import { canvasSessions } from '@web/stores/canvas-session';
import type { DrawOp } from '@web/stores/drawing-draft';

const STROKE: DrawOp = { kind: 'stroke', erase: false, size: 5, color: '#FF3B30', points: [[0.1, 0.1]] };

/** The session store the controls read. */
const store = () => canvasSessions.of('').getState();

/**
 * Open a tool and render its controls.
 * @param toolId - The tool.
 * @param kind - Its drawing kind.
 */
function mount(toolId: string, kind: 'mask' | 'sketch'): void {
  store().openMiniTool('n1', toolId, { sourceContent: 'a.png', params: {} });
  render(
    <TooltipProvider>
      <DrawingControls kind={kind} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  canvasSessions.clear();
});

describe('DrawingControls', () => {
  it('picks one of the four tools', () => {
    mount('image.inpaint', 'mask');
    expect(screen.getByTestId('mini-tool-draw-brush')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('mini-tool-draw-rect'));
    expect(store().miniTool?.drawing?.tool).toBe('rect');
    expect(screen.getByTestId('mini-tool-draw-rect')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('mini-tool-draw-brush')).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows the brush size', () => {
    mount('image.inpaint', 'mask');
    expect(screen.getByTestId('mini-tool-draw-size-value')).toHaveTextContent('5');
  });

  it('offers the four mask colours on a mask', () => {
    mount('image.erase', 'mask');
    expect(screen.queryByTestId('mini-tool-draw-ink-#FF3B30')).toBeNull();
    fireEvent.click(screen.getByTestId('mini-tool-draw-mask-green'));
    expect(store().miniTool?.drawing?.maskColor).toBe('green');
    expect(screen.getByTestId('mini-tool-draw-mask-green')).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers the six inks on a sketch', () => {
    mount('image.sketch', 'sketch');
    expect(screen.queryByTestId('mini-tool-draw-mask-pink')).toBeNull();
    fireEvent.click(screen.getByTestId('mini-tool-draw-ink-#0A84FF'));
    expect(store().miniTool?.drawing?.color).toBe('#0A84FF');
  });

  it('enables undo, redo and clear only when they have something to act on', () => {
    mount('image.inpaint', 'mask');
    const undo = screen.getByTestId('mini-tool-draw-undo');
    const redo = screen.getByTestId('mini-tool-draw-redo');
    const clear = screen.getByTestId('mini-tool-draw-clear');
    expect(undo).toBeDisabled();
    expect(redo).toBeDisabled();
    expect(clear).toBeDisabled();
    act(() => store().addDrawingStep(STROKE));
    expect(undo).toBeEnabled();
    expect(clear).toBeEnabled();
    fireEvent.click(undo);
    expect(store().miniTool?.drawing?.steps).toEqual([]);
    expect(redo).toBeEnabled();
    fireEvent.click(redo);
    expect(store().miniTool?.drawing?.steps).toEqual([STROKE]);
    fireEvent.click(clear);
    expect(store().miniTool?.drawing?.steps).toEqual([STROKE, { kind: 'clear' }]);
    expect(clear).toBeDisabled();
    expect(undo).toBeEnabled();
  });

  it('disables every control while the run is exporting', () => {
    mount('image.inpaint', 'mask');
    act(() => {
      store().addDrawingStep(STROKE);
      store().setMiniToolExporting(true, store().panelSession);
    });
    for (const id of ['brush', 'rect', 'ellipse', 'eraser', 'undo', 'clear', 'mask-pink']) {
      expect(screen.getByTestId(`mini-tool-draw-${id}`)).toBeDisabled();
    }
    expect(screen.getByTestId('mini-tool-draw-size-slider').querySelector('[role=slider]')).toHaveAttribute(
      'data-disabled',
    );
  });
});
