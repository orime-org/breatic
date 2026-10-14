// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, afterEach } from 'vitest';

import { revealInTable } from '@web/spaces/document/document-table-reveal';

/**
 * A table's horizontal frame holding one run of words, with the frame and the
 * words placed where the case says.
 * @param frame - The frame's left and right edges on screen.
 * @param words - The words' left and right edges on screen.
 * @param inTable - Whether the words sit inside a table's frame.
 * @returns The words and the frame's scroll spy.
 */
function place(
  frame: { left: number; right: number },
  words: { left: number; right: number },
  inTable = true,
): { target: HTMLElement; scrollTo: ReturnType<typeof vi.fn>; viewport: HTMLElement } {
  const scroller = document.createElement('div');
  if (inTable) scroller.className = 'doc-table-scroller';
  const viewport = document.createElement('div');
  viewport.setAttribute('data-radix-scroll-area-viewport', '');
  viewport.scrollLeft = 100;
  const target = document.createElement('span');
  viewport.appendChild(target);
  scroller.appendChild(viewport);
  document.body.appendChild(scroller);
  viewport.getBoundingClientRect = () => ({ ...frame, top: 0, bottom: 10 }) as DOMRect;
  target.getBoundingClientRect = () => ({ ...words, top: 0, bottom: 10 }) as DOMRect;
  const scrollTo = vi.fn();
  viewport.scrollTo = scrollTo as typeof viewport.scrollTo;
  return { target, scrollTo, viewport };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('bringing commented words in a wide table into view', () => {
  it('scrolls the table back to words cut off on its left', () => {
    const { target, scrollTo } = place({ left: 100, right: 500 }, { left: 40, right: 140 });

    revealInTable(target);

    expect(scrollTo).toHaveBeenCalledWith({ left: 40, behavior: 'instant' });
  });

  it('scrolls the table on to words cut off on its right', () => {
    const { target, scrollTo } = place({ left: 100, right: 500 }, { left: 450, right: 560 });

    revealInTable(target);

    expect(scrollTo).toHaveBeenCalledWith({ left: 160, behavior: 'instant' });
  });

  it('brings in the start of words wider than the table', () => {
    const { target, scrollTo } = place({ left: 100, right: 500 }, { left: 450, right: 1000 });

    revealInTable(target);

    expect(scrollTo).toHaveBeenCalledWith({ left: 450, behavior: 'instant' });
  });

  it('leaves the table where it is when the words are in view', () => {
    const { target, scrollTo } = place({ left: 100, right: 500 }, { left: 200, right: 300 });

    revealInTable(target);

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('leaves words outside a table alone', () => {
    const { target, scrollTo } = place({ left: 100, right: 500 }, { left: 40, right: 140 }, false);

    revealInTable(target);

    expect(scrollTo).not.toHaveBeenCalled();
  });
});
