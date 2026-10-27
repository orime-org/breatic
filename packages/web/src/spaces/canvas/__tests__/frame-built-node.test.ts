// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where the canvas goes after a press writes a node beside another (#2175).
 *
 * Two ways to get this wrong, and they are opposites: never moving leaves a
 * press whose only effect is off-screen looking like a press that did
 * nothing, and always moving slides the canvas under a reader who could
 * already see everything.
 */

import { describe, expect, it } from 'vitest';

import {
  CHROME_GAP_PX,
  frameBuiltNode,
  framedBox,
  freshNodesBox,
  viewportForBuilt,
  viewportToInspect,
  NODE_NAME_REACH_PX,
  placedScreenBoxes,
  viewportToShowPlaced,
  ZOOM_STEP,
} from '@web/spaces/canvas/frame-built-node';
import type { Rect } from '@web/spaces/canvas/group-geometry';

const VIEWPORT = { x: 0, y: 0, width: 1000, height: 800 };
/** A node near the right edge of what the reader can see. */
const SOURCE = { x: 650, y: 100, width: 288, height: 200 };
/** Where one step to the right of it lands: past that edge. */
const BUILT = { x: 962, y: 100, width: 288, height: 200 };

describe('framing the node a press just wrote', () => {
  it('moves nothing when the reader can already see it', () => {
    expect(
      frameBuiltNode(
        { x: 100, y: 100, width: 288, height: 200 },
        { x: 400, y: 100, width: 288, height: 200 },
        VIEWPORT,
      ),
    ).toBeNull();
  });

  // Partly visible is not visible: the reader sees a sliver of a node and
  // cannot read what landed in it.
  it('frames both nodes when the new one hangs over the edge', () => {
    // Both span x 650..1250 and y 100..300; the centre of that is the point.
    expect(frameBuiltNode(BUILT, SOURCE, VIEWPORT)).toEqual({
      x: 950,
      y: 200,
    });
  });

  // The zoom is the reader's and this does not touch it, so a pair too far
  // apart to fit at that zoom cannot be framed together. The press produced
  // the built node, so that is what has to be on screen.
  it('shows the new node alone when the pair does not fit', () => {
    const far = { x: -4000, y: 100, width: 288, height: 200 };

    expect(frameBuiltNode(BUILT, far, VIEWPORT)).toEqual({
      x: 1106,
      y: 200,
    });
  });

  // The canvas scrolls, so the viewport is rarely at the origin — a box is
  // judged against where the reader is looking, not against the canvas.
  it('judges against where the reader is looking', () => {
    expect(
      frameBuiltNode(BUILT, SOURCE, { x: 900, y: 0, width: 1000, height: 800 }),
    ).toBeNull();
  });
});

// A paste or duplicate makes several copies at once. Centring on all of them
// only helps when they fit the view together; when they do not, their middle
// can be empty canvas, so the first copy is what gets framed.
describe('what a paste or duplicate frames', () => {
  it('is all the copies when they fit the view together', () => {
    expect(
      framedBox(
        [
          { x: 100, y: 100, width: 288, height: 200 },
          { x: 600, y: 400, width: 288, height: 200 },
        ],
        VIEWPORT,
      ),
    ).toEqual({ x: 100, y: 100, width: 788, height: 500 });
  });

  it('is the first copy when they are wider than the view', () => {
    expect(
      framedBox(
        [
          { x: 24, y: 24, width: 288, height: 200 },
          { x: 2024, y: 24, width: 288, height: 200 },
        ],
        VIEWPORT,
      ),
    ).toEqual({ x: 24, y: 24, width: 288, height: 200 });
  });

  it('is the first copy when they are taller than the view', () => {
    expect(
      framedBox(
        [
          { x: 24, y: 24, width: 288, height: 200 },
          { x: 24, y: 2024, width: 288, height: 200 },
        ],
        VIEWPORT,
      ),
    ).toEqual({ x: 24, y: 24, width: 288, height: 200 });
  });

  it('is nothing when there are no copies', () => {
    expect(framedBox([], VIEWPORT)).toBeNull();
  });
});

describe('viewportForBuilt', () => {
  const pane = { width: 1000, height: 800 };
  /**
   * What the reader sees at this viewport, in canvas coordinates.
   * @param v - The viewport.
   * @param v.x - Its x translation.
   * @param v.y - Its y translation.
   * @param v.zoom - Its zoom.
   * @returns The visible rect.
   */
  const seen = (v: { x: number; y: number; zoom: number }): Rect => ({
    x: -v.x / v.zoom,
    y: -v.y / v.zoom,
    width: pane.width / v.zoom,
    height: pane.height / v.zoom,
  });

  it('leaves the canvas alone while what was built is in view', () => {
    expect(viewportForBuilt({ x: 100, y: 100, width: 200, height: 200 }, null, pane, { x: 0, y: 0, zoom: 1 })).toBeNull();
  });

  it('slides at the reader’s zoom to show the built node with its source when both fit', () => {
    const source = { x: 900, y: 100, width: 200, height: 200 };
    const built = { x: 1200, y: 100, width: 200, height: 200 };
    const v = viewportForBuilt(built, source, pane, { x: 0, y: 0, zoom: 1 })!;
    expect(v.zoom).toBe(1);
    const view = seen(v);
    for (const r of [source, built]) {
      expect(r.x).toBeGreaterThanOrEqual(view.x);
      expect(r.x + r.width).toBeLessThanOrEqual(view.x + view.width);
    }
  });

  it('zooms out just enough to show the whole of a built group too large for the view', () => {
    const group = { x: 1200, y: 100, width: 2500, height: 1800 };
    const v = viewportForBuilt(group, { x: 900, y: 100, width: 200, height: 200 }, pane, { x: 0, y: 0, zoom: 1 })!;
    expect(v.zoom).toBeLessThan(1);
    expect(v.zoom).toBeGreaterThan(0.3);
    const view = seen(v);
    expect(group.x).toBeGreaterThanOrEqual(view.x);
    expect(group.y).toBeGreaterThanOrEqual(view.y);
    expect(group.x + group.width).toBeLessThanOrEqual(view.x + view.width);
    expect(group.y + group.height).toBeLessThanOrEqual(view.y + view.height);
  });

  it('never zooms in past the reader’s zoom', () => {
    const v = viewportForBuilt({ x: 5000, y: 0, width: 100, height: 100 }, null, pane, { x: 0, y: 0, zoom: 0.5 })!;
    expect(v.zoom).toBe(0.5);
  });
});

describe('viewportToInspect', () => {
  const pane = { width: 1440, height: 820 };
  const node = { x: 100, y: 50, width: 288, height: 218.5 };
  // The panel hangs under the node at its screen size whatever the zoom.
  const panel = { width: 344, height: 430, gap: 10 };

  /**
   * Where the node and its panel sit on screen at a viewport.
   * @param v - The viewport.
   * @returns Their top, bottom, left and right in screen pixels.
   */
  function onScreen(v: { x: number; y: number; zoom: number }): { top: number; bottom: number; left: number; right: number } {
    const top = node.y * v.zoom + v.y;
    const nodeBottom = top + node.height * v.zoom;
    const centre = (node.x + node.width / 2) * v.zoom + v.x;
    const half = Math.max(node.width * v.zoom, panel.width) / 2;
    return { top, bottom: nodeBottom + panel.gap + panel.height, left: centre - half, right: centre + half };
  }

  it('zooms in until the node and its panel fill the height, less a tenth either side', () => {
    const v = viewportToInspect(node, panel, pane, { x: 0, y: 0, zoom: 0.5 }, 8)!;
    const at = onScreen(v);
    expect(at.top).toBeCloseTo(pane.height * 0.1, 3);
    expect(at.bottom).toBeCloseTo(pane.height * 0.9, 3);
  });

  it('comes to the same view from any zoom it starts at', () => {
    const from = (zoom: number): number => viewportToInspect(node, panel, pane, { x: 0, y: 0, zoom }, 8)!.zoom;
    expect(from(0.25)).toBeCloseTo(from(0.75), 6);
  });

  // A wide, short picture in a narrow view fills the width, not the height.
  it('stops where a wide node fills the width, less a tenth either side', () => {
    const narrow = { width: 600, height: 820 };
    const wide = { x: 0, y: 0, width: 288, height: 20 };
    const v = viewportToInspect(wide, panel, narrow, { x: 0, y: 0, zoom: 0.5 }, 8)!;
    expect(wide.x * v.zoom + v.x).toBeCloseTo(narrow.width * 0.1, 6);
    expect((wide.x + wide.width) * v.zoom + v.x).toBeCloseTo(narrow.width * 0.9, 6);
  });

  it('stops at the zoom that shows the picture at its own pixels', () => {
    expect(viewportToInspect(node, panel, pane, { x: 0, y: 0, zoom: 0.5 }, 0.8)!.zoom).toBe(0.8);
  });

  it('stays put when the reader is already as close as that, and never zooms out', () => {
    expect(viewportToInspect(node, panel, pane, { x: 0, y: 0, zoom: 2 }, 8)).toBeNull();
  });
});

describe('freshNodesBox', () => {
  // A press that builds two results stacked down the column (a vocal split)
  // frames both, not the first one alone.
  it('covers every node a press built, each at its own footprint', () => {
    const built = [
      { x: 400, y: 100, width: 288, height: 192 },
      { x: 400, y: 316, width: 288, height: 400 },
    ] as const;
    expect(freshNodesBox(built)).toEqual({ x: 400, y: 100, width: 288, height: 616 });
  });

  // A result planned taller than a fresh node is framed whole (inner#1303 §6.7).
  it('is the one node for a press that built one, as tall as it was planned', () => {
    expect(freshNodesBox([{ x: 10, y: 20, width: 288, height: 700 }])).toEqual({ x: 10, y: 20, width: 288, height: 700 });
  });
});

describe('viewportToShowPlaced (inner#1345)', () => {
  const pane = { width: 1000, height: 800 };
  const G = CHROME_GAP_PX;
  // A menu down the left side; a toolbar and a minimap in the bottom right.
  const menu = { x: 16, y: 250, width: 48, height: 300 };
  const toolbar = { x: 700, y: 740, width: 280, height: 44 };
  const minimap = { x: 780, y: 580, width: 200, height: 150 };
  const chrome = [menu, toolbar, minimap];
  const room = { x: G, y: G, width: pane.width - 2 * G, height: pane.height - 2 * G };
  const blocks = chrome.map((b) => ({ x: b.x - G, y: b.y - G, width: b.width + 2 * G, height: b.height + 2 * G }));
  const inside = (r: Rect): boolean => r.x >= room.x && r.y >= room.y && r.x + r.width <= room.x + room.width && r.y + r.height <= room.y + room.height;
  const clear = (r: Rect): boolean => blocks.every((b) => !(r.x < b.x + b.width && b.x < r.x + r.width && r.y < b.y + b.height && b.y < r.y + r.height));
  const card = (x: number, y: number, height = 192): Rect => ({ x, y, width: 288, height });

  it('stays put while the nodes, their names and the panel are clear of what floats over the canvas', () => {
    const view = { nodes: [card(100, 100)] as [Rect], anchor: card(100, 100), panel: { width: 300, height: 200 } };

    expect(viewportToShowPlaced(view, pane, { x: 0, y: 0, zoom: 1 }, chrome, 0.1)).toBeNull();
  });

  it('counts the name above a node, so a node right under the top edge moves down', () => {
    const view = { nodes: [card(300, 30)] as [Rect], anchor: card(300, 30), panel: { width: 300, height: 200 } };
    const next = viewportToShowPlaced(view, pane, { x: 0, y: 0, zoom: 1 }, chrome, 0.1);

    expect(next).toEqual({ x: 0, y: G - (30 - NODE_NAME_REACH_PX), zoom: 1 });
  });

  it('slides at the reader zoom when everything fits there', () => {
    const view = { nodes: [card(30, 100)] as [Rect], anchor: card(30, 100), panel: { width: 200, height: 200 } };
    const next = viewportToShowPlaced(view, pane, { x: 0, y: 0, zoom: 1 }, chrome, 0.1);

    expect(next).toEqual({ x: menu.x + menu.width + G - 30, y: 0, zoom: 1 });
  });

  it('zooms out only as far as it takes for every node and the panel to fit clear', () => {
    const view = {
      nodes: [card(100, 30), card(100, 300, 300), card(450, 100)] as [Rect, Rect, Rect],
      anchor: card(450, 100),
      panel: { width: 600, height: 300 },
    };
    const next = viewportToShowPlaced(view, pane, { x: 0, y: 0, zoom: 1 }, chrome, 0.1);

    expect(next).not.toBeNull();
    expect(next!.zoom).toBeLessThan(1);
    expect(next!.zoom).toBeGreaterThan(0.5);
    const { all } = placedScreenBoxes(view, next!);
    expect(inside(all)).toBe(true);
    expect(clear(all)).toBe(true);
    // One step closer would not have fitted.
    const closer = placedScreenBoxes(view, { ...next!, zoom: next!.zoom / ZOOM_STEP });
    expect(inside(closer.all) && clear(closer.all)).toBe(false);
  });

  it('never zooms in', () => {
    const view = { nodes: [card(30, 100)] as [Rect], anchor: card(30, 100), panel: { width: 200, height: 200 } };
    const next = viewportToShowPlaced(view, pane, { x: 0, y: 0, zoom: 0.5 }, chrome, 0.1);

    expect(next?.zoom).toBe(0.5);
  });

  it('keeps the panel and its node clear at the reader zoom when the nodes cannot fit at the lowest zoom', () => {
    const view = {
      nodes: [card(-20000, 100), card(20000, 100), card(300, 100)] as [Rect, Rect, Rect],
      anchor: card(300, 100),
      panel: { width: 300, height: 200 },
    };
    const next = viewportToShowPlaced(view, pane, { x: 0, y: 0, zoom: 1 }, chrome, 0.1);

    expect(next?.zoom ?? 1).toBe(1);
    const { own } = placedScreenBoxes(view, next ?? { x: 0, y: 0, zoom: 1 });
    expect(inside(own)).toBe(true);
    expect(clear(own)).toBe(true);
  });
});
