// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A drag preview draws the dragged content the way the body draws it
 * (inner#1350 A1): every element of the preview, and its `::before` and
 * `::after`, takes the computed style its original takes in the body.
 *
 * The preview is a copy of the body's blocks taken out of the editor, so how it
 * looks rests on what the body gives a block through where it sits: the editor
 * element's classes, the groups around it, its neighbours, the box its width
 * was measured in. jsdom computes no cascade and lays nothing out, so this is
 * checked here, over every block type and every kind of drag.
 *
 * The comparison runs once the drag is over, against the body at rest (no
 * selection, no hover), since a preview draws the content and none of what the
 * body shows for the moment. What a preview changes on purpose is left out of
 * it, each by name below.
 *
 * Wants dev running:
 *   pnpm --filter @breatic/web test:smoke
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { test, expect, type Page } from 'playwright/test';

import { wavBytes } from '../helpers/media-bytes';
import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, DOCUMENT_EDITOR as EDITOR } from '../helpers/space';

/** A long run with no space in it, for wrapping and breaking. */
const UNBROKEN = 'x'.repeat(240);
const URL_TEXT = `https://example.com/${'segment/'.repeat(30)}end`;

let page: Page;
let errors: string[];
const createdSpaceIds: string[] = [];

/**
 * What a preview's copy is compared by, installed in the page: every element
 * the body draws is paired with its copy in document order, an element the
 * preview leaves out (a widget, the table's scroll frame, the rows a line
 * preview drops) being skipped, and every computed property of each pair, its
 * two pseudo-elements included, is compared.
 *
 * Changed on purpose, and so not reported:
 * - the top of the copy's width, height and box sizing: it is set to the
 *   width the content is drawn at;
 * - the first block's space above it and the last's below it, the quote rule
 *   reaching over them, and the heights of what holds those blocks by that
 *   much: the preview's ends are the content's (design §4);
 * - the size of an element some of whose children the preview leaves out, and
 *   the height of a cell whose row lost its other cells (a column drag);
 * - `transform-origin` and `perspective-origin`, which are a box's size again;
 * - whether an element is editable (`-webkit-user-modify`): the copy is not.
 */
function installComparer(): void {
  type Diff = { where: string; prop: string; body: string; preview: string };
  const SIZE = new Set(['width', 'height', 'inline-size', 'block-size']);
  const DERIVED = new Set(['transform-origin', 'perspective-origin', '-webkit-user-modify']);

  const label = (el: Element): string =>
    `${el.tagName.toLowerCase()}${el.getAttribute('data-content-type') ? `[${el.getAttribute('data-content-type')}]` : ''}` +
    `${el.getAttribute('data-id') ? `#${el.getAttribute('data-id')}` : ''}.${[...el.classList].join('.')} "${(el.textContent ?? '').trim().slice(0, 24)}"`;

  const same = (p: Element, b: Element): boolean => {
    if (p.tagName !== b.tagName) return false;
    if (p.getAttribute('data-content-type') !== b.getAttribute('data-content-type')) return false;
    if (p.getAttribute('data-id') !== b.getAttribute('data-id')) return false;
    if (p.tagName === 'TD' || p.tagName === 'TH' || p.tagName === 'TR') return p.textContent === b.textContent;
    return true;
  };

  const align = (p: Element, b: Element): { pairs: Array<[Element, Element]>; skipped: Set<Element>; unmatched: Element[] } => {
    const ps = [p, ...p.querySelectorAll('*')];
    const bs = [b, ...b.querySelectorAll('*')];
    const pairs: Array<[Element, Element]> = [];
    const skipped = new Set<Element>();
    let at = 0;
    bs.forEach((el) => {
      if (at < ps.length && same(ps[at]!, el)) {
        pairs.push([ps[at]!, el]);
        at += 1;
      } else {
        skipped.add(el);
      }
    });
    return { pairs, skipped, unmatched: ps.slice(at) };
  };

  const props = (style: CSSStyleDeclaration): string[] => [...Array.from({ length: style.length }, (_, i) => style[i]!)];

  const compareStyles = (p: Element, b: Element, pseudo: string | null, out: Diff[], skip: (prop: string) => boolean): void => {
    const a = getComputedStyle(p, pseudo);
    const z = getComputedStyle(b, pseudo);
    if (pseudo !== null && a.content === 'none' && z.content === 'none') return;
    props(z).forEach((prop) => {
      if (DERIVED.has(prop) || skip(prop)) return;
      const bv = z.getPropertyValue(prop);
      const pv = a.getPropertyValue(prop);
      if (bv === pv) return;
      if (SIZE.has(prop) && Math.abs(parseFloat(bv) - parseFloat(pv)) < 0.5) return;
      out.push({ where: `${label(b)}${pseudo ?? ''}`, prop, body: bv, preview: pv });
    });
  };

  const originalsOf = (content: Element, editor: Element): Array<[Element, Element]> => {
    const rows = [...content.querySelectorAll('.bn-block-outer[data-id]')];
    const tops = [content.matches('.bn-block-outer[data-id]') ? content : null, ...rows]
      .filter((row): row is Element => row !== null)
      .filter((row) => row === content || !row.parentElement!.closest('.bn-block-outer[data-id]') || !content.contains(row.parentElement!.closest('.bn-block-outer[data-id]')));
    if (tops.length > 0) {
      return tops.map((row) => [row, editor.querySelector(`.bn-block-outer[data-id="${row.getAttribute('data-id')}"]`)!]);
    }
    if (content.matches('[data-content-type="table"]')) {
      const text = content.querySelector('td, th')?.textContent ?? '';
      const cell = [...editor.querySelectorAll('td, th')].find((c) => c.textContent === text)!;
      return [[content, cell.closest('[data-content-type="table"]')!]];
    }
    const media = content.querySelector('img, audio, video, canvas')?.tagName.toLowerCase();
    const box = [...editor.querySelectorAll('[data-media-box]')].find((b) => b.querySelector(media === 'canvas' ? 'video' : media ?? '*') !== null)!;
    return [[content, box]];
  };

  (window as unknown as { __comparePreview: (root: Element) => { diffs: Diff[]; unmatched: string[] } }).__comparePreview = (root) => {
    const editor = document.querySelector('[data-space-outlet]:not([style*="display: none"]) [data-testid="document-space"] .ProseMirror')!;
    const content = root.firstElementChild!.firstElementChild!;
    const diffs: Diff[] = [];
    const unmatched: string[] = [];
    const blocks = [...root.querySelectorAll('.bn-block-content')];
    const first = blocks[0];
    const last = blocks.at(-1);
    originalsOf(content, editor).forEach(([copy, original]) => {
      const aligned = align(copy, original);
      aligned.unmatched.forEach((el) => unmatched.push(label(el)));
      const byCopy = new Map(aligned.pairs);
      const lift = first === undefined || !byCopy.has(first) ? 0 : parseFloat(getComputedStyle(byCopy.get(first)!).marginTop);
      const drop = last === undefined || !byCopy.has(last) ? 0 : parseFloat(getComputedStyle(byCopy.get(last)!).marginBottom);
      aligned.pairs.forEach(([p, b]) => {
        const lostChildren = [...b.querySelectorAll('*')].some((el) => aligned.skipped.has(el));
        const rowLostCells = (p.tagName === 'TD' || p.tagName === 'TH') && p.parentElement!.children.length < b.parentElement!.children.length;
        const holdsEnd = (first !== undefined && p.contains(first) ? lift : 0) + (last !== undefined && p.contains(last) ? drop : 0);
        const skip = (prop: string): boolean => {
          if (p === content && (SIZE.has(prop) || prop === 'box-sizing')) return true;
          if ((lostChildren || rowLostCells) && SIZE.has(prop)) return true;
          if (p === first && prop === 'margin-top') return true;
          if (p === last && prop === 'margin-bottom') return true;
          if (holdsEnd > 0 && (prop === 'height' || prop === 'block-size')) {
            const gap = parseFloat(getComputedStyle(b).getPropertyValue(prop)) - parseFloat(getComputedStyle(p).getPropertyValue(prop));
            return Math.abs(gap - holdsEnd) < 0.5;
          }
          return false;
        };
        compareStyles(p, b, null, diffs, skip);
        compareStyles(p, b, '::before', diffs, () => false);
        compareStyles(p, b, '::after', diffs, (prop) => (p === first || p === last) && (prop === 'top' || prop === 'height' || prop === 'block-size'));
      });
    });
    return { diffs, unmatched };
  };
}

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(installComparer);
  // Every preview handed to the browser is kept, a copy of it on the page, to
  // be compared once the drag is over.
  await page.addInitScript(() => {
    const kept: Element[] = [];
    (window as unknown as { __previews: Element[] }).__previews = kept;
    const original = DataTransfer.prototype.setDragImage;
    DataTransfer.prototype.setDragImage = function (el: Element, x: number, y: number) {
      const copy = el.cloneNode(true) as Element;
      document.body.append(copy);
      kept.push(copy);
      original.call(this, el, x, y);
    };
  });
});

test.afterEach(async () => {
  await page.mouse.up();
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
  await page?.close();
  expect(errors).toEqual([]);
});

/**
 * The document every case drags from: every block type, quoted runs that
 * open and close on a heading, nesting, two tables, and an image and an audio
 * uploaded at its end.
 * @param p - The page.
 */
async function openDocument(p: Page): Promise<void> {
  await openSmokeProject(p);
  createdSpaceIds.push(await createSpace(p, 'document', `preview-styles-${Date.now()}`));
  const editor = p.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await editor.evaluate(
    (el, { unbroken, url }) => {
      let n = 0;
      const text = (value: string, marks: unknown[] = []): unknown => ({ type: 'text', text: value, marks });
      const block = (type: string, attrs: Record<string, unknown>, content?: unknown[], children?: unknown[]): unknown => {
        n += 1;
        return {
          type: 'blockContainer',
          attrs: { id: `preview-${n}` },
          content: [
            { type, attrs, ...(content === undefined ? {} : { content }) },
            ...(children === undefined ? [] : [{ type: 'blockGroup', content: children }]),
          ],
        };
      };
      const cell = (type: string, value: string, attrs: Record<string, unknown> = {}): unknown => ({
        type,
        attrs,
        content: [{ type: 'tableParagraph', content: value === '' ? [] : [text(value)] }],
      });
      const quoted = { quoted: true };
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'blockGroup',
            content: [
              block('heading', { level: 1 }, [text('Heading one')]),
              block('paragraph', {}, [
                text('Bold', [{ type: 'bold' }]),
                text(' italic', [{ type: 'italic' }]),
                text(' under', [{ type: 'underline' }]),
                text(' strike', [{ type: 'strike' }]),
                text(' code', [{ type: 'code' }]),
                text(' link', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
                text(' red', [{ type: 'textColor', attrs: { stringValue: 'red' } }]),
                text(' tinted', [{ type: 'backgroundColor', attrs: { stringValue: 'blue' } }]),
                text(' office fiction flow'),
              ]),
              block('paragraph', quoted, [text('Quote opens')]),
              block('heading', { ...quoted, level: 2 }, [text('Quoted heading in the middle')]),
              block('paragraph', quoted, [text('Quote closes')]),
              block('heading', { level: 3 }, [text('Heading three')]),
              block('bulletListItem', {}, [text('Bullet')], [
                block('bulletListItem', {}, [text('Nested bullet')]),
                block('paragraph', quoted, [text('Nested quote')]),
              ]),
              block('numberedListItem', {}, [text('One')]),
              block('numberedListItem', {}, [text('Two')]),
              block('checkListItem', { checked: true }, [text('Checked')]),
              block('codeBlock', {}, [text(`const id = "${unbroken}";`)]),
              block('paragraph', {}, [text(url)]),
              block('divider', {}),
              block('table', {}, [
                { type: 'tableRow', content: [cell('tableHeader', 'Head one'), cell('tableHeader', 'Head two')] },
                { type: 'tableRow', content: [cell('tableCell', unbroken.slice(0, 120)), cell('tableCell', 'b2')] },
                { type: 'tableRow', content: [cell('tableCell', 'a3', { backgroundColor: 'blue' }), cell('tableCell', 'b3')] },
              ]),
              block('table', quoted, [
                { type: 'tableRow', content: [cell('tableCell', 'q1'), cell('tableCell', 'A quoted table cell holding a long sentence of words')] },
                { type: 'tableRow', content: [cell('tableCell', 'q2'), cell('tableCell', 'r2')] },
              ]),
              block('heading', { ...quoted, level: 1 }, [text('Quoted heading first')]),
              block('paragraph', quoted, [text('After the quoted heading')]),
              block('unsupportedBlock', { originalName: 'callout' }),
              block('paragraph', {}, [text('Media follow')]),
            ],
          },
        ],
      };
      (el as unknown as { editor: { commands: { setContent: (c: unknown) => void; focus: (at: string) => void } } }).editor.commands.setContent(doc);
      (el as unknown as { editor: { commands: { focus: (at: string) => void } } }).editor.commands.focus('end');
    },
    { unbroken: UNBROKEN, url: URL_TEXT },
  );
  const png = readFileSync(resolve(__dirname, '../fixtures/portrait.png')).toString('base64');
  await editor.evaluate(
    (element, { image, sound }) => {
      const transfer = new DataTransfer();
      const bytes = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      transfer.items.add(new File([bytes(image)], 'portrait.png', { type: 'image/png' }));
      transfer.items.add(new File([bytes(sound)], 'clip.wav', { type: 'audio/wav' }));
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    },
    { image: png, sound: wavBytes().toString('base64') },
  );
  await expect(p.locator(`${EDITOR} [data-content-type="image"] [data-media-box] img`)).toBeVisible({ timeout: 60_000 });
  await expect(p.locator(`${EDITOR} [data-content-type="audio"] [data-media-box]`)).toBeVisible({ timeout: 60_000 });
}

/**
 * Starts a drag of the selection the way ProseMirror's own dragstart is
 * reached, on a word of a block, and keeps the preview it hands over.
 * @param p - The page.
 * @param from - The text the selection starts in, and where.
 * @param to - The text it ends in, and where.
 * @param on - The text of the block the drag starts on.
 */
async function dragSelection(p: Page, from: [string, number], to: [string, number], on: string): Promise<void> {
  await p.locator(EDITOR).evaluate(
    (el, { from, to, on }) => {
      type View = { state: { doc: { descendants: (f: (n: { isTextblock: boolean; textContent: string }, pos: number) => boolean | void) => void } } };
      const editor = (el as unknown as { editor: { view: View; commands: { setTextSelection: (r: { from: number; to: number }) => void; selectAll: () => void } } }).editor;
      const start = (text: string): number => {
        let at = -1;
        editor.view.state.doc.descendants((node, pos) => {
          if (at < 0 && node.isTextblock && node.textContent.startsWith(text)) at = pos + 1;
          return at < 0;
        });
        return at;
      };
      if (from[0] === '*') editor.commands.selectAll();
      else editor.commands.setTextSelection({ from: start(from[0]) + from[1], to: start(to[0]) + to[1] });
      const word = [...el.querySelectorAll('.bn-inline-content')].find((w) => (w.textContent ?? '').startsWith(on))!;
      const box = word.getBoundingClientRect();
      const event = new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        clientX: box.left + 2,
        clientY: box.top + box.height / 2,
        dataTransfer: new DataTransfer(),
      });
      word.dispatchEvent(event);
    },
    { from, to, on },
  );
  await settle(p);
}

/**
 * Lifts something by a handle with the real pointer, lets the drag start,
 * and cancels it.
 * @param p - The page.
 * @param over - Where to rest the pointer so the handle shows.
 * @param handle - The handle's test id.
 * @throws {Error} When the handle has no box.
 */
async function dragHandle(p: Page, over: { x: number; y: number }, handle: string): Promise<void> {
  await p.mouse.move(5, 5);
  await p.mouse.move(over.x, over.y, { steps: 3 });
  const grip = await p.getByTestId(handle).first().boundingBox();
  if (grip === null) throw new Error(`no box for ${handle}`);
  await p.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await p.mouse.down();
  await p.mouse.move(grip.x + grip.width / 2 + 6, grip.y + grip.height / 2 + 10, { steps: 4 });
  await p.keyboard.press('Escape');
  await p.mouse.up();
  await settle(p);
}

/**
 * Brings the body to rest: no drag, no selection, no pointer over it.
 * @param p - The page.
 */
async function settle(p: Page): Promise<void> {
  await p.mouse.move(5, 5);
  await p.locator(EDITOR).evaluate((el) => {
    (el as unknown as { editor: { commands: { setTextSelection: (at: number) => void } } }).editor.commands.setTextSelection(1);
    (el as HTMLElement).blur();
  });
  await p.waitForTimeout(150);
}

/**
 * Compares every preview kept so far with the body.
 * @param p - The page.
 * @returns One report per preview: what differs, and what the body has none of.
 */
async function compareKept(p: Page): Promise<Array<{ diffs: string[]; unmatched: string[] }>> {
  return p.evaluate(() => {
    const win = window as unknown as {
      __previews: Element[];
      __comparePreview: (root: Element) => { diffs: Array<{ where: string; prop: string; body: string; preview: string }>; unmatched: string[] };
    };
    return win.__previews.map((root) => {
      const { diffs, unmatched } = win.__comparePreview(root);
      return { diffs: diffs.map((d) => `${d.where} ${d.prop}: body ${d.body} / preview ${d.preview}`), unmatched };
    });
  });
}

/**
 * A point near the start of the first element matching a selector in the
 * body, scrolled into view.
 * @param p - The page.
 * @param selector - Under the editor.
 * @returns The point.
 * @throws {Error} When it has no box.
 */
async function centreOf(p: Page, selector: string): Promise<{ x: number; y: number }> {
  const target = p.locator(`${EDITOR} ${selector}`).first();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box === null) throw new Error(`no box for ${selector}`);
  return { x: box.x + Math.min(40, box.width / 2), y: box.y + box.height / 2 };
}

for (const theme of ['light', 'dark'] as const) {
  test(`A1: every preview draws its content as the body does (${theme})`, async () => {
    await page.emulateMedia({ colorScheme: theme });
    await openDocument(page);

    // Selections: the whole body; ending on a heading in the middle of a quote;
    // starting on it; a nested quoted block alone.
    await dragSelection(page, ['*', 0], ['*', 0], 'Heading one');
    await dragSelection(page, ['Bold', 2], ['Quoted heading', 4], 'Bold');
    await dragSelection(page, ['Quoted heading', 2], ['Heading three', 4], 'Quoted heading');
    await dragSelection(page, ['Nested quote', 1], ['Nested quote', 5], 'Nested quote');

    // Handles: a row with blocks nested under it, a table row and a column, a
    // quoted table's row, the image and the audio.
    await dragHandle(page, await centreOf(page, '[data-content-type="bulletListItem"]'), 'doc-block-handle');
    const cellText = (t: string): string => `td:has-text("${t}")`;
    await dragHandle(page, await centreOf(page, cellText('b2')), 'doc-table-row-handle');
    await dragHandle(page, await centreOf(page, cellText('b2')), 'doc-table-col-handle');
    await dragHandle(page, await centreOf(page, cellText('r2')), 'doc-table-row-handle');
    await dragHandle(page, await centreOf(page, '[data-content-type="image"] [data-media-box]'), 'doc-block-handle');
    await dragHandle(page, await centreOf(page, '[data-content-type="audio"] [data-media-box]'), 'doc-block-handle');

    // A cell selection in the quoted table, dragged from its head cell.
    const q1 = await centreOf(page, cellText('q1'));
    const r2 = await centreOf(page, cellText('r2'));
    await page.mouse.move(q1.x, q1.y);
    await page.mouse.down();
    await page.mouse.move(r2.x, r2.y, { steps: 6 });
    await page.mouse.up();
    await page.locator(`${EDITOR} ${cellText('r2')}`).evaluate((cell) => {
      const box = cell.getBoundingClientRect();
      cell.dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, cancelable: true, clientX: box.left + 4, clientY: box.top + 4, dataTransfer: new DataTransfer() }),
      );
    });
    await settle(page);

    const reports = await compareKept(page);
    expect(reports.length).toBe(11);
    const found = reports.flatMap((report, index) => [
      ...report.unmatched.map((el) => `preview ${index}: no original for ${el}`),
      ...report.diffs.map((diff) => `preview ${index}: ${diff}`),
    ]);
    expect(found).toEqual([]);
  });
}
