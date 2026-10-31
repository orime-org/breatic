// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A pulled selection keeps, after the release, exactly the blocks it showed
 * selected a moment before (inner#1350 A8, design §6 "A8 matrix").
 *
 * The documents follow the edge takeover's split (`bodyEdgeNeedsTakeover`):
 * paragraphs at both ends; a divider, an image, a video, an audio, an empty
 * line and a table each first and each last; and a nested child last. Every
 * body holds every block type. From seven starting points the pointer is
 * pulled to the middle, the right blank and the handle spot of each block,
 * and to the table's row line, a cell, its top and left padding and its row
 * handle spot, above the first block and below the last; what is drawn
 * selected is read just before the release and again after it.
 *
 * Only the editable body: a selection pulled across a read-only body is out
 * of scope (design §2).
 *
 * Wants dev and the ingest Worker running:
 *   pnpm --filter @breatic/web test:smoke:all document-select-kept
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, type Page } from 'playwright/test';

import { openFreshDocument, test } from '../helpers/bubble-bar';
import { wavBytes } from '../helpers/media-bytes';
import { DOCUMENT_EDITOR as EDITOR } from '../helpers/space';

/** Tall enough that the whole body stands in the window, unscrolled. */
const TALL = { width: 1440, height: 2600 };

/** How long a media block may take to come back from storage. */
const UPLOAD_TIMEOUT = 90_000;

const TABLE = '<table><tbody><tr><td>c11</td><td>c12</td></tr><tr><td>c21</td><td>c22</td></tr></tbody></table>';

/** Every block type, around three marker lines the media replace. */
const BODY = [
  '<p>alpha words here</p>',
  '<h2>Heading two</h2>',
  '<p>above the table</p>',
  TABLE,
  '<p>below the table</p>',
  '<hr>',
  '<p>a quoted line</p>',
  '<ul><li>a bullet item</li></ul>',
  '<ol><li>a numbered item</li></ol>',
  '<ul><li><input type="checkbox">a todo item</li></ul>',
  '<pre><code>let code = 1</code></pre>',
  '<p>MEDIA-image</p>',
  '<p>MEDIA-video</p>',
  '<p>MEDIA-audio</p>',
  '<p>omega words here</p>',
].join('');

/** A block the body can start or end with. */
type Edge = 'divider' | 'image' | 'video' | 'audio' | 'empty' | 'table';

/** One reading of what the body draws as selected. */
interface Shot {
  /** The editor's selection, for the report. */
  pm: string;
  /** Each block drawn selected, with how, in body order. */
  shown: string[];
}

/** A point in the window. */
interface Point {
  x: number;
  y: number;
}

/**
 * Pastes HTML at the caret.
 * @param p - The page.
 * @param html - The HTML.
 */
async function pasteHtml(p: Page, html: string): Promise<void> {
  await p.locator(EDITOR).evaluate((element, markup) => {
    const transfer = new DataTransfer();
    transfer.setData('text/html', markup);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, html);
}

/**
 * Pastes a file at the caret.
 * @param p - The page.
 * @param kind - Which medium.
 */
async function pasteMedium(p: Page, kind: 'image' | 'video' | 'audio'): Promise<void> {
  const file =
    kind === 'video'
      ? { name: 'a8.mp4', type: 'video/mp4', base64: readFileSync(resolve(__dirname, '../fixtures/media-history.mp4')).toString('base64') }
      : kind === 'audio'
        ? { name: 'a8.wav', type: 'audio/wav', base64: wavBytes().toString('base64') }
        : null;
  const before = await p.locator(`${EDITOR} [data-content-type="${kind}"]`).count();
  await p.locator(EDITOR).evaluate(async (element, given) => {
    const transfer = new DataTransfer();
    if (given === null) {
      const canvas = document.createElement('canvas');
      canvas.width = 600;
      canvas.height = 300;
      canvas.getContext('2d')!.fillRect(0, 0, 600, 300);
      const blob = await new Promise<Blob>((done) => canvas.toBlob((b) => done(b!), 'image/png'));
      transfer.items.add(new File([blob], 'a8.png', { type: 'image/png' }));
    } else {
      const raw = Uint8Array.from(atob(given.base64), (c) => c.charCodeAt(0));
      transfer.items.add(new File([raw], given.name, { type: given.type }));
    }
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, file);
  await expect(p.locator(`${EDITOR} [data-content-type="${kind}"] [data-media-frame]`)).toHaveCount(before + 1, {
    timeout: UPLOAD_TIMEOUT,
  });
}

/** The tiptap editor the body element carries, as far as these cases use it. */
interface BodyEditor {
  state: {
    doc: {
      descendants: (f: (node: PmNode, pos: number) => boolean | void) => void;
      content: { size: number };
    };
    tr: {
      delete: (from: number, to: number) => unknown;
      setNodeAttribute: (pos: number, name: string, value: unknown) => unknown;
    };
  };
  view: { dispatch: (tr: unknown) => void };
  chain: () => {
    focus: () => ReturnType<BodyEditor['chain']>;
    setTextSelection: (range: number | { from: number; to: number }) => ReturnType<BodyEditor['chain']>;
    deleteSelection: () => ReturnType<BodyEditor['chain']>;
    run: () => boolean;
  };
}

/** A document node, as far as these cases read it. */
interface PmNode {
  isText: boolean;
  text?: string;
  nodeSize: number;
  childCount: number;
  firstChild: PmNode | null;
  type: { name: string };
  content: { size: number };
}

/**
 * Deletes the text of a marker line, leaving the caret on the emptied line.
 * @param p - The page.
 * @param text - The line's text.
 */
async function emptyLine(p: Page, text: string): Promise<void> {
  await p.locator(EDITOR).evaluate((element, marker) => {
    const editor = (element as unknown as { editor: BodyEditor }).editor;
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (at < 0 && node.isText && node.text === marker) at = pos;
      return at < 0;
    });
    if (at < 0) throw new Error(`no line "${marker}"`);
    editor.chain().focus().setTextSelection({ from: at, to: at + marker.length }).deleteSelection().run();
  }, text);
}

/**
 * Deletes every empty line that has no children, last first.
 * @param p - The page.
 */
async function dropEmptyLines(p: Page): Promise<void> {
  await p.locator(EDITOR).evaluate((element) => {
    const editor = (element as unknown as { editor: BodyEditor }).editor;
    const empty: Array<{ from: number; to: number }> = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'blockContainer') return true;
      const content = node.firstChild;
      if (node.childCount === 1 && content?.type.name === 'paragraph' && content.content.size === 0) {
        empty.push({ from: pos, to: pos + node.nodeSize });
      }
      return true;
    });
    for (const range of empty.reverse()) {
      editor.view.dispatch(editor.state.tr.delete(range.from, range.to));
    }
  });
}

/**
 * Builds a body with every block type and, when given, an edge block first or last.
 * @param p - The page.
 * @param edge - The edge block and its end, `plain` for none, or `nested` for a child line last.
 */
async function build(p: Page, edge: { kind: Edge; where: 'first' | 'last' } | 'plain' | 'nested'): Promise<void> {
  const first = typeof edge === 'object' && edge.where === 'first' ? edge.kind : null;
  const last = typeof edge === 'object' && edge.where === 'last' ? edge.kind : null;
  const lead = first === 'divider' ? '<hr>' : first === 'table' ? TABLE : first === null ? '' : `<p>EDGE-${first}</p>`;
  const tail = last === 'divider' ? '<hr>' : last === 'table' ? TABLE : last === null ? '' : `<p>EDGE-${last}</p>`;
  await pasteHtml(p, `${lead}${BODY}${tail}`);
  await expect(p.locator(`${EDITOR} .bn-inline-content`).filter({ hasText: /^omega words here$/ })).toHaveCount(1);
  for (const marker of ['MEDIA-image', 'MEDIA-video', 'MEDIA-audio', `EDGE-${first}`, `EDGE-${last}`]) {
    const kind = marker.split('-')[1];
    if (kind !== 'image' && kind !== 'video' && kind !== 'audio') continue;
    await emptyLine(p, marker);
    await pasteMedium(p, kind);
  }
  // A medium pasted on an emptied line lands after it, and pasting into an
  // empty body leaves its first line behind; at the ends that empty line,
  // not the block meant to be there, would be the edge.
  await dropEmptyLines(p);
  await p.locator(EDITOR).evaluate((element) => {
    const editor = (element as unknown as { editor: BodyEditor }).editor;
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (at < 0 && node.type.name === 'paragraph' && node.firstChild?.text === 'a quoted line') at = pos;
      return at < 0;
    });
    editor.view.dispatch(editor.state.tr.setNodeAttribute(at, 'quoted', true));
  });
  if (first === 'empty' || last === 'empty') await emptyLine(p, 'EDGE-empty');
  if (edge === 'nested') {
    await p.locator(EDITOR).evaluate((element) => {
      const editor = (element as unknown as { editor: BodyEditor }).editor;
      editor.chain().focus().setTextSelection(editor.state.doc.content.size - 3).run();
    });
    await p.keyboard.press('Enter');
    await p.keyboard.type('a nested child line');
    await p.keyboard.press('Tab');
  }
  await p.waitForTimeout(300);
}

/** The documents of the matrix. */
const DOCUMENTS: Array<{ name: string; edge: Parameters<typeof build>[1] }> = [
  { name: 'paragraphs at both ends', edge: 'plain' },
  ...(['divider', 'image', 'video', 'audio', 'empty', 'table'] as const).flatMap((kind) =>
    (['first', 'last'] as const).map((where) => ({ name: `${kind} ${where}`, edge: { kind, where } })),
  ),
  { name: 'a nested child last', edge: 'nested' },
];

/**
 * What the body draws as selected: per block, the classes that paint it, its
 * selected cells, and how many characters of its text are painted — by the
 * page selection while the body shows the native one, or by the band of a
 * selection the body draws itself.
 * @param p - The page.
 * @returns The reading.
 */
async function shot(p: Page): Promise<Shot> {
  return p.evaluate((selector) => {
    const body = document.querySelector(selector) as HTMLElement & {
      editor: { state: { selection: { constructor: { name: string }; from: number; to: number } } };
    };
    const selection = body.editor.state.selection;
    const native =
      body.hasAttribute('data-body-holds') &&
      !body.hasAttribute('data-selection-drawn') &&
      !body.classList.contains('ProseMirror-hideselection');
    const dom = window.getSelection();
    const range = native && dom !== null && dom.rangeCount > 0 && !dom.isCollapsed ? dom.getRangeAt(0) : null;
    const shown = [...body.querySelectorAll<HTMLElement>('.bn-block-outer')].flatMap((outer, index) => {
      const own = outer.querySelector<HTMLElement>(':scope > .bn-block > .bn-block-content');
      if (own === null) return [];
      const type = own.getAttribute('data-content-type') ?? '?';
      const marks: string[] = [];
      if (own.matches('.doc-in-selection, .doc-media-in-selection, .doc-empty-line-in-selection') ||
        own.querySelector('.doc-in-selection, .doc-media-in-selection, .doc-empty-line-in-selection') !== null) {
        marks.push('paint');
      }
      const cells = [...own.querySelectorAll('td, th')]
        .map((cell, at) => (cell.classList.contains('selectedCell') || cell.classList.contains('doc-table-in-selection') ? at : -1))
        .filter((at) => at >= 0);
      if (cells.length > 0) marks.push(`cells${cells.join('.')}`);
      if (range !== null) {
        const walker = document.createTreeWalker(own, NodeFilter.SHOW_TEXT);
        let chars = 0;
        for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
          const text = n.textContent ?? '';
          if (text.trim() === '' || n.parentElement?.closest('style, [contenteditable="false"]') || !range.intersectsNode(n)) continue;
          // Text the page selection covers but whose `::selection` paints no
          // colour is not drawn as selected: what the body draws itself there
          // (a whole table's cells) is read from its own marks.
          const paint = getComputedStyle(n.parentElement!, '::selection').backgroundColor;
          if (paint === 'transparent' || paint === 'rgba(0, 0, 0, 0)') continue;
          const from = n === range.startContainer ? range.startOffset : 0;
          const to = n === range.endContainer ? range.endOffset : text.length;
          chars += Math.max(0, to - from);
        }
        if (chars > 0) marks.push(`text${chars}`);
      }
      // A selection the body draws itself paints its text with this band.
      const band = [...own.querySelectorAll('[data-show-selection]')]
        .filter((el) => el.closest('.bn-block-content') === own)
        .reduce((sum, el) => sum + (el.textContent ?? '').length, 0);
      if (band > 0) marks.push(`text${band}`);
      return marks.length > 0 ? [`${index}:${type}[${marks.join('+')}]`] : [];
    });
    return { pm: `${selection.constructor.name} ${selection.from}-${selection.to}`, shown };
  }, EDITOR);
}

/**
 * The points the pointer is pressed at and released at, read off the laid-out body.
 * @param p - The page.
 * @returns Seven starts and every end.
 */
async function points(p: Page): Promise<{ starts: Record<string, Point>; ends: Record<string, Point> }> {
  return p.evaluate((selector) => {
    const body = document.querySelector(selector) as HTMLElement;
    const column = body.getBoundingClientRect();
    const blocks = [...body.querySelectorAll<HTMLElement>('.bn-block-outer')]
      .map((outer) => outer.querySelector<HTMLElement>(':scope > .bn-block > .bn-block-content'))
      .filter((el): el is HTMLElement => el !== null);
    /** Where a line's text is drawn. */
    const textBox = (text: string): DOMRect => {
      const line = [...body.querySelectorAll<HTMLElement>('.bn-inline-content, td p')].find((el) => el.textContent === text);
      if (line === undefined) throw new Error(`no line "${text}"`);
      const range = document.createRange();
      range.selectNodeContents(line);
      return range.getBoundingClientRect();
    };
    /** A rect's middle. */
    const middle = (r: DOMRect): { x: number; y: number } => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    const quote = textBox('a quoted line');
    const bullet = textBox('a bullet item');
    const firstBlock = blocks[0]!.getBoundingClientRect();
    const lastBlock = blocks[blocks.length - 1]!.getBoundingClientRect();
    const starts = {
      'text above the table': middle(textBox('above the table')),
      'left blank': { x: column.left - 60, y: middle(quote).y },
      'right blank': { x: column.right + 60, y: middle(quote).y },
      'line end': { x: bullet.right + 6, y: middle(bullet).y },
      'text below the table': middle(textBox('below the table')),
      'in a cell': middle(textBox('c12')),
      'document end': { x: column.left + 60, y: lastBlock.bottom + 20 },
    };
    const ends: Record<string, { x: number; y: number }> = {};
    blocks.forEach((block, index) => {
      const r = block.getBoundingClientRect();
      const type = block.getAttribute('data-content-type');
      const inline = block.querySelector<HTMLElement>(':scope > .bn-inline-content');
      let mid = middle(r);
      if (inline !== null && (inline.textContent ?? '') !== '') {
        const range = document.createRange();
        range.selectNodeContents(inline);
        mid = middle(range.getBoundingClientRect());
      }
      ends[`${index} ${type} middle`] = mid;
      ends[`${index} ${type} right blank`] = { x: column.right + 40, y: mid.y };
      ends[`${index} ${type} handle spot`] = { x: column.left - 24, y: mid.y };
    });
    const table = body.querySelector('table')!.getBoundingClientRect();
    const firstRow = body.querySelector('table tr')!.getBoundingClientRect();
    ends['table row line'] = { x: middle(textBox('c11')).x, y: firstRow.bottom };
    ends['table cell'] = middle(textBox('c22'));
    ends['table top padding'] = { x: table.left + 20, y: table.top - 4 };
    ends['table left padding'] = { x: table.left - 3, y: middle(firstRow).y };
    ends['table row handle spot'] = { x: table.left - 16, y: middle(firstRow).y };
    ends['above the first block'] = { x: column.left + 60, y: firstBlock.top - 8 };
    ends['below the last block'] = { x: column.left + 60, y: lastBlock.bottom + 30 };
    return { starts, ends };
  }, EDITOR);
}

/**
 * Puts a caret on the last line holding text, so a press never lands inside
 * a selection the previous pull left, which would start a drag instead.
 * @param p - The page.
 */
async function collapse(p: Page): Promise<void> {
  await p.locator(EDITOR).evaluate((element) => {
    const editor = (element as unknown as { editor: BodyEditor }).editor;
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'omega words here') at = pos;
      return true;
    });
    editor.chain().focus().setTextSelection(at).run();
  });
}

/**
 * Lets two frames pass, so decorations and attributes follow the last event.
 * @param p - The page.
 */
async function frames(p: Page): Promise<void> {
  await p.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

/**
 * Pulls a selection from one point to another and reads it before and after the release.
 * @param p - The page.
 * @param from - The press.
 * @param to - The release.
 * @returns Both readings.
 */
async function pull(p: Page, from: Point, to: Point): Promise<{ before: Shot; after: Shot }> {
  await collapse(p);
  await p.mouse.move(from.x, from.y);
  await p.mouse.down();
  await p.mouse.move(to.x, to.y, { steps: 8 });
  await frames(p);
  const before = await shot(p);
  await p.mouse.up();
  await frames(p);
  await p.waitForTimeout(80);
  return { before, after: await shot(p) };
}

for (const doc of DOCUMENTS) {
  test(`a pull keeps what it showed: ${doc.name} @needs-ingest @needs-storage`, async ({ page }) => {
    test.setTimeout(1_800_000);
    await page.setViewportSize(TALL);
    await openFreshDocument(page);
    await build(page, doc.edge);
    const { starts, ends } = await points(page);
    const differ: string[] = [];
    let pulls = 0;
    let drawn = 0;
    for (const [startName, start] of Object.entries(starts)) {
      for (const [endName, end] of Object.entries(ends)) {
        const { before, after } = await pull(page, start, end);
        pulls += 1;
        if (before.shown.length > 0) drawn += 1;
        if (JSON.stringify(before.shown) !== JSON.stringify(after.shown)) {
          differ.push(
            `${startName} -> ${endName} | before ${before.shown.join(' ')} (${before.pm}) | after ${after.shown.join(' ')} (${after.pm})`,
          );
        }
      }
    }
    test.info().annotations.push({ type: 'pulls', description: String(pulls) });
    expect(differ, `${differ.length} of ${pulls} pulls differ`).toEqual([]);
    // The reading sees what a pull draws: most pulls draw something.
    expect(drawn).toBeGreaterThan(pulls * 0.8);
  });
}

test('a pull that scrolled the body a screen keeps what it showed @needs-ingest @needs-storage', async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFreshDocument(page);
  await build(page, 'plain');
  await pasteHtml(page, Array.from({ length: 60 }, (_, i) => `<p>filler line ${i + 1}</p>`).join(''));
  const scroller = page.locator('[data-testid="document-space"] .doc-body-scroller [data-radix-scroll-area-viewport]').first();
  const view = (await scroller.boundingBox())!;
  const readings: Array<{ before: Shot; after: Shot; scrolled: number }> = [];
  for (const way of ['down', 'up'] as const) {
    await scroller.evaluate((el, top) => {
      el.scrollTop = top;
    }, way === 'down' ? 0 : 100_000);
    await frames(page);
    await collapse(page);
    if (way === 'up') {
      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await frames(page);
    }
    const from = way === 'down' ? { x: view.x + view.width / 2, y: view.y + 120 } : { x: view.x + view.width / 2, y: view.y + view.height - 120 };
    const edge = way === 'down' ? view.y + view.height - 2 : view.y + 2;
    const top = await scroller.evaluate((el) => el.scrollTop);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x, edge, { steps: 8 });
    for (let t = 0; t < 40 && Math.abs((await scroller.evaluate((el) => el.scrollTop)) - top) < view.height; t += 1) {
      await page.mouse.move(from.x + (t % 2), edge, { steps: 1 });
      await page.waitForTimeout(100);
    }
    const scrolled = Math.abs((await scroller.evaluate((el) => el.scrollTop)) - top);
    // Back inside the body, where nothing scrolls it, and still: the reading
    // before the release is then the last thing drawn before it.
    await page.mouse.move(from.x, way === 'down' ? edge - 80 : edge + 80, { steps: 2 });
    let settled = await scroller.evaluate((el) => el.scrollTop);
    for (;;) {
      await page.waitForTimeout(150);
      const now = await scroller.evaluate((el) => el.scrollTop);
      if (now === settled) break;
      settled = now;
    }
    await frames(page);
    const before = await shot(page);
    await page.mouse.up();
    await frames(page);
    await page.waitForTimeout(80);
    readings.push({ before, after: await shot(page), scrolled });
  }
  for (const { before, after, scrolled } of readings) {
    expect(scrolled).toBeGreaterThanOrEqual(view.height);
    expect(before.shown.length).toBeGreaterThan(0);
    expect(after.shown).toEqual(before.shown);
  }
});
