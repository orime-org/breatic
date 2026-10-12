// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The grid tool's dividing lines on the node (inner#1303 §6.4): drawn over the
 * picture while the panel is open, following the rows and columns.
 */

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cropCanvas, installLayout } from '@web/spaces/canvas/crop/__tests__/crop-harness';
import { canvasSessions } from '@web/stores/canvas-session';

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
 * Render the node and open a tool on it.
 * @param toolId - The tool.
 * @param params - Its params.
 */
function mount(toolId: string, params: Record<string, unknown>): void {
  render(cropCanvas([NODE], null));
  act(() => store().openMiniTool('n1', toolId, { sourceContent: NODE.src, params }));
}

/**
 * Where the drawn lines sit, as percentages of the picture.
 * @param axis - `col` for the vertical lines, `row` for the horizontal ones.
 * @returns Their offsets.
 */
function lines(axis: 'row' | 'col'): string[] {
  return screen
    .queryAllByTestId(`mini-tool-grid-${axis}`)
    .map((line) => (axis === 'col' ? line.style.left : line.style.top));
}

describe('NodeGridLayer', () => {
  it('draws the lines that cut the picture into the rows and columns asked', () => {
    mount('image.grid', { rows: 2, cols: 4 });
    expect(lines('col')).toEqual(['25%', '50%', '75%']);
    expect(lines('row')).toEqual(['50%']);
  });

  it('follows the rows and columns as they change', () => {
    mount('image.grid', { rows: 2, cols: 4 });
    act(() => store().setMiniToolParam('rows', 1));
    expect(lines('row')).toEqual([]);
    expect(lines('col')).toHaveLength(3);
  });

  it('draws the default three by three when the draft leaves them out', () => {
    mount('image.grid', {});
    expect(lines('col')).toHaveLength(2);
    expect(lines('row')).toHaveLength(2);
  });

  it('draws nothing for another tool', () => {
    mount('image.crop', {});
    expect(screen.queryByTestId('mini-tool-grid-layer')).toBeNull();
  });
});
