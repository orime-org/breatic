// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The expand frame on the node (inner#1303 §6.3): handles grow the frame past
 * the picture, and once grown the picture can be moved inside it. The node is
 * shown 400×300 at 100,50; the source is 1600×1000 pixels.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cropCanvas, installLayout } from '@web/spaces/canvas/crop/__tests__/crop-harness';
import { canvasSessions } from '@web/stores/canvas-session';
import { UNIT_FRAME } from '@web/stores/expand-draft';

const NODE = { id: 'n1', kind: 'img' as const, src: 'https://cdn/a.png' };

/** The session store the canvas under test reads. */
const store = () => canvasSessions.of('').getState();

beforeEach(() => {
  installLayout();
  canvasSessions.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Render the node and open the expand tool on it.
 * @param toolId - The tool.
 */
function mount(toolId = 'image.expand'): void {
  render(cropCanvas([NODE], null));
  act(() => {
    store().openMiniTool('n1', toolId, { sourceContent: NODE.src, params: {} });
    store().setMiniToolSourceSize({ width: 1600, height: 1000 });
    store().setExpandCap(12288);
  });
}

/**
 * Drag with the left button from one screen point to another.
 * @param target - What is pressed.
 * @param from - Where it starts.
 * @param to - Where it ends.
 */
function drag(target: Element, from: [number, number], to: [number, number]): void {
  fireEvent.pointerDown(target, { clientX: from[0], clientY: from[1], button: 0, pointerId: 1 });
  fireEvent.pointerMove(target, { clientX: to[0], clientY: to[1], pointerId: 1 });
  fireEvent.pointerUp(target, { clientX: to[0], clientY: to[1], pointerId: 1 });
}

describe('NodeExpandLayer', () => {
  it('shows a frame at the picture only while the expand tool is open', () => {
    mount('image.crop');
    expect(screen.queryByTestId('mini-tool-expand-frame')).toBeNull();
    act(() => {
      store().openMiniTool('n1', 'image.expand', { sourceContent: NODE.src, params: {} });
      store().setMiniToolSourceSize({ width: 1600, height: 1000 });
    });
    const frame = screen.getByTestId('mini-tool-expand-frame');
    expect(frame.style.left).toBe('0px');
    expect(frame.style.width).toBe('400px');
  });

  it('grows the frame from a handle past the picture', () => {
    mount();
    drag(screen.getByTestId('mini-tool-expand-handle-e'), [500, 200], [700, 200]);
    expect(store().miniTool?.expand?.frame).toEqual({ x: 0, y: 0, width: 1.5, height: 1 });
  });

  it('moves the picture inside a grown frame and keeps the frame’s size', () => {
    mount();
    act(() => store().setExpand({ frame: { x: -0.5, y: 0, width: 2, height: 1 }, ratio: 'free' }));
    drag(screen.getByTestId('mini-tool-expand-source'), [300, 200], [340, 200]);
    expect(store().miniTool?.expand?.frame).toEqual({ x: -0.6, y: 0, width: 2, height: 1 });
  });

  it('puts a moved picture back over the node when a ratio rewrites the frame', () => {
    mount();
    act(() => store().setExpand({ frame: { x: -0.5, y: 0, width: 2, height: 1 }, ratio: 'free' }));
    drag(screen.getByTestId('mini-tool-expand-source'), [300, 200], [340, 200]);
    act(() => store().setExpand({ frame: { x: -0.25, y: 0, width: 1.5, height: 1 }, ratio: '16:9' }));
    // The frame wraps the picture where the node shows it: the picture's copy
    // sits at the node's own picture, 0px from it.
    const frame = screen.getByTestId('mini-tool-expand-frame');
    expect(frame.style.left).toBe('-100px');
    expect(screen.getByTestId('mini-tool-expand-source').style.left).toBe('100px');
  });

  it('keeps a moved picture where it is when Free leaves the frame as it was', () => {
    mount();
    act(() => store().setExpand({ frame: { x: -0.5, y: 0, width: 2, height: 1 }, ratio: '16:9' }));
    drag(screen.getByTestId('mini-tool-expand-source'), [300, 200], [340, 200]);
    const left = screen.getByTestId('mini-tool-expand-frame').style.left;
    act(() => store().setExpand({ frame: store().miniTool!.expand!.frame, ratio: 'free' }));
    expect(screen.getByTestId('mini-tool-expand-frame').style.left).toBe(left);
  });

  it('starts a new opening with the picture over the node', () => {
    mount();
    act(() => store().setExpand({ frame: { x: -0.5, y: 0, width: 2, height: 1 }, ratio: 'free' }));
    drag(screen.getByTestId('mini-tool-expand-source'), [300, 200], [340, 200]);
    // Pull both sides back in to the picture: the frame is the picture's size again.
    drag(screen.getByTestId('mini-tool-expand-handle-w'), [-160, 150], [600, 150]);
    drag(screen.getByTestId('mini-tool-expand-handle-e'), [600, 150], [-600, 150]);
    expect(store().miniTool?.expand?.frame).toEqual(UNIT_FRAME);
    act(() => {
      store().closeActivePanel();
      store().openMiniTool('n1', 'image.expand', { sourceContent: NODE.src, params: {} });
      store().setMiniToolSourceSize({ width: 1600, height: 1000 });
    });
    expect(screen.getByTestId('mini-tool-expand-frame').style.left).toBe('0px');
  });

  it('does not move the picture while the frame is the picture itself', () => {
    mount();
    drag(screen.getByTestId('mini-tool-expand-source'), [300, 200], [340, 200]);
    expect(store().miniTool?.expand?.frame).toEqual(UNIT_FRAME);
  });

  it('ends a drag when something else writes the frame', () => {
    mount();
    const handle = screen.getByTestId('mini-tool-expand-handle-e');
    fireEvent.pointerDown(handle, { clientX: 500, clientY: 200, button: 0, pointerId: 1 });
    act(() => store().setExpand({ frame: UNIT_FRAME, ratio: '1:1' }));
    fireEvent.pointerMove(handle, { clientX: 700, clientY: 200, pointerId: 1 });
    expect(store().miniTool?.expand).toMatchObject({ frame: UNIT_FRAME, ratio: '1:1' });
  });

  it('says how far the frame reaches below the node, so the panel can sit under it', () => {
    mount();
    const flush = store().miniTool?.expand?.drop ?? 0;
    act(() => store().setExpand({ frame: { x: 0, y: 0, width: 1, height: 1.5 }, ratio: 'free' }));
    expect((store().miniTool?.expand?.drop ?? 0) - flush).toBeCloseTo(150, 6);
    act(() => store().setExpand({ frame: { x: 0, y: -0.5, width: 1, height: 1.5 }, ratio: 'free' }));
    expect(store().miniTool?.expand?.drop ?? 0).toBeCloseTo(flush, 6);
  });

  it('keeps presses inside the frame off the canvas', () => {
    mount();
    expect(screen.getByTestId('mini-tool-expand-frame')).toHaveClass('nodrag', 'nopan');
  });
});
