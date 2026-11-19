// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';

import { visibleBlockIds } from '@web/spaces/document/block-scroll';

/**
 * Pin an element's on-screen box.
 * @param el - The element.
 * @param top - Its top.
 * @param bottom - Its bottom.
 */
function boxAt(el: Element, top: number, bottom: number): void {
  el.getBoundingClientRect = () => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });
}

/**
 * A body with one paragraph block per range.
 * @param ranges - Each block's line, top and bottom.
 * @returns The body element.
 */
function body(ranges: Array<[string, number, number]>): HTMLElement {
  const root = document.createElement('div');
  for (const [id, top, bottom] of ranges) {
    const outer = document.createElement('div');
    outer.className = 'bn-block-outer';
    outer.dataset.id = id;
    const content = document.createElement('div');
    content.className = 'bn-block-content';
    content.dataset.contentType = 'paragraph';
    const line = document.createElement('p');
    line.className = 'bn-inline-content';
    content.append(line);
    const block = document.createElement('div');
    block.className = 'bn-block';
    block.append(content);
    outer.append(block);
    root.append(outer);
    boxAt(line, top, bottom);
    boxAt(content, top, bottom);
  }
  document.body.append(root);
  return root;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('visibleBlockIds', () => {
  it('lists the blocks whose line is on screen', () => {
    const viewport = document.createElement('div');
    boxAt(viewport, 100, 300);
    const root = body([
      ['above', 0, 90],
      ['cut-top', 80, 120],
      ['inside', 150, 200],
      ['cut-bottom', 290, 320],
      ['below', 310, 400],
    ]);
    expect(visibleBlockIds(viewport, root)).toEqual(['cut-top', 'inside', 'cut-bottom']);
  });
});
