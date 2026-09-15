// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ReactFlowProvider, type MiniMapNodeProps } from '@xyflow/react';

import { CanvasMiniMapNode } from '@web/spaces/canvas/CanvasMiniMapNode';
import { PIN_SCREEN_SIZE } from '@web/spaces/canvas/annotation/pin-geometry';

const NODES = [
  { id: 'note', type: 'annotation', position: { x: 100, y: 400 }, data: {} },
  { id: 'pic', type: 'image', position: { x: 0, y: 0 }, data: {} },
];

/**
 * The rect the minimap hands a node component.
 * @param over - Fields to override.
 * @returns The props.
 */
const rect = (over: Partial<MiniMapNodeProps> = {}): MiniMapNodeProps => ({
  id: 'note',
  x: 100,
  y: 120,
  width: 280,
  height: 280,
  borderRadius: 0,
  className: '',
  shapeRendering: 'crispEdges',
  selected: false,
  ...over,
});

/**
 * Paint one node on a minimap that holds both a note and a picture.
 * @param props - The rect to paint.
 * @returns The rect element that came out.
 */
function paint(props: MiniMapNodeProps): SVGRectElement {
  const { container } = render(
    <ReactFlowProvider initialNodes={NODES}>
      <svg>
        <CanvasMiniMapNode {...props} />
      </svg>
    </ReactFlowProvider>,
  );
  const el = container.querySelector('rect');
  if (el === null) throw new Error('nothing was painted');
  return el;
}

describe('what the minimap paints for a note (#1881)', () => {
  it('draws a note at a fixed patch of the board, not at the rect it holds', () => {
    // 280 is what a pin measures at 10% zoom — the size of an image node,
    // and zooming out to survey the board is exactly when somebody reads
    // this map.
    const el = paint(rect());
    expect(el.getAttribute('width')).toBe(String(PIN_SCREEN_SIZE));
    expect(el.getAttribute('height')).toBe(String(PIN_SCREEN_SIZE));
  });

  it('keeps that patch on the point the note marks, whatever the zoom', () => {
    // The pin's origin puts its rect above the point it marks, so the bottom
    // edge is the point: 120 + 280 = 400 either way.
    expect(paint(rect()).getAttribute('y')).toBe(String(400 - PIN_SCREEN_SIZE));
    expect(
      paint(rect({ y: 390, height: 10 })).getAttribute('y'),
    ).toBe(String(400 - PIN_SCREEN_SIZE));
  });

  it('leaves every other node the rect it was handed', () => {
    const el = paint(rect({ id: 'pic', x: 0, y: 0, width: 288, height: 162 }));
    expect(el.getAttribute('width')).toBe('288');
    expect(el.getAttribute('height')).toBe('162');
    expect(el.getAttribute('y')).toBe('0');
  });
});
