// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The grid tool's layer on the node (inner#1303 §6.4, A15): the dividing lines
 * over the picture while the panel is open, following the rows and columns,
 * and a tile the reader picks or leaves out by clicking it.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
 * @param zoom - The canvas zoom.
 */
function mount(toolId: string, params: Record<string, unknown>, zoom = 1): void {
  render(cropCanvas([NODE], null, zoom));
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

describe('NodeGridLayer tile picking', () => {
  /**
   * Whether each tile is picked, row by row, as its checkbox shows it.
   * @returns One flag per tile.
   */
  const ticks = (): boolean[] =>
    screen.getAllByTestId(/^mini-tool-grid-check-/).map((box) => box.getAttribute('data-state') === 'checked');

  it('ticks every tile when the panel opens', () => {
    mount('image.grid', { rows: 2, cols: 2, skip: [] });
    expect(ticks()).toEqual([true, true, true, true]);
    expect(screen.getAllByTestId(/^mini-tool-grid-tile-/).map((tile) => tile.dataset.picked)).toEqual([
      'true',
      'true',
      'true',
      'true',
    ]);
  });

  it('leaves a clicked tile out and dims it, and picks it again on a second click', () => {
    mount('image.grid', { rows: 2, cols: 2, skip: [] });
    const tile = screen.getByTestId('mini-tool-grid-tile-1');
    expect(tile.style.backgroundColor).toBe('');
    fireEvent.click(tile);
    expect(store().miniTool?.params.skip).toEqual([1]);
    expect(ticks()).toEqual([true, false, true, true]);
    expect(tile.dataset.picked).toBe('false');
    // The same black the crop frame darkens outside its box with, in both themes.
    expect(getComputedStyle(tile).backgroundColor).toBe('rgba(0, 0, 0, 0.4)');
    fireEvent.click(tile);
    expect(store().miniTool?.params.skip).toEqual([]);
    expect(tile.style.backgroundColor).toBe('');
  });

  it('toggles a tile once when its checkbox is clicked', () => {
    const write = vi.spyOn(store(), 'setMiniToolParam');
    mount('image.grid', { rows: 2, cols: 2, skip: [] });
    fireEvent.click(screen.getByTestId('mini-tool-grid-check-2'));
    expect(write).toHaveBeenCalledOnce();
    expect(store().miniTool?.params.skip).toEqual([2]);
  });

  it('toggles a tile with Space on its focused checkbox', async () => {
    mount('image.grid', { rows: 2, cols: 2, skip: [3] });
    screen.getByTestId('mini-tool-grid-check-3').focus();
    await userEvent.keyboard(' ');
    expect(store().miniTool?.params.skip).toEqual([]);
  });

  it('keeps a press on a tile from dragging or panning the canvas', () => {
    mount('image.grid', { rows: 2, cols: 2, skip: [] });
    const tile = screen.getByTestId('mini-tool-grid-tile-0');
    expect(tile).toHaveClass('nodrag');
    expect(tile).toHaveClass('nopan');
  });

  // A Shift press must not start the canvas marquee, and a Cmd/Ctrl click must
  // not unselect the host, which would close the panel.
  it('keeps the canvas marquee and node clicks off its tiles', () => {
    mount('image.grid', { rows: 2, cols: 2, skip: [] });
    const layer = screen.getByTestId('mini-tool-grid-layer');
    expect(layer).toHaveClass('nokey');
    const reached = vi.fn();
    document.addEventListener('click', reached);
    fireEvent.click(screen.getByTestId('mini-tool-grid-tile-0'), { metaKey: true });
    document.removeEventListener('click', reached);
    // React stops it at the layer: nothing above it, the node included, sees it.
    expect(reached).not.toHaveBeenCalled();
    expect(screen.getByTestId('mini-tool-grid-tile-0').dataset.picked).toBe('false');
  });

  // §6.4: the node draws the cuts the export makes, from the source's pixels.
  it('draws each line where the export cuts the source', () => {
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(1007);
    vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(1007);
    mount('image.grid', { rows: 1, cols: 8, skip: [] });
    const lines = screen.getAllByTestId('mini-tool-grid-col');
    expect(parseFloat(lines[6]!.style.left)).toBeCloseTo((881 / 1007) * 100, 6);
  });

  it('draws a round checkbox', () => {
    mount('image.grid', { rows: 2, cols: 2, skip: [] });
    expect(screen.getByTestId('mini-tool-grid-check-0')).toHaveClass('rounded-full');
  });

  // The picture is 400 by 300; a checkbox needs 24 screen px of tile both ways.
  it.each([
    ['tall enough', { rows: 8, cols: 1 }, 0.64, 1],
    ['too short', { rows: 8, cols: 1 }, 0.63, 0],
    ['wide enough', { rows: 1, cols: 8 }, 0.48, 1],
    ['too narrow', { rows: 1, cols: 8 }, 0.47, 0],
  ])('draws checkboxes on tiles %s on screen', (_, shape, zoom, shown) => {
    mount('image.grid', { ...shape, skip: [] }, zoom);
    expect(screen.queryAllByTestId(/^mini-tool-grid-check-/).length > 0 ? 1 : 0).toBe(shown);
  });

  it('dims an unpicked tile too small for a checkbox', () => {
    // 300 px of picture over 8 rows at half zoom: 18.75 screen px a tile.
    mount('image.grid', { rows: 8, cols: 1, skip: [0] }, 0.5);
    expect(screen.queryAllByTestId(/^mini-tool-grid-check-/)).toEqual([]);
    expect(screen.getByTestId('mini-tool-grid-tile-0').dataset.picked).toBe('false');
    expect(screen.getByTestId('mini-tool-grid-tile-1').dataset.picked).toBe('true');
  });
});
