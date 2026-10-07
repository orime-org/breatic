// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The crop tools' box on the node (inner#888 §7.4): held in source pixels and
 * drawn over the picture at whatever size it is shown.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MiniToolCropOverlay } from '@web/spaces/canvas/mini-tool/MiniToolCropOverlay';
import type { CropRect } from '@web/spaces/canvas/mini-tool/mini-tool-view';

/** The picture is shown 400×300 at (100, 50); it is 800×600 in its own pixels. */
const BOX = { left: 100, top: 50, width: 400, height: 300 };

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const isImg = this.tagName === 'IMG';
    return {
      x: isImg ? BOX.left : 0,
      y: isImg ? BOX.top : 0,
      left: isImg ? BOX.left : 0,
      top: isImg ? BOX.top : 0,
      right: isImg ? BOX.left + BOX.width : 1000,
      bottom: isImg ? BOX.top + BOX.height : 1000,
      width: isImg ? BOX.width : 1000,
      height: isImg ? BOX.height : 1000,
      toJSON: () => ({}),
    } as DOMRect;
  });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => 600 });
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLImageElement.prototype, 'naturalWidth');
  Reflect.deleteProperty(HTMLImageElement.prototype, 'naturalHeight');
});

/**
 * The node's picture and the overlay over it.
 * @param rect - The crop in source pixels.
 * @param onChange - The change spy.
 * @param ratio - The locked ratio.
 */
function mount(rect: CropRect | null, onChange = vi.fn(), ratio: number | null = null): void {
  render(
    <ReactFlowProvider>
      <div className='react-flow__node' data-id='n1'>
        <img data-testid='image-node-img' src='https://cdn/a.png' alt='' />
      </div>
      <MiniToolCropOverlay nodeId='n1' nodePosition={{ x: 0, y: 0 }} rect={rect} ratio={ratio} onChange={onChange} />
    </ReactFlowProvider>,
  );
}

describe('MiniToolCropOverlay', () => {
  it('frames the whole picture until a crop is set', () => {
    mount(null);
    const rect = screen.getByTestId('mini-tool-crop-rect');
    expect([rect.style.left, rect.style.top, rect.style.width, rect.style.height]).toEqual(['0px', '0px', '400px', '300px']);
  });

  it('draws a source-pixel crop at the size it is shown', () => {
    mount({ x: 200, y: 0, w: 400, h: 300 });
    const rect = screen.getByTestId('mini-tool-crop-rect');
    expect([rect.style.left, rect.style.width, rect.style.height]).toEqual(['100px', '200px', '150px']);
  });

  it('writes a drawn box back in source pixels', () => {
    const onChange = vi.fn();
    mount(null, onChange);
    const layer = screen.getByTestId('mini-tool-crop-layer');
    fireEvent.pointerDown(layer, { clientX: 150, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 250, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(layer, { pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith({ x: 100, y: 100, w: 200, h: 160 });
  });

  it('rounds the handles while a ratio holds the box', () => {
    mount(null, vi.fn(), 1);
    expect(screen.getByTestId('mini-tool-crop-handle-se').className).toContain('rounded-full');
  });
});
