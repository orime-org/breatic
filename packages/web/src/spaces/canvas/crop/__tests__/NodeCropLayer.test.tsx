// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The crop box of the crop tools inside the node (inner#888 §7.4.1): held in
 * the tool's draft in source pixels and drawn in the node's own pixels.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canvasSessions } from '@web/stores/canvas-session';
import {
  IMG_BOX,
  cropCanvas,
  draw,
  installLayout,
  rectSize,
  relayout,
} from '@web/spaces/canvas/crop/__tests__/crop-harness';

const NODE = { id: 'n1', kind: 'img' as const, src: 'https://cdn/a.png' };

beforeEach(() => {
  installLayout();
  canvasSessions.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The session store the canvas under test reads. */
const store = () => canvasSessions.of('').getState();

/**
 * Render the node with its picture at 800×600, shown 400×300.
 * @returns The picture.
 */
function mount(): HTMLImageElement {
  render(cropCanvas([NODE], null));
  const img = screen.getByTestId('image-node-img') as HTMLImageElement;
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 800 });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 600 });
  return img;
}

/**
 * Open a tool's panel on the node.
 * @param toolId - The tool.
 * @param params - Its starting params.
 */
function open(toolId: string, params: Record<string, unknown>): void {
  act(() => store().openMiniTool('n1', toolId, { sourceContent: NODE.src, params }));
}

describe('NodeCropLayer for a crop tool', () => {
  it('frames the whole picture until a crop is set, and records the source size', () => {
    mount();
    open('image.crop', { aspect: 'free', rect: null });
    expect(rectSize('mini-tool-crop')).toEqual({ left: 0, top: 0, width: 400, height: 300 });
    expect(store().miniTool?.sourceSize).toEqual({ width: 800, height: 600 });
  });

  it('draws a source-pixel crop at the size the node shows it', () => {
    mount();
    open('image.crop', { aspect: 'free', rect: { x: 200, y: 0, w: 400, h: 300 } });
    expect(rectSize('mini-tool-crop')).toEqual({ left: 100, top: 0, width: 200, height: 150 });
  });

  it('writes a drawn box back in source pixels', () => {
    mount();
    open('image.crop', { aspect: 'free', rect: null });
    draw({ x: 150, y: 100 }, { x: 250, y: 180 }, 'mini-tool-crop');
    expect(store().miniTool?.params.rect).toEqual({ x: 100, y: 100, w: 200, h: 160 });
  });

  it('rounds the handles while the box is free and squares them under a ratio', () => {
    mount();
    open('image.crop', { aspect: 'free', rect: null });
    expect(screen.getByTestId('mini-tool-crop-handle-se').className).toContain('rounded-full');
    act(() => store().setMiniToolParam('aspect', '1:1'));
    expect(screen.getByTestId('mini-tool-crop-handle-se').className).not.toContain('rounded-full');
  });

  it('holds a drawn box to the chosen ratio', () => {
    mount();
    open('image.crop', { aspect: '1:1', rect: null });
    const layer = screen.getByTestId('mini-tool-crop-layer');
    fireEvent.pointerDown(layer, { clientX: 110, clientY: 60, button: 0, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 260, clientY: 180, pointerId: 1 });
    const r = rectSize('mini-tool-crop');
    expect(r.width).toBe(r.height);
  });

  it('drops a box too small to crop back to the whole picture', () => {
    mount();
    open('image.crop', { aspect: 'free', rect: { x: 0, y: 0, w: 400, h: 300 } });
    const layer = screen.getByTestId('mini-tool-crop-layer');
    fireEvent.pointerDown(layer, { clientX: 150, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerUp(layer, { pointerId: 1 });
    expect(store().miniTool?.params.rect).toBeNull();
  });

  // The source changed under the panel and the draft was reset: a pointer
  // still held from before cannot write the old box back onto the new source.
  it('ends a drag when the box is written by the panel', () => {
    mount();
    open('image.crop', { aspect: 'free', rect: null });
    const layer = screen.getByTestId('mini-tool-crop-layer');
    fireEvent.pointerDown(layer, { clientX: 150, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 250, clientY: 180, pointerId: 1 });
    act(() => store().resetMiniToolSource('https://cdn/a.png', { rect: null }));
    fireEvent.pointerMove(layer, { clientX: 300, clientY: 220, pointerId: 1 });
    expect(store().miniTool?.params.rect).toBeNull();
  });

  it('shows nothing until the picture reports its size', async () => {
    render(cropCanvas([NODE], null));
    open('image.crop', { aspect: 'free', rect: null });
    expect(screen.queryByTestId('mini-tool-crop-layer')).toBeNull();
    expect(store().miniTool?.sourceSize).toBeNull();
    const img = screen.getByTestId('image-node-img');
    Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 800 });
    Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 600 });
    await relayout();
    expect(screen.getByTestId('mini-tool-crop-layer')).toBeInTheDocument();
  });

  it('follows the node as its shown size changes', async () => {
    mount();
    open('image.crop', { aspect: 'free', rect: { x: 200, y: 0, w: 400, h: 300 } });
    IMG_BOX.width = 200;
    IMG_BOX.height = 150;
    await relayout();
    expect(rectSize('mini-tool-crop')).toEqual({ left: 50, top: 0, width: 100, height: 75 });
  });

  it('is not drawn for a tool without a crop, during a pick, or on another node', () => {
    mount();
    open('image.rotate', { orient: { rotate: 0, flipX: false, flipY: false } });
    expect(screen.queryByTestId('mini-tool-crop-layer')).toBeNull();
    open('image.crop', { aspect: 'free', rect: null });
    act(() => store().startMiniToolSlotPick('n1', 'image'));
    expect(screen.queryByTestId('mini-tool-crop-layer')).toBeNull();
    act(() => store().openMiniTool('other', 'image.crop', { sourceContent: 'x', params: {} }));
    expect(screen.queryByTestId('mini-tool-crop-layer')).toBeNull();
  });
});
