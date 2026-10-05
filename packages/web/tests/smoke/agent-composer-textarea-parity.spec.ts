// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The chat box was a textarea before it took reference blocks, and what a
 * reader does in it ends the way it did there. The expected endings below
 * were measured on that textarea, in this browser, with these same steps.
 * Typing, an input method, pasting and dropping text go through the browser,
 * so only a real browser shows what they leave in the box.
 */
import { expect, test, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';

test.use({ storageState: STATE_FILE.A, viewport: { width: 1500, height: 900 } });

const BOX = '[data-testid="chat-composer-box"]';
const LIMIT = 10_000;
const MARKER = '__breatic_canvas_nodes__:';
const PICTURE = { type: 'image', position: { x: 0, y: 0 }, name: 'Pic', content: 'https://img.example.com/p.jpg', external: true };

const STARTS: Record<string, string> = {
  empty: '',
  short: 'hello world',
  near: 'y'.repeat(LIMIT - 2),
  full: 'y'.repeat(LIMIT),
};

/**
 * What the box holds, a line break as `\n`.
 * @param page - The page.
 * @returns The text and whether an input method is still composing.
 */
async function read(page: Page): Promise<{ text: string; composing: boolean }> {
  return page.evaluate((sel) => {
    const e = (document.querySelector(sel) as unknown as { editor: { view: { composing: boolean }; state: { doc: { content: { size: number }; textBetween: (a: number, b: number, s: string) => string } } } }).editor;
    return { text: e.state.doc.textBetween(0, e.state.doc.content.size, '\n'), composing: e.view.composing };
  }, BOX);
}

/**
 * Opens a fresh conversation with the given words in the box, caret at the end.
 * @param page - The page.
 * @param text - The words.
 */
async function start(page: Page, text: string): Promise<void> {
  await page.getByTestId('new-conversation').click();
  await page.locator(BOX).click();
  await page.evaluate(([sel, t]) => {
    const e = (document.querySelector(sel as string) as unknown as { editor: { view: { dispatch: (x: unknown) => void }; state: { tr: { insertText: (s: string) => { setMeta: (k: string, v: unknown) => unknown } } } } }).editor;
    e.view.dispatch(e.state.tr.insertText(t as string).setMeta('addToHistory', false));
  }, [BOX, text]);
}

/**
 * Composes with a CJK input method and commits.
 * @param page - The page.
 * @param steps - The composition as it grows.
 * @param commit - What is committed.
 */
async function compose(page: Page, steps: string[], commit: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  for (const s of steps) await cdp.send('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length });
  await cdp.send('Input.insertText', { text: commit });
}

/**
 * Pastes plain text through the system clipboard.
 * @param page - The page.
 * @param text - What is pasted.
 */
async function paste(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press('ControlOrMeta+V');
}

/**
 * Drops plain text at the right end of the box's last visible line.
 * @param page - The page.
 * @param text - What is dropped.
 */
async function drop(page: Page, text: string): Promise<void> {
  const { x, y } = await page.evaluate((sel) => {
    const box = document.querySelector(sel) as HTMLElement;
    const vp = (box.closest('[data-radix-scroll-area-viewport]') as HTMLElement | null) ?? box;
    const b = box.getBoundingClientRect();
    const v = vp.getBoundingClientRect();
    return { x: Math.min(b.right, v.right) - 10, y: Math.min(b.bottom, v.bottom) - 12 };
  }, BOX);
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [{ mimeType: 'text/plain', data: text }], dragOperationsMask: 1 };
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data });
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data });
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y, data });
}

const ACTIONS: Record<string, (page: Page) => Promise<void>> = {
  'type ab': (p) => p.keyboard.type('ab'),
  'ime 1 char': (p) => compose(p, ['n', 'ni', 'nih'], '你'),
  'ime 3 chars': (p) => compose(p, ['n', 'ni', 'nih', 'niha', 'nihao', 'nihaoa'], '你好啊'),
  'paste 6': (p) => paste(p, 'abcdef'),
  'paste 2 lines': (p) => paste(p, 'ab\ncd'),
  'drop 6': (p) => drop(p, 'abcdef'),
  backspace: (p) => p.keyboard.press('Backspace'),
  'shift+enter': (p) => p.keyboard.press('Shift+Enter'),
  'select all, type x': async (p) => {
    await p.keyboard.press('ControlOrMeta+A');
    await p.keyboard.type('x');
  },
  'arrow left, type z': async (p) => {
    await p.keyboard.press('ArrowLeft');
    await p.keyboard.type('z');
  },
};

/** What the textarea ended with, per start and action. A `null` tail is where the drop point fell mid-text. */
const TEXTAREA: { start: string; action: string; len: number; tail: string | null }[] = [
  { start: 'empty', action: 'type ab', len: 2, tail: 'ab' },
  { start: 'empty', action: 'ime 1 char', len: 1, tail: '你' },
  { start: 'empty', action: 'ime 3 chars', len: 3, tail: '你好啊' },
  { start: 'empty', action: 'paste 6', len: 6, tail: 'abcdef' },
  { start: 'empty', action: 'paste 2 lines', len: 5, tail: 'ab\ncd' },
  { start: 'empty', action: 'drop 6', len: 6, tail: 'abcdef' },
  { start: 'empty', action: 'backspace', len: 0, tail: '' },
  { start: 'empty', action: 'shift+enter', len: 1, tail: '\n' },
  { start: 'empty', action: 'select all, type x', len: 1, tail: 'x' },
  { start: 'empty', action: 'arrow left, type z', len: 1, tail: 'z' },
  { start: 'short', action: 'type ab', len: 13, tail: 'ello worldab' },
  { start: 'short', action: 'ime 1 char', len: 12, tail: 'hello world你' },
  { start: 'short', action: 'ime 3 chars', len: 14, tail: 'llo world你好啊' },
  { start: 'short', action: 'paste 6', len: 17, tail: ' worldabcdef' },
  { start: 'short', action: 'paste 2 lines', len: 16, tail: 'o worldab\ncd' },
  { start: 'short', action: 'drop 6', len: 17, tail: ' worldabcdef' },
  { start: 'short', action: 'backspace', len: 10, tail: 'hello worl' },
  { start: 'short', action: 'shift+enter', len: 12, tail: 'hello world\n' },
  { start: 'short', action: 'select all, type x', len: 1, tail: 'x' },
  { start: 'short', action: 'arrow left, type z', len: 12, tail: 'hello worlzd' },
  { start: 'near', action: 'type ab', len: 10_000, tail: 'yyyyyyyyyyab' },
  { start: 'near', action: 'ime 1 char', len: 9_999, tail: 'yyyyyyyyyyy你' },
  { start: 'near', action: 'ime 3 chars', len: 10_000, tail: 'yyyyyyyyyy你好' },
  { start: 'near', action: 'paste 6', len: 10_000, tail: 'yyyyyyyyyyab' },
  { start: 'near', action: 'paste 2 lines', len: 10_000, tail: 'yyyyyyyyyyab' },
  { start: 'near', action: 'drop 6', len: 10_000, tail: null },
  { start: 'near', action: 'backspace', len: 9_997, tail: 'yyyyyyyyyyyy' },
  { start: 'near', action: 'shift+enter', len: 9_999, tail: 'yyyyyyyyyyy\n' },
  { start: 'near', action: 'select all, type x', len: 1, tail: 'x' },
  { start: 'near', action: 'arrow left, type z', len: 9_999, tail: 'yyyyyyyyyyzy' },
  { start: 'full', action: 'type ab', len: 10_000, tail: 'yyyyyyyyyyyy' },
  { start: 'full', action: 'ime 1 char', len: 10_000, tail: 'yyyyyyyyyyyy' },
  { start: 'full', action: 'ime 3 chars', len: 10_000, tail: 'yyyyyyyyyyyy' },
  { start: 'full', action: 'paste 6', len: 10_000, tail: 'yyyyyyyyyyyy' },
  { start: 'full', action: 'paste 2 lines', len: 10_000, tail: 'yyyyyyyyyyyy' },
  { start: 'full', action: 'drop 6', len: 10_000, tail: 'yyyyyyyyyyyy' },
  { start: 'full', action: 'backspace', len: 9_999, tail: 'yyyyyyyyyyyy' },
  { start: 'full', action: 'shift+enter', len: 10_000, tail: 'yyyyyyyyyyyy' },
  { start: 'full', action: 'select all, type x', len: 1, tail: 'x' },
  { start: 'full', action: 'arrow left, type z', len: 10_000, tail: 'yyyyyyyyyyyy' },
];

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // Nothing is sent: a send waits here for as long as the test needs.
  await page.route('**/chat/message', () => undefined);
  await openSmokeProject(page);
});

for (const row of TEXTAREA) {
  test(`${row.start} box, ${row.action}: ends as the textarea did`, async ({ page }) => {
    await start(page, STARTS[row.start] ?? '');
    await ACTIONS[row.action]!(page);

    await expect.poll(async () => (await read(page)).text.length).toBe(row.len);
    const after = await read(page);
    if (row.tail !== null) expect(after.text.slice(-row.tail.length || Infinity)).toBe(row.tail);
    expect(after.composing).toBe(false);
  });
}

test('the keyboard stays on the box while a sent message waits for its answer', async ({ page }) => {
  await start(page, 'hello');
  await page.keyboard.press('Enter');
  await expect(page.locator(BOX)).toHaveAttribute('contenteditable', 'false');

  expect(await page.evaluate((sel) => document.activeElement === document.querySelector(sel), BOX)).toBe(true);
});

test('handing the keyboard back after removing an attachment keeps the caret where it was', async ({ page }) => {
  await start(page, 'hello');
  await page.evaluate(([sel, t]) => {
    const data = new DataTransfer();
    data.setData('text/plain', t as string);
    document.querySelector(sel as string)?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, [BOX, MARKER + JSON.stringify([PICTURE])]);
  // A click somewhere else on the page moves the document's selection out of the box.
  await page.mouse.click(5, 5);
  await page.getByTestId('chat-composer-chips').getByRole('button').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.type('z');

  expect((await read(page)).text).toBe('helloz');
});

test('an empty box does not scroll', async ({ page }) => {
  await start(page, '');

  const overflow = await page.evaluate((sel) => {
    const vp = document.querySelector(sel)?.closest('[data-radix-scroll-area-viewport]') as HTMLElement;
    return vp.scrollHeight - vp.clientHeight;
  }, BOX);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('a line break still follows a composition that stopped at the limit', async ({ page }) => {
  await start(page, STARTS.near ?? '');
  await compose(page, ['n', 'ni', 'nih'], '你');
  await page.keyboard.press('Shift+Enter');

  await expect.poll(async () => (await read(page)).text.endsWith('你\n')).toBe(true);
});

for (const [language, steps, commit, kept] of [
  ['Korean', ['ㅎ', '하', '한', '한ㄱ', '한그', '한글'], '한글', '한'],
  ['Japanese', ['に', 'にほ', 'にほん'], 'にほん', 'に'],
] as const) {
  test(`a ${language} composition committed as it showed is cut from its own end as it ends`, async ({ page }) => {
    await start(page, `ab${'y'.repeat(LIMIT - 3)}`);
    await compose(page, [...steps], commit);

    await expect.poll(async () => (await read(page)).text, { timeout: 1_000 }).toBe(`ab${'y'.repeat(LIMIT - 3)}${kept}`);
    // Moving the caret afterwards leaves the reader's earlier words alone.
    await page.evaluate((sel) => {
      (document.querySelector(sel) as unknown as { editor: { commands: { setTextSelection: (p: number) => void } } }).editor.commands.setTextSelection(2);
    }, BOX);
    expect((await read(page)).text).toBe(`ab${'y'.repeat(LIMIT - 3)}${kept}`);
  });
}

const WEB_PLAIN = 'def f():\n    return 1\n\nprint(f())';
const WEB_HTML = '<pre>def f():\n    return 1\n\nprint(f())</pre>';

test('words copied from a web page are pasted as its plain text, line breaks and indents kept', async ({ page }) => {
  await start(page, 'hello ');
  await page.evaluate(([html, plain]) => navigator.clipboard.write([
    new ClipboardItem({ 'text/html': new Blob([html as string], { type: 'text/html' }), 'text/plain': new Blob([plain as string], { type: 'text/plain' }) }),
  ]), [WEB_HTML, WEB_PLAIN]);
  await page.keyboard.press('ControlOrMeta+V');

  await expect.poll(async () => (await read(page)).text).toBe(`hello ${WEB_PLAIN}`);
});

test('words dragged in from a web page land as its plain text, line breaks and indents kept', async ({ page }) => {
  await start(page, 'hello ');
  const { x, y } = await page.evaluate((sel) => {
    const b = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
    return { x: b.right - 10, y: b.top + 14 };
  }, BOX);
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [{ mimeType: 'text/html', data: WEB_HTML }, { mimeType: 'text/plain', data: WEB_PLAIN }], dragOperationsMask: 1 };
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data });
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data });
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y, data });

  await expect.poll(async () => (await read(page)).text).toBe(`hello ${WEB_PLAIN}`);
});

for (const [where, expected] of [
  ['below the last line', ' world\nabchello'],
  ['to the right of a shorter line', ' worldhello\nabc'],
] as const) {
  test(`a word dragged within the box ${where} joins that line, as in the textarea`, async ({ page }) => {
    await start(page, '');
    await page.keyboard.type('hello world');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('abc');
    const at = await page.evaluate(([sel, w]) => {
      const el = document.querySelector(sel as string) as HTMLElement;
      const e = (el as unknown as { editor: { commands: { setTextSelection: (r: { from: number; to: number }) => void }; view: { coordsAtPos: (p: number) => { left: number; right: number; top: number; bottom: number } } } }).editor;
      e.commands.setTextSelection({ from: 1, to: 6 });
      const word = e.view.coordsAtPos(3);
      const first = e.view.coordsAtPos(12);
      const last = e.view.coordsAtPos(16);
      const box = el.getBoundingClientRect();
      return w === 'below the last line'
        ? { sx: word.left, sy: (word.top + word.bottom) / 2, tx: last.left + 30, ty: box.bottom - 2 }
        : { sx: word.left, sy: (word.top + word.bottom) / 2, tx: box.right - 8, ty: (first.top + first.bottom) / 2 };
    }, [BOX, where]);
    // A press held still is what makes the browser start dragging the selection.
    await page.mouse.move(at.sx, at.sy);
    await page.mouse.down();
    await page.waitForTimeout(150);
    await page.mouse.move(at.sx + 10, at.sy + 2, { steps: 5 });
    await page.waitForTimeout(100);
    await page.mouse.move(at.tx, at.ty, { steps: 20 });
    await page.mouse.up();

    await expect.poll(async () => (await read(page)).text).toBe(expected);
  });
}
