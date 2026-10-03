// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A1 and A2: the 9 × 9 grid a table's size is picked from.
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@web/components/ui/dropdown-menu';
import { DocumentTableSizeGrid } from '@web/spaces/document/DocumentTableSizeGrid';

/**
 * Renders the grid in an open menu.
 * @returns What a pick hands back.
 */
function open(): ReturnType<typeof vi.fn> {
  const onPick = vi.fn();
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger>open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DocumentTableSizeGrid onPick={onPick} />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  return onPick;
}

/**
 * One cell of the grid.
 * @param rows - Its row, from 1.
 * @param cols - Its column, from 1.
 * @returns The element.
 */
function cell(rows: number, cols: number): HTMLElement {
  return screen.getByTestId(`doc-table-size-${rows}-${cols}`);
}

/**
 * The cells drawn as in the picked size.
 * @returns Their test ids.
 */
function lit(): string[] {
  return Array.from(document.querySelectorAll('[data-testid^="doc-table-size-"][data-on]')).map(
    (el) => el.getAttribute('data-testid')!,
  );
}

describe('the table size grid', () => {
  it('draws nine rows of nine cells', () => {
    open();
    expect(document.querySelectorAll('[data-testid^="doc-table-size-"][data-rows]')).toHaveLength(81);
  });

  it('lights the cells up to the one under the pointer and names the size', () => {
    open();

    fireEvent.focus(cell(2, 3));

    expect(lit()).toEqual([
      'doc-table-size-1-1',
      'doc-table-size-1-2',
      'doc-table-size-1-3',
      'doc-table-size-2-1',
      'doc-table-size-2-2',
      'doc-table-size-2-3',
    ]);
    expect(screen.getByTestId('doc-table-size-label').textContent).toMatch(/2.*3/);
  });

  it('hands back the size of the cell picked', () => {
    const onPick = open();

    fireEvent.click(cell(3, 4));

    expect(onPick).toHaveBeenCalledWith({ rows: 3, cols: 4 });
  });

  it.each([
    ['ArrowRight', [1, 1], [1, 2]],
    ['ArrowDown', [1, 2], [2, 2]],
    ['ArrowLeft', [2, 2], [2, 1]],
    ['ArrowUp', [2, 1], [1, 1]],
  ] as const)('%s moves the focus to the next cell that way', (key, from, to) => {
    open();
    cell(from[0], from[1]).focus();

    fireEvent.keyDown(cell(from[0], from[1]), { key });

    expect(document.activeElement).toBe(cell(to[0], to[1]));
  });

  it('stays on the last row and column at the far edges', () => {
    open();
    cell(9, 9).focus();

    fireEvent.keyDown(cell(9, 9), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cell(9, 9));
    fireEvent.keyDown(cell(9, 9), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cell(9, 9));
  });
});
