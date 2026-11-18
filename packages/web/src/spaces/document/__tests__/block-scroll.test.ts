// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';

import {
  LANDING,
  atEnd,
  blockLine,
  scrollTopForBlock,
  markAlignment,
  rebaseMark,
  stillAligned,
  topBlockId,
} from '@web/spaces/document/block-scroll';

/**
 * A fake document body laid out in content coordinates. jsdom has no layout,
 * so every rect is computed from the viewport's scrollTop and the positions
 * set here, which the tests move to stand in for the browser reflowing.
 */
interface Fake {
  viewport: HTMLElement;
  root: HTMLElement;
  /** Content-coordinate top and height of each block's own line, by id. */
  lines: Map<string, { top: number; height: number }>;
  /** Content-coordinate top and height of each block's outer box, by id. */
  outers: Map<string, { top: number; height: number }>;
  setScrollHeight: (value: number) => void;
}

const VIEWPORT_TOP = 100;
const CLIENT_HEIGHT = 500;

/**
 * Build a body. `spec` lists blocks in document order; `children` nests them
 * the way BlockNote does (a child's outer sits inside its parent's outer);
 * `frame` marks a layout block with no line of its own (a table, row or cell).
 * @param spec - The blocks.
 * @returns The fake.
 */
function build(spec: Array<{ id: string; top: number; height: number; children?: string[]; frame?: boolean }>): Fake {
  const viewport = document.createElement('div');
  const root = document.createElement('div');
  root.className = 'doc-body-editor';
  viewport.appendChild(root);
  document.body.appendChild(viewport);
  let scrollTop = 0;
  let scrollHeight = 5000;
  Object.defineProperty(viewport, 'scrollTop', {
    get: () => scrollTop,
    set: (v: number) => { scrollTop = Math.max(0, Math.min(scrollHeight - CLIENT_HEIGHT, Math.round(v))); },
    configurable: true,
  });
  Object.defineProperty(viewport, 'clientHeight', { get: () => CLIENT_HEIGHT, configurable: true });
  Object.defineProperty(viewport, 'scrollHeight', { get: () => scrollHeight, configurable: true });
  viewport.scrollTo = ((options: ScrollToOptions) => { viewport.scrollTop = options.top ?? scrollTop; }) as typeof viewport.scrollTo;
  viewport.getBoundingClientRect = (): DOMRect => ({ top: VIEWPORT_TOP, bottom: VIEWPORT_TOP + CLIENT_HEIGHT, left: 0, right: 800, width: 800, height: CLIENT_HEIGHT, x: 0, y: VIEWPORT_TOP, toJSON: () => ({}) });

  const lines = new Map<string, { top: number; height: number }>();
  const outers = new Map<string, { top: number; height: number }>();
  const outerEls = new Map<string, HTMLElement>();
  const rectAt = (box: { top: number; height: number }): DOMRect => {
    const top = VIEWPORT_TOP + box.top - scrollTop;
    return { top, bottom: top + box.height, left: 0, right: 800, width: 800, height: box.height, x: 0, y: top, toJSON: () => ({}) };
  };
  const parentOf = new Map<string, string>();
  for (const block of spec) for (const child of block.children ?? []) parentOf.set(child, block.id);
  for (const block of spec) {
    const outer = document.createElement('div');
    outer.className = 'bn-block-outer';
    outer.dataset.id = block.id;
    const inner = document.createElement('div');
    inner.className = 'bn-block';
    outer.appendChild(inner);
    outers.set(block.id, { top: block.top, height: block.height });
    outer.getBoundingClientRect = (): DOMRect => rectAt(outers.get(block.id)!);
    if (!block.frame) {
      const content = document.createElement('div');
      content.className = 'bn-block-content';
      inner.appendChild(content);
      lines.set(block.id, { top: block.top, height: Math.min(block.height, 24) });
      content.getBoundingClientRect = (): DOMRect => rectAt(lines.get(block.id)!);
    } else {
      const frame = document.createElement('table');
      inner.appendChild(frame);
    }
    outerEls.set(block.id, outer);
    const parent = parentOf.get(block.id);
    (parent ? outerEls.get(parent)!.querySelector(':scope > .bn-block')! : root).appendChild(outer);
  }
  return { viewport, root, lines, outers, setScrollHeight: (v) => { scrollHeight = v; viewport.scrollTop = scrollTop; } };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('blockLine', () => {
  it('finds a block own line and, for a frame block, nothing unless asked to fall back', () => {
    const fake = build([{ id: 'p', top: 0, height: 24 }, { id: 't', top: 24, height: 300, frame: true }]);
    expect(blockLine(fake.root, 'p', false)?.className).toBe('bn-block-content');
    expect(blockLine(fake.root, 't', false)).toBeNull();
    expect(blockLine(fake.root, 't', true)?.className).toBe('bn-block-outer');
    expect(blockLine(fake.root, 'missing', true)).toBeNull();
  });

  it('looks only inside the root it is given', () => {
    const fake = build([{ id: 'p', top: 0, height: 24 }]);
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    expect(blockLine(elsewhere, 'p', true)).toBeNull();
    expect(blockLine(fake.root, 'p', true)).not.toBeNull();
  });
});

describe('scrollTopForBlock and atEnd', () => {
  it('puts the block line LANDING below the viewport top, clamped to the scroll range', () => {
    const fake = build([{ id: 'a', top: 0, height: 24 }, { id: 'b', top: 1000, height: 24 }, { id: 'z', top: 4900, height: 24 }]);
    expect(LANDING).toBe(16);
    expect(scrollTopForBlock(fake.viewport, fake.root, 'b')).toBe(1000 - LANDING);
    expect(scrollTopForBlock(fake.viewport, fake.root, 'a')).toBe(0);
    expect(scrollTopForBlock(fake.viewport, fake.root, 'z')).toBe(5000 - CLIENT_HEIGHT);
    expect(scrollTopForBlock(fake.viewport, fake.root, 'missing')).toBeNull();
  });

  it('says whether a position is the end, give or take 2px', () => {
    const fake = build([{ id: 'a', top: 0, height: 24 }]);
    expect(atEnd(fake.viewport, 5000 - CLIENT_HEIGHT - 1)).toBe(true);
    expect(atEnd(fake.viewport, 5000 - CLIENT_HEIGHT - 3)).toBe(false);
  });
});

describe('topBlockId', () => {
  it('takes the first block whose own line ends below the viewport top', () => {
    const fake = build([{ id: 'a', top: 0, height: 24 }, { id: 'b', top: 400, height: 24 }, { id: 'c', top: 800, height: 24 }]);
    fake.viewport.scrollTop = 410;
    expect(topBlockId(fake.viewport, fake.root)).toBe('b');
    fake.viewport.scrollTop = 430;
    expect(topBlockId(fake.viewport, fake.root)).toBe('c');
  });

  it('takes the child, not the parent whose box holds it, inside a nested list', () => {
    const fake = build([
      { id: 'list', top: 0, height: 3000, children: ['c1', 'c2', 'c3'] },
      { id: 'c1', top: 24, height: 24 },
      { id: 'c2', top: 1500, height: 24 },
      { id: 'c3', top: 2500, height: 24 },
    ]);
    fake.viewport.scrollTop = 1400;
    expect(topBlockId(fake.viewport, fake.root)).toBe('c2');
  });

  it('skips table, row and cell blocks and takes the paragraph inside the cell', () => {
    const fake = build([
      { id: 'table', top: 0, height: 3000, frame: true, children: ['row'] },
      { id: 'row', top: 0, height: 3000, frame: true, children: ['cell'] },
      { id: 'cell', top: 0, height: 3000, frame: true, children: ['para1', 'para2'] },
      { id: 'para1', top: 10, height: 24 },
      { id: 'para2', top: 2000, height: 24 },
    ]);
    fake.viewport.scrollTop = 1900;
    expect(topBlockId(fake.viewport, fake.root)).toBe('para2');
  });

  it('returns null for an empty body', () => {
    const fake = build([]);
    expect(topBlockId(fake.viewport, fake.root)).toBeNull();
  });
});

describe('stillAligned', () => {
  /**
   * Align to a block the way the receiver does and return the mark.
   * @param fake - The body.
   * @param id - The block.
   * @returns The mark.
   */
  function align(fake: Fake, id: string): ReturnType<typeof markAlignment> {
    const target = scrollTopForBlock(fake.viewport, fake.root, id)!;
    fake.viewport.scrollTo({ top: target, behavior: 'auto' });
    return markAlignment(fake.viewport, fake.root, id);
  }

  it('holds right after the follow own alignment, also on a fractional landing', () => {
    const fake = build([{ id: 'a', top: 0, height: 24 }, { id: 'b', top: 1000.4, height: 24 }]);
    const mark = align(fake, 'b');
    expect(mark.target).toBe(fake.viewport.scrollTop);
    expect(stillAligned(fake.viewport, fake.root, mark)).toBe(true);
  });

  it('breaks when the user scrolls a pixel or more', () => {
    const fake = build([{ id: 'a', top: 0, height: 24 }, { id: 'b', top: 1000, height: 24 }]);
    const mark = align(fake, 'b');
    fake.viewport.scrollTop = fake.viewport.scrollTop + 40;
    expect(stillAligned(fake.viewport, fake.root, mark)).toBe(false);
  });

  it('holds when content above grows and scroll anchoring moves scrollTop by the same amount', () => {
    const fake = build([{ id: 'a', top: 0, height: 24 }, { id: 'b', top: 1000, height: 24 }]);
    const mark = align(fake, 'b');
    fake.lines.set('b', { top: 1060, height: 24 });
    fake.viewport.scrollTop = fake.viewport.scrollTop + 60;
    expect(stillAligned(fake.viewport, fake.root, mark)).toBe(true);
  });

  it('holds when the body gets shorter and the browser clamps scrollTop at the end', () => {
    const fake = build([{ id: 'a', top: 0, height: 24 }, { id: 'z', top: 4900, height: 24 }]);
    const mark = align(fake, 'z');
    fake.setScrollHeight(4800);
    expect(stillAligned(fake.viewport, fake.root, mark)).toBe(true);
  });

  it('holds when a clamp and then an anchoring adjustment follow each other, once rebased', () => {
    const fake = build([{ id: 'a', top: 0, height: 24 }, { id: 'z', top: 4900, height: 24 }]);
    let mark = align(fake, 'z');
    fake.setScrollHeight(4800);
    expect(stillAligned(fake.viewport, fake.root, mark)).toBe(true);
    mark = rebaseMark(fake.viewport, fake.root, mark);
    fake.lines.set('z', { top: 4950, height: 24 });
    fake.setScrollHeight(4850);
    fake.viewport.scrollTop = fake.viewport.scrollTop + 50;
    expect(stillAligned(fake.viewport, fake.root, mark)).toBe(true);
  });

  it('holds when an anchoring adjustment and then a clamp follow each other, once rebased', () => {
    const fake = build([{ id: 'a', top: 0, height: 24 }, { id: 'z', top: 4900, height: 24 }]);
    let mark = align(fake, 'z');
    fake.lines.set('z', { top: 4950, height: 24 });
    fake.setScrollHeight(5050);
    fake.viewport.scrollTop = fake.viewport.scrollTop + 50;
    expect(stillAligned(fake.viewport, fake.root, mark)).toBe(true);
    mark = rebaseMark(fake.viewport, fake.root, mark);
    fake.setScrollHeight(4700);
    expect(stillAligned(fake.viewport, fake.root, mark)).toBe(true);
  });

  it('keeps the old offset when rebasing after the block has gone', () => {
    const fake = build([{ id: 'a', top: 0, height: 24 }, { id: 'b', top: 1000, height: 24 }]);
    const mark = align(fake, 'b');
    fake.root.querySelector('[data-id="b"]')!.remove();
    const rebased = rebaseMark(fake.viewport, fake.root, mark);
    expect(rebased.offset).toBe(mark.offset);
    expect(rebased.target).toBe(fake.viewport.scrollTop);
  });
});
