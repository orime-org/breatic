// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The expand frame (inner#1303 §6.3): handles grow the frame past the
 * picture while the target background moves around the fixed source. The node sits at
 * the canvas's origin, which is on screen at 100,50, so its picture shows
 * 400×300 at 100,50; the source is 1600×1000 pixels. The frame is drawn in the
 * canvas's viewport, the cover in the node.
 */

import type { ModelCatalog, ModelEntry } from '@breatic/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ViewportPortal, useReactFlow, type Node, type ReactFlowInstance } from '@xyflow/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { modelsApi } from '@web/data/api';
import { cropCanvas, installLayout } from '@web/spaces/canvas/crop/__tests__/crop-harness';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { ExpandFrameOverlay } from '@web/spaces/canvas/mini-tool/ExpandFrameOverlay';
import { canvasSessions } from '@web/stores/canvas-session';
import { UNIT_FRAME } from '@web/stores/expand-draft';

const NODE = { id: 'n1', kind: 'img' as const, src: 'https://cdn/a.png' };

/** The session store the canvas under test reads. */
const store = () => canvasSessions.of('').getState();

/** The catalog with the expand tool's model, whose longest side is 12288. */
const CATALOG = {
  image: [{ name: 'bria-genfill', mode: ['expand'], max_output_side: 12288, params: {} } as unknown as ModelEntry],
  video: [], audio: [], tts: [], three_d: [], total: 1, credit_multiplier: 1,
} as unknown as ModelCatalog;

/** The query cache the frame reads the model's cap from; seeded with {@link CATALOG}. */
let client: QueryClient;

beforeEach(() => {
  installLayout();
  canvasSessions.clear();
  // The catalog arrives only when a test puts it in the cache.
  vi.spyOn(modelsApi, 'list').mockReturnValue(new Promise(() => {}));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(modelCatalogQuery().queryKey, CATALOG);
});

afterEach(() => {
  vi.restoreAllMocks();
  nodeMenu.mockClear();
});

/** The canvas instance, for a test that pans or zooms mid-drag. */
let flowApi: ReactFlowInstance | null = null;

/**
 * Hands the test the canvas instance.
 * @returns Nothing.
 */
function GrabFlow(): null {
  flowApi = useReactFlow();
  return null;
}

/** What a right-click on the frame hands the canvas's node menu. */
const nodeMenu = vi.fn<(event: React.MouseEvent, node: Node) => void>();

/**
 * The canvas with the node and the frame drawn in its viewport.
 * @param zoom - The canvas zoom.
 * @param snapToGrid - Whether the canvas snaps nodes to its grid.
 * @returns The tree.
 */
const canvas = (zoom = 1, snapToGrid = false) => (
  <QueryClientProvider client={client}>
    {cropCanvas(
      [NODE],
      <>
        <ViewportPortal>
          <ExpandFrameOverlay onNodeContextMenu={nodeMenu} />
        </ViewportPortal>
        <GrabFlow />
      </>,
      zoom,
      { x: 100, y: 50 },
      { snapToGrid, snapGrid: [24, 24] },
    )}
  </QueryClientProvider>
);

/**
 * Render the node and open the expand tool on it.
 * @param toolId - The tool.
 * @param zoom - The canvas zoom.
 * @returns What render gives.
 */
function mount(toolId = 'image.expand', zoom = 1, snapToGrid = false): ReturnType<typeof render> {
  const view = render(canvas(zoom, snapToGrid));
  act(() => {
    store().openMiniTool('n1', toolId, { sourceContent: NODE.src, params: {} });
    store().setMiniToolSourceSize({ width: 1600, height: 1000 });
  });
  return view;
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
  it.each([
    { label: 'right and down', zoom: 1, to: [90, 50], x: -0.4, y: -0.4, snap: false },
    { label: 'left and up', zoom: 1, to: [10, -10], x: -0.6, y: -0.6, snap: false },
    { label: 'zoomed out', zoom: 0.5, to: [90, 50], x: -0.3, y: -0.3, snap: false },
    { label: 'zoomed in', zoom: 2, to: [90, 50], x: -0.45, y: -0.45, snap: false },
    { label: 'right and bottom limits', zoom: 1, to: [450, 320], x: 0, y: 0, snap: false },
    { label: 'left and top limits', zoom: 1, to: [-350, -280], x: -1, y: -1, snap: false },
    { label: 'grid enabled', zoom: 1, to: [90, 50], x: -0.4, y: -0.4, snap: true },
  ])('moves the background with the pointer at $label while the source stays fixed', ({ zoom, to, x, y, snap }) => {
    mount('image.expand', zoom, snap);
    act(() => store().setExpand({ frame: { x: -0.5, y: -0.5, width: 2, height: 2 }, ratio: 'free' }));
    const position = { ...flowApi!.getNode('n1')!.position };
    const frame = screen.getByTestId('mini-tool-expand-frame');
    drag(frame, [50, 20], [to[0]!, to[1]!]);
    expect(store().miniTool?.expand?.frame).toEqual({ x, y, width: 2, height: 2 });
    const source = screen.getByTestId('mini-tool-expand-source');
    expect(parseFloat(frame.style.left) + parseFloat(frame.style.borderWidth) + parseFloat(source.style.left)).toBeCloseTo(0, 9);
    expect(parseFloat(frame.style.top) + parseFloat(frame.style.borderWidth) + parseFloat(source.style.top)).toBeCloseTo(0, 9);
    expect(flowApi!.getNode('n1')!.position).toEqual(position);
    expect(source.getAttribute('src')).toBe(NODE.src);
    expect([source.style.width, source.style.height]).toEqual(['400px', '300px']);
  });

  it('keeps the source at its node when the source itself is dragged', () => {
    mount();
    const frame = { x: -0.5, y: -0.5, width: 2, height: 2 };
    act(() => store().setExpand({ frame, ratio: 'free' }));
    drag(screen.getByTestId('mini-tool-expand-source'), [300, 200], [340, 230]);
    expect(store().miniTool?.expand?.frame).toEqual(frame);
    const element = screen.getByTestId('mini-tool-expand-frame');
    const source = screen.getByTestId('mini-tool-expand-source');
    expect(parseFloat(element.style.left) + parseFloat(element.style.borderWidth) + parseFloat(source.style.left)).toBeCloseTo(0, 9);
    expect(parseFloat(element.style.top) + parseFloat(element.style.borderWidth) + parseFloat(source.style.top)).toBeCloseTo(0, 9);
    expect(flowApi!.getNode('n1')!.position).toEqual({ x: 0, y: 0 });
  });

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

  // The handles stop at the long-side cap (A5), so there is no frame to drag
  // until the model's catalog entry has said what the cap is.
  it('draws no frame until the cap is known', async () => {
    client.removeQueries({ queryKey: modelCatalogQuery().queryKey });
    render(canvas(1, false));
    act(() => {
      store().openMiniTool('n1', 'image.expand', { sourceContent: NODE.src, params: {} });
      store().setMiniToolSourceSize({ width: 1600, height: 1000 });
    });
    expect(screen.queryByTestId('mini-tool-expand-frame')).toBeNull();
    act(() => client.setQueryData(modelCatalogQuery().queryKey, CATALOG));
    expect(await screen.findByTestId('mini-tool-expand-frame')).toBeTruthy();
  });

  // The canvas unmounts a node whose own box is off screen, while the frame
  // reaches past it: the frame is drawn in the viewport, outside the node.
  it('draws the frame in the canvas’s viewport, outside the node', () => {
    mount();
    const frame = screen.getByTestId('mini-tool-expand-frame');
    expect(frame.closest('.react-flow__node')).toBeNull();
    expect(frame.closest('.react-flow__viewport-portal')).not.toBeNull();
    expect(screen.getByTestId('mini-tool-expand-cover').closest('.react-flow__node')).not.toBeNull();
  });

  it('keeps the target frame and fixed source when the canvas is drawn again', () => {
    const { unmount } = mount();
    act(() => store().setExpand({ frame: { x: -0.5, y: 0, width: 2, height: 1 }, ratio: 'free' }));
    drag(screen.getByTestId('mini-tool-expand-frame'), [50, 150], [90, 150]);
    const left = screen.getByTestId('mini-tool-expand-frame').style.left;
    unmount();
    render(canvas());
    expect(screen.getByTestId('mini-tool-expand-frame').style.left).toBe(left);
    expect(store().miniTool?.expand?.frame).toEqual({ x: -0.4, y: 0, width: 2, height: 1 });
  });

  it('keeps the canvas marquee and node clicks off its frame', () => {
    mount();
    const frame = screen.getByTestId('mini-tool-expand-frame');
    expect(frame).toHaveClass('nokey');
    const reached = vi.fn();
    document.addEventListener('click', reached);
    fireEvent.click(frame, { metaKey: true });
    document.removeEventListener('click', reached);
    // React stops it at the frame: nothing above it, the node included, sees it.
    expect(reached).not.toHaveBeenCalled();
  });

  it('grows the frame from a handle past the picture', () => {
    mount();
    drag(screen.getByTestId('mini-tool-expand-handle-e'), [500, 200], [700, 200]);
    expect(store().miniTool?.expand?.frame).toEqual({ x: 0, y: 0, width: 1.5, height: 1 });
  });

  // The handle stops at the long side the model's catalog entry gives (A5).
  it('stops a handle at the long side the model’s catalog entry gives', () => {
    const capped = { ...CATALOG, image: [{ ...CATALOG.image[0]!, max_output_side: 2000 }] } as ModelCatalog;
    client.setQueryData(modelCatalogQuery().queryKey, capped);
    mount();
    drag(screen.getByTestId('mini-tool-expand-handle-e'), [500, 200], [900, 200]);
    expect(store().miniTool?.expand?.frame.width).toBeCloseTo(2000 / 1600, 9);
  });

  it('moves the background while keeping a source-height target at the source vertically', () => {
    mount();
    act(() => store().setExpand({ frame: { x: -0.5, y: 0, width: 2, height: 1 }, ratio: 'free' }));
    drag(screen.getByTestId('mini-tool-expand-frame'), [50, 150], [90, 180]);
    expect(store().miniTool?.expand?.frame).toEqual({ x: -0.4, y: 0, width: 2, height: 1 });
  });

  it('keeps the source over the node when a ratio rewrites a moved target', () => {
    mount();
    act(() => store().setExpand({ frame: { x: -0.5, y: 0, width: 2, height: 1 }, ratio: 'free' }));
    drag(screen.getByTestId('mini-tool-expand-frame'), [50, 150], [90, 150]);
    act(() => store().setExpand({ frame: { x: -0.25, y: 0, width: 1.5, height: 1 }, ratio: '16:9' }));
    // The frame wraps the picture where the node shows it: the picture's copy
    // sits at the node's own picture, 0px from it (−100 + the 1px border + 99).
    const frame = screen.getByTestId('mini-tool-expand-frame');
    expect(frame.style.left).toBe('-100px');
    expect(screen.getByTestId('mini-tool-expand-source').style.left).toBe('99px');
  });

  it('keeps the frame and source cover anchored when an edge reaches the source', () => {
    mount();
    act(() => store().setExpand({ frame: { x: 0, y: 0, width: 2, height: 1 }, ratio: 'free' }));
    drag(screen.getByTestId('mini-tool-expand-frame'), [600, 150], [640, 150]);
    drag(screen.getByTestId('mini-tool-expand-handle-w'), [200, 150], [400, 150]);
    const frame = screen.getByTestId('mini-tool-expand-frame');
    expect(parseFloat(frame.style.left)).toBe(0);
    const cover = screen.getByTestId('mini-tool-expand-cover');
    expect([cover.style.left, cover.style.top, cover.style.width, cover.style.height]).toEqual(['0px', '0px', '400px', '300px']);
  });

  it('keeps the moved target when Free leaves the frame as it was', () => {
    mount();
    act(() => store().setExpand({ frame: { x: -0.5, y: 0, width: 2, height: 1 }, ratio: '16:9' }));
    drag(screen.getByTestId('mini-tool-expand-frame'), [50, 150], [90, 150]);
    const left = screen.getByTestId('mini-tool-expand-frame').style.left;
    act(() => store().setExpand({ frame: store().miniTool!.expand!.frame, ratio: 'free' }));
    expect(screen.getByTestId('mini-tool-expand-frame').style.left).toBe(left);
  });

  it('starts a new opening with the picture over the node', () => {
    mount();
    act(() => store().setExpand({ frame: { x: -0.5, y: 0, width: 2, height: 1 }, ratio: 'free' }));
    drag(screen.getByTestId('mini-tool-expand-frame'), [50, 150], [90, 150]);
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

  // The handles follow the pointer, not the grid nodes snap to.
  it('grows the frame by exactly the pointer’s move with grid snapping on', () => {
    mount('image.expand', 1, true);
    drag(screen.getByTestId('mini-tool-expand-handle-e'), [500, 200], [510, 200]);
    expect(store().miniTool?.expand?.frame.width).toBeCloseTo(1.025, 9);
  });

  it('keeps the grabbed background point under the pointer when the canvas zooms mid-drag', () => {
    mount();
    act(() => store().setExpand({ frame: { x: -0.5, y: 0, width: 2, height: 1 }, ratio: 'free' }));
    const frame = screen.getByTestId('mini-tool-expand-frame');
    fireEvent.pointerDown(frame, { clientX: 50, clientY: 150, button: 0, pointerId: 1 });
    act(() => {
      void flowApi?.setViewport({ x: 100, y: 50, zoom: 2 });
    });
    fireEvent.pointerMove(frame, { clientX: 70, clientY: 150, pointerId: 1 });
    // Canvas x changes from -50 to -15 as the viewport zoom changes.
    expect(store().miniTool?.expand?.frame.x).toBeCloseTo(-0.5 + 35 / 400, 9);
  });

  // A drag the panel closed under (the host deleted while the button is held)
  // ends with the opening; the next opening's handles answer.
  it('drops a drag cut short by closing the panel, so the next opening drags', () => {
    mount();
    fireEvent.pointerDown(screen.getByTestId('mini-tool-expand-handle-e'), { clientX: 500, clientY: 200, button: 0, pointerId: 1 });
    act(() => store().closeActivePanel());
    act(() => {
      store().openMiniTool('n1', 'image.expand', { sourceContent: NODE.src, params: {} });
      store().setMiniToolSourceSize({ width: 1600, height: 1000 });
    });
    drag(screen.getByTestId('mini-tool-expand-handle-w'), [100, 200], [0, 200]);
    expect(store().miniTool?.expand?.frame.x).toBeCloseTo(-0.25, 9);
  });

  // A source reset that leaves the frame at the picture takes the frame off
  // the page under a held handle; a frame not drawn has no drag, so the
  // handles answer once it is back and a pointer only passing over moves nothing.
  it('drops a drag whose frame was taken off the page by a source reset', () => {
    mount();
    fireEvent.pointerDown(screen.getByTestId('mini-tool-expand-handle-e'), { clientX: 500, clientY: 200, button: 0, pointerId: 1 });
    act(() => store().resetMiniToolSource(NODE.src, {}));
    act(() => {
      store().setMiniToolSourceSize({ width: 1600, height: 1000 });
    });
    const before = store().miniTool?.expand?.frame;
    fireEvent.pointerMove(screen.getByTestId('mini-tool-expand-handle-w'), { clientX: 700, clientY: 200, pointerId: 1, buttons: 0 });
    expect(store().miniTool?.expand?.frame).toEqual(before);
    drag(screen.getByTestId('mini-tool-expand-handle-w'), [100, 200], [0, 200]);
    expect(store().miniTool?.expand?.frame.x).toBeCloseTo(-0.25, 9);
  });

  // §6.3: the copy sits at the picture's own place; the frame's border is
  // drawn around it, not under its top-left corner.
  it('draws the picture copy at the node picture’s place, inside the border', () => {
    mount();
    const source = screen.getByTestId('mini-tool-expand-source');
    expect([source.style.left, source.style.top]).toEqual(['-1px', '-1px']);
  });

  // §6.2: a tool layer keeps the node's menu, as it does inside the node.
  it.each(['mini-tool-expand-frame', 'mini-tool-expand-handle-e'])(
    'opens the host node’s menu on a right-click on %s',
    (testId) => {
      mount();
      fireEvent.contextMenu(screen.getByTestId(testId));
      // The menu handler decides the browser's own menu, as it does on the node.
      expect(nodeMenu).toHaveBeenCalledOnce();
      expect(nodeMenu.mock.calls[0]?.[1]).toMatchObject({ id: 'n1' });
    },
  );

  it('keeps presses inside the frame off the canvas', () => {
    mount();
    expect(screen.getByTestId('mini-tool-expand-frame')).toHaveClass('nodrag', 'nopan');
  });
});
