// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The picture adjust's live preview on the node (inner#1303 §6.1): drawn over
 * the picture while the panel is open, redrawn once a frame as the sliders
 * move. The drawing itself is checked in the browser.
 */

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const drawing = vi.hoisted(() => ({ drawAdjusted: vi.fn(() => Promise.resolve()) }));
vi.mock('@web/spaces/canvas/mini-tool/adjust-export', () => drawing);

import { defaultAdjustValue } from '@breatic/shared';

import { cropCanvas, installLayout } from '@web/spaces/canvas/crop/__tests__/crop-harness';
import { canvasSessions } from '@web/stores/canvas-session';

const NODE = { id: 'n1', kind: 'img' as const, src: 'https://cdn/a.png' };

/** The session store the canvas under test reads. */
const store = () => canvasSessions.of('').getState();

/** Frames asked for and not yet run. */
let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  installLayout();
  canvasSessions.clear();
  drawing.drawAdjusted.mockClear();
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Run the frames asked for so far. */
function flushFrames(): void {
  const due = frames;
  frames = [];
  act(() => due.forEach((cb) => cb(0)));
}

/**
 * Render the node and open a tool on it.
 * @param toolId - The tool.
 * @param params - Its params.
 */
function mount(toolId: string, params: Record<string, unknown>): void {
  render(cropCanvas([NODE], null));
  act(() => store().openMiniTool('n1', toolId, { sourceContent: NODE.src, params }));
}

describe('NodeAdjustLayer', () => {
  it('draws the picture through the sliders while the picture adjust is open', () => {
    mount('image.adjust', { value: { ...defaultAdjustValue, exposure: 20 } });
    flushFrames();
    expect(screen.getByTestId('mini-tool-adjust-layer')).toBeInTheDocument();
    expect(drawing.drawAdjusted).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ exposure: 20 }),
      expect.anything(),
    );
  });

  it('redraws once a frame however many times the sliders move', () => {
    mount('image.adjust', { value: defaultAdjustValue });
    flushFrames();
    drawing.drawAdjusted.mockClear();
    act(() => {
      store().setMiniToolParam('value', { ...defaultAdjustValue, contrast: 10 });
      store().setMiniToolParam('value', { ...defaultAdjustValue, contrast: 30 });
    });
    flushFrames();
    expect(drawing.drawAdjusted).toHaveBeenCalledTimes(1);
    expect(drawing.drawAdjusted).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ contrast: 30 }),
      expect.anything(),
    );
  });

  it('draws nothing for another tool', () => {
    mount('image.crop', {});
    flushFrames();
    expect(screen.queryByTestId('mini-tool-adjust-layer')).toBeNull();
    expect(drawing.drawAdjusted).not.toHaveBeenCalled();
  });
});
