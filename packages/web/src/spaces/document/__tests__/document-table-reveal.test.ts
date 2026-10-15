// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, afterEach } from 'vitest';

import { revealInTable } from '@web/spaces/document/document-table-reveal';

/** How wide the frame's "more to scroll" edges are in these cases. */
const EDGE = 12;

/**
 * A wide table's frame holding one cell of commented words, with the frame
 * and the cell placed where the case says.
 * @param frame - The frame's left and right edges on screen.
 * @param cell - The cell's left and right edges on screen.
 * @param inTable - Whether the words sit inside a table's frame.
 * @returns The words and the frame's scroll spy.
 */
function place(
  frame: { left: number; right: number },
  cell: { left: number; right: number },
  inTable = true,
): { words: HTMLElement; scrollTo: ReturnType<typeof vi.fn> } {
  const outer = document.createElement('div');
  if (inTable) outer.className = 'doc-table-frame';
  const viewport = document.createElement('div');
  viewport.setAttribute('data-radix-scroll-area-viewport', '');
  viewport.scrollLeft = 100;
  const td = document.createElement('td');
  const words = document.createElement('span');
  td.appendChild(words);
  viewport.appendChild(td);
  outer.appendChild(viewport);
  for (const side of ['left', 'right']) {
    const edge = document.createElement('span');
    edge.className = 'doc-table-overflow-edge';
    edge.dataset.overflowEdge = side;
    Object.defineProperty(edge, 'offsetWidth', { value: EDGE });
    outer.appendChild(edge);
  }
  document.body.appendChild(outer);
  viewport.getBoundingClientRect = () => ({ ...frame, top: 0, bottom: 10 }) as DOMRect;
  td.getBoundingClientRect = () => ({ ...cell, top: 0, bottom: 10 }) as DOMRect;
  words.getBoundingClientRect = () => ({ left: cell.left + 8, right: cell.left + 40, top: 0, bottom: 10 }) as DOMRect;
  const scrollTo = vi.fn();
  viewport.scrollTo = scrollTo as typeof viewport.scrollTo;
  return { words, scrollTo };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('bringing commented words in a wide table into view', () => {
  it('scrolls the table back until their cell clears the left edge', () => {
    const { words, scrollTo } = place({ left: 100, right: 500 }, { left: 40, right: 140 });

    revealInTable(words);

    expect(scrollTo).toHaveBeenCalledWith({ left: 100 - (100 + EDGE - 40), behavior: 'instant' });
  });

  it('scrolls the table on until their cell clears the right edge', () => {
    const { words, scrollTo } = place({ left: 100, right: 500 }, { left: 450, right: 560 });

    revealInTable(words);

    expect(scrollTo).toHaveBeenCalledWith({ left: 100 + (560 - (500 - EDGE)), behavior: 'instant' });
  });

  it('brings in the start of a cell wider than the table, clear of the left edge', () => {
    const { words, scrollTo } = place({ left: 100, right: 500 }, { left: 450, right: 1000 });

    revealInTable(words);

    expect(scrollTo).toHaveBeenCalledWith({ left: 100 + (450 - (100 + EDGE)), behavior: 'instant' });
  });

  it('leaves the table where it is when the cell is in view', () => {
    const { words, scrollTo } = place({ left: 100, right: 500 }, { left: 200, right: 300 });

    revealInTable(words);

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('leaves words outside a table alone', () => {
    const { words, scrollTo } = place({ left: 100, right: 500 }, { left: 40, right: 140 }, false);

    revealInTable(words);

    expect(scrollTo).not.toHaveBeenCalled();
  });
});
