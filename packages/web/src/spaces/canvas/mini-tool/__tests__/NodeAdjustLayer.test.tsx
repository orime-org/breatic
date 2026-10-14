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
// The node's own picture is not CORS-loaded; the preview draws from a copy that is.
const loaded = vi.hoisted(() => ({ el: { tagName: 'IMG', copy: true } as unknown as HTMLImageElement }));
const loader = vi.hoisted(() => ({ prepareCropSource: vi.fn(() => Promise.resolve(loaded.el)) }));
vi.mock('@web/spaces/canvas/focus/crop-export', async (original) => ({ ...(await original<object>()), ...loader }));

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

/** Let the CORS-loaded copy of the picture arrive. */
async function pictureLoaded(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

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
 * @param zoom - The canvas zoom.
 */
function mount(toolId: string, params: Record<string, unknown>, zoom = 1): void {
  render(cropCanvas([NODE], null, zoom));
  act(() => store().openMiniTool('n1', toolId, { sourceContent: NODE.src, params }));
}

describe('NodeAdjustLayer', () => {
  it('draws the picture through the sliders while the picture adjust is open', async () => {
    mount('image.adjust', { value: { ...defaultAdjustValue, exposure: 20 } });
    await pictureLoaded();
    flushFrames();
    expect(screen.getByTestId('mini-tool-adjust-layer')).toBeInTheDocument();
    expect(drawing.drawAdjusted).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ exposure: 20 }),
      expect.anything(),
    );
  });

  it('draws from a CORS-loaded copy of the picture, which WebGL takes', async () => {
    mount('image.adjust', { value: { ...defaultAdjustValue, exposure: 20 } });
    await pictureLoaded();
    flushFrames();
    expect(loader.prepareCropSource).toHaveBeenCalledWith({ url: NODE.src, timeSeconds: null });
    expect(drawing.drawAdjusted).toHaveBeenLastCalledWith(loaded.el, expect.anything(), expect.anything(), expect.anything());
  });

  it('redraws once a frame however many times the sliders move', async () => {
    mount('image.adjust', { value: defaultAdjustValue });
    await pictureLoaded();
    flushFrames();
    drawing.drawAdjusted.mockClear();
    // Two renders before the frame runs: the second finds a frame already asked
    // for and leaves its value for it.
    act(() => store().setMiniToolParam('value', { ...defaultAdjustValue, contrast: 10 }));
    act(() => store().setMiniToolParam('value', { ...defaultAdjustValue, contrast: 30 }));
    flushFrames();
    expect(drawing.drawAdjusted).toHaveBeenCalledTimes(1);
    expect(drawing.drawAdjusted).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ contrast: 30 }),
      expect.anything(),
    );
  });

  // A semi-transparent pixel shows the card behind it, as on the result node,
  // not the unadjusted picture under the layer.
  it('covers the picture under it with the card', async () => {
    mount('image.adjust', { value: { ...defaultAdjustValue, exposure: 20 } });
    await pictureLoaded();
    expect(screen.getByTestId('mini-tool-adjust-layer')).toHaveClass('bg-card');
  });

  it('leaves the picture showing until the first frame is drawn', async () => {
    mount('image.adjust', { value: { ...defaultAdjustValue, exposure: 20 } });
    await pictureLoaded();
    expect(screen.getByTestId('mini-tool-adjust-layer')).toHaveClass('invisible');
    flushFrames();
    await pictureLoaded();
    expect(screen.getByTestId('mini-tool-adjust-layer')).not.toHaveClass('invisible');
  });

  it('leaves the picture showing when its copy fails to load', async () => {
    loader.prepareCropSource.mockReturnValueOnce(Promise.reject(new Error('blocked')));
    mount('image.adjust', { value: { ...defaultAdjustValue, exposure: 20 } });
    await pictureLoaded();
    flushFrames();
    await pictureLoaded();
    expect(screen.getByTestId('mini-tool-adjust-layer')).toHaveClass('invisible');
  });

  // The preview is drawn at the pixels the node takes on screen, so zooming
  // in shows what the export will do to fine detail.
  it('draws at the size the node shows on screen', async () => {
    mount('image.adjust', { value: { ...defaultAdjustValue, sharpness: 50 } }, 2);
    await pictureLoaded();
    flushFrames();
    const [, size] = drawing.drawAdjusted.mock.calls.at(-1) as unknown as [unknown, { width: number }];
    expect(size.width).toBe(800);
  });

  it('draws nothing for another tool', () => {
    mount('image.crop', {});
    flushFrames();
    expect(screen.queryByTestId('mini-tool-adjust-layer')).toBeNull();
    expect(drawing.drawAdjusted).not.toHaveBeenCalled();
  });
});
