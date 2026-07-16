// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * FocusCropOverlay component tests (#1782): marquee draw / ratio presets /
 * confirm mapping / Esc staging, against a stubbed node img box.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import * as React from 'react';

import { FocusCropOverlay } from '@web/spaces/canvas/focus/FocusCropOverlay';

/** Fixed screen boxes: overlay root at (0,0); node img at (100,50) 400×300. */
const IMG_BOX = { left: 100, top: 50, width: 400, height: 300 };

/**
 * Renders the fake node DOM (what the overlay queries) + the overlay.
 * @param onConfirm - Confirm spy.
 * @param onExit - Exit spy.
 * @returns Testing-library render result.
 */
function renderOverlay(
  onConfirm = vi.fn(),
  onExit = vi.fn(),
): ReturnType<typeof render> {
  const result = render(
    <ReactFlowProvider>
      <div className='react-flow__node' data-id='n1'>
        <img data-testid='image-node-img' alt='' />
      </div>
      <FocusCropOverlay
        nodeId='n1'
        nodePosition={{ x: 0, y: 0 }}
        onConfirm={onConfirm}
        onExit={onExit}
      />
    </ReactFlowProvider>,
  );
  return result;
}

beforeEach(() => {
  // jsdom has no layout: stub the overlay root at origin and the img box.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      const isImg = this.tagName === 'IMG';
      return {
        x: isImg ? IMG_BOX.left : 0,
        y: isImg ? IMG_BOX.top : 0,
        left: isImg ? IMG_BOX.left : 0,
        top: isImg ? IMG_BOX.top : 0,
        right: isImg ? IMG_BOX.left + IMG_BOX.width : 1000,
        bottom: isImg ? IMG_BOX.top + IMG_BOX.height : 1000,
        width: isImg ? IMG_BOX.width : 1000,
        height: isImg ? IMG_BOX.height : 1000,
        toJSON: () => ({}),
      } as DOMRect;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Draw a marquee from A to B on the capture layer (screen coordinates).
 * @param from - Pointer-down point.
 * @param to - Pointer-up point.
 */
function draw(from: { x: number; y: number }, to: { x: number; y: number }): void {
  const layer = screen.getByTestId('focus-crop-layer');
  fireEvent.pointerDown(layer, { clientX: from.x, clientY: from.y, button: 0 });
  fireEvent.pointerMove(layer, { clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(layer);
}

describe('FocusCropOverlay', () => {
  it('aligns the capture layer to the node img box', () => {
    renderOverlay();
    const layer = screen.getByTestId('focus-crop-layer');
    expect(layer.style.left).toBe('100px');
    expect(layer.style.top).toBe('50px');
    expect(layer.style.width).toBe('400px');
    expect(layer.style.height).toBe('300px');
  });

  it('draws a marquee in img-local coordinates', () => {
    renderOverlay();
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    const rect = screen.getByTestId('focus-crop-rect');
    expect(rect.style.left).toBe('50px');
    expect(rect.style.top).toBe('50px');
    expect(rect.style.width).toBe('100px');
    expect(rect.style.height).toBe('80px');
    // Eight handles present.
    expect(screen.getByTestId('focus-crop-handle-se')).toBeInTheDocument();
  });

  it('a ratio preset constrains the drawn marquee; re-click clears it', () => {
    renderOverlay();
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    draw({ x: 150, y: 100 }, { x: 250, y: 120 });
    const rect = screen.getByTestId('focus-crop-rect');
    // Dominant axis 100 wide → square 100×100.
    expect(rect.style.width).toBe('100px');
    expect(rect.style.height).toBe('100px');
    expect(
      screen.getByTestId('focus-ratio-1:1').getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    expect(
      screen.getByTestId('focus-ratio-1:1').getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('confirm maps the marquee to natural pixels and clears it', () => {
    const onConfirm = vi.fn();
    renderOverlay(onConfirm);
    const img = screen.getByTestId('image-node-img');
    // Natural 800×600 vs 400×300 display → ×2 mapping.
    Object.defineProperty(img, 'naturalWidth', { value: 800 });
    Object.defineProperty(img, 'naturalHeight', { value: 600 });
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({
      crop: { x: 100, y: 100, width: 200, height: 160 },
      natural: { width: 800, height: 600 },
    });
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
  });

  it('confirm is disabled without a valid marquee', () => {
    renderOverlay();
    expect(
      (screen.getByTestId('focus-crop-confirm') as HTMLButtonElement).disabled,
    ).toBe(true);
    // A sub-minimum scribble stays invalid.
    draw({ x: 150, y: 100 }, { x: 153, y: 103 });
    expect(
      (screen.getByTestId('focus-crop-confirm') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('cancel clears the marquee and stays in the session', () => {
    const onExit = vi.fn();
    renderOverlay(vi.fn(), onExit);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.click(screen.getByTestId('focus-crop-cancel'));
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('Esc clears the marquee first, then exits the session', () => {
    const onExit = vi.fn();
    renderOverlay(vi.fn(), onExit);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
    expect(onExit).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
