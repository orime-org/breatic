// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Formulas in the document body end to end (inner#1423).
 *
 * What jsdom cannot show: the box's text field taking the real keyboard,
 * real typing of `$$x$$` with a real Cmd/Ctrl+Z after it, the arrow keys
 * walking into and out of an inline formula's source, the browser's own word
 * and line deletion, paste and undo in the field, presses and drags in the
 * field adding nothing to the body, the box drawn in a table cell, a wide
 * formula scrolling inside its frame, a copy and a paste through the
 * browser's own events, a drag that ends on a rendered formula, the
 * select-all confirmation, a second page seeing an edit arrive, the snapshot
 * comparison and restore, and the box's corners and surface as the two
 * themes compute them.
 *
 * Wants dev running:
 *   pnpm --filter @breatic/web test:smoke
 */
import { expect, type Locator, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { selectInBody } from '../helpers/editor-keys';
import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, DOCUMENT_EDITOR as EDITOR, visibleSpace } from '../helpers/space';

let page: Page;

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
});

const createdSpaceIds: string[] = [];

test.afterEach(async () => {
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
  await page?.close();
});

/** The formula whose box is open. */
const OPEN = `${EDITOR} .doc-math[data-open="true"]`;

/** The open formula's box. */
const BOX = `${OPEN} [data-formula-box]`;

/** The box's text field, where the source is edited. */
const FIELD = `${BOX} textarea`;

/** A drawn formula a press opens. */
const FACE = `${EDITOR} .doc-math [role="button"], ${EDITOR} .doc-math .katex`;

/**
 * Open a freshly made Document Space with the caret in the body.
 * @param p - The page.
 * @returns The new Space's id.
 */
async function openFreshDocument(p: Page): Promise<string> {
  await openSmokeProject(p);
  const id = await createSpace(p, 'document', `math-${Date.now()}`);
  createdSpaceIds.push(id);
  const editor = p.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await expect(editor).toBeFocused();
  return id;
}

/**
 * Every row as `type:text`, a formula inside a line written `[math:source]`
 * and a formula block as `mathBlock:source`, read off the editor's document.
 * @param p - The page.
 * @returns One entry per row.
 */
async function lines(p: Page): Promise<string[]> {
  return p.evaluate((selector) => {
    type PMNode = {
      type: { name: string };
      attrs: Record<string, unknown>;
      isText: boolean;
      isTextblock: boolean;
      text?: string;
      forEach: (fn: (child: PMNode) => void) => void;
      descendants: (fn: (node: PMNode) => boolean | void) => void;
    };
    const view = document.querySelector(selector) as unknown as { editor?: { state: { doc: PMNode } } } | null;
    // A page still opening has no editor yet; an empty answer lets a poll wait for it.
    if (view?.editor === undefined) return [];
    const doc = view.editor.state.doc;
    const out: string[] = [];
    doc.descendants((node) => {
      if (node.type.name === 'mathBlock') {
        out.push(`mathBlock:${String(node.attrs['source'])}`);
        return false;
      }
      if (!node.isTextblock) return true;
      let text = '';
      node.forEach((child) => {
        text += child.type.name === 'math' ? `[math:${String(child.attrs['source'])}]` : child.isText ? child.text ?? '' : '';
      });
      out.push(`${node.type.name}:${text}`);
      return false;
    });
    return out;
  }, EDITOR);
}

/**
 * Picks the formula entry off the plus of the first (empty) line.
 * @param p - The page.
 */
async function insertFromPlus(p: Page): Promise<void> {
  await p.locator(`${EDITOR} .bn-block-content`).last().hover();
  await visibleSpace(p).getByTestId('doc-block-plus').click();
  await p.getByTestId('doc-block-insert-formula').click();
  await expect(p.locator(FIELD)).toBeFocused();
}

/**
 * Opens the first formula's box with a click on what it draws.
 * @param p - The page.
 */
async function openFirst(p: Page): Promise<void> {
  await p.locator(FACE).first().click();
  await expect(p.locator(FIELD)).toBeFocused();
}

/**
 * Where the caret is in the box's text field.
 * @param p - The page.
 * @returns The caret's offset and the field's length.
 */
async function caretInField(p: Page): Promise<{ at: number; length: number }> {
  return p.locator(FIELD).evaluate((field: HTMLTextAreaElement) => ({
    at: field.selectionStart,
    length: field.value.length,
  }));
}

/**
 * Whether the body's editor holds the keyboard.
 * @param p - The page.
 * @returns The answer.
 */
async function bodyFocused(p: Page): Promise<boolean> {
  return p.evaluate((selector) => document.activeElement === document.querySelector(selector), EDITOR);
}

/**
 * Sends HTML and its text fallback through the browser's paste event.
 * @param p - The page holding the focused editor.
 * @param data - The clipboard's formats.
 */
async function paste(p: Page, data: Record<string, string>): Promise<void> {
  await p.evaluate(({ selector, data }) => {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(data)) transfer.setData(type, value);
    document.querySelector(selector)!.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, { selector: EDITOR, data });
}

/**
 * Copies the selection through the browser's copy event and hands back what
 * the editor wrote.
 * @param p - The page.
 * @returns Every format written.
 */
async function copy(p: Page): Promise<Record<string, string>> {
  return p.evaluate((selector) => {
    const transfer = new DataTransfer();
    document.querySelector(selector)!.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
    return Object.fromEntries(transfer.types.map((type) => [type, transfer.getData(type)]));
  }, EDITOR);
}

/**
 * Selects the whole of the first paragraph's text.
 * @param p - The page.
 */
async function selectFirstParagraph(p: Page): Promise<void> {
  await selectInBody(p, () => p.evaluate((selector) => {
    const paragraph = document.querySelector(`${selector} p`)!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, EDITOR));
}

/**
 * Puts the caret at the end of the first line. `End` only scrolls on macOS.
 * @param p - The page.
 */
async function caretAtEndOfFirstLine(p: Page): Promise<void> {
  await selectInBody(p, () => p.evaluate((selector) => {
    const paragraph = document.querySelector(`${selector} p`)!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, EDITOR));
}

/**
 * Scrolls the body, and only the body, until a formula sits where asked: its
 * bottom edge 40px above the window's, or its top edge 10px below the body's.
 * Each pass measures again, since the page can still settle after a scroll.
 * @param formula - The rendered formula.
 * @param at - Where it is to sit.
 */
async function scrollFormulaTo(formula: Locator, at: 'window-bottom' | 'body-top'): Promise<void> {
  await expect.poll(() => formula.evaluate((element, where) => {
    const scroller = element.closest<HTMLElement>('.doc-body-scroller > [data-radix-scroll-area-viewport]')!;
    const rect = element.getBoundingClientRect();
    const off = where === 'window-bottom'
      ? rect.bottom - (window.innerHeight - 40)
      : rect.top - (scroller.getBoundingClientRect().top + 10);
    scroller.scrollTop += off;
    return Math.abs(Math.round(off));
  }, at)).toBeLessThanOrEqual(1);
}

/**
 * Pastes a table between forty lines above and forty below, then types an
 * inline formula at the end of the table's first cell.
 * @param p - The page.
 * @param columns - How many columns the table has.
 * @returns The rendered formula.
 */
async function formulaInCellBelowLines(p: Page, columns: number): Promise<Locator> {
  const filler = Array.from({ length: 40 }, (_, i) => `<p>line ${i}</p>`).join('');
  const row = (first: string): string => `<tr><td>${first}</td>${'<td>more words here</td>'.repeat(columns - 1)}</tr>`;
  await paste(p, { 'text/html': `${filler}<table><tbody>${row('cell')}${row('c')}</tbody></table>${filler}` });
  await p.locator(`${EDITOR} table td`, { hasText: 'cell' }).click();
  await p.keyboard.press('End');
  await p.keyboard.type(' $$x^2$$');
  const formula = p.locator(`${EDITOR} table .doc-math .katex`).first();
  await expect(formula).toBeVisible();
  return formula;
}

/**
 * Scrolls the table holding a formula sideways to one end.
 * @param formula - The rendered formula.
 * @param to - Which end.
 */
async function scrollTableTo(formula: Locator, to: 'start' | 'end'): Promise<void> {
  await formula.evaluate((element, end) => {
    const scroller = element.closest<HTMLElement>('[data-radix-scroll-area-viewport]')!;
    scroller.scrollLeft = end ? scroller.scrollWidth : 0;
  }, to === 'end');
}

/**
 * Whether the open box shows at its middle, where a press would find it.
 * @param p - The page.
 * @returns False when no box is open or something else is drawn there.
 */
async function boxShows(p: Page): Promise<boolean> {
  return p.evaluate((selector) => {
    const box = document.querySelector(selector);
    if (box === null) return false;
    const rect = box.getBoundingClientRect();
    return box.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  }, BOX);
}

test('a formula block from the plus menu: the box opens with the caret in it, Enter confirms, KaTeX draws it', async () => {
  await openFreshDocument(page);
  await insertFromPlus(page);

  await page.keyboard.type('\\frac{a}{b}');
  // The formula in the body is the live preview.
  await expect(page.locator(`${EDITOR} .katex-display .mfrac`)).toBeVisible();
  await page.keyboard.press('Enter');

  await expect(page.locator(OPEN)).toHaveCount(0);
  expect((await lines(page))[0]).toBe('mathBlock:\\frac{a}{b}');
  await expect(page.locator(`${EDITOR} .doc-math[data-selected="true"]`)).toHaveCount(1);
  expect(await bodyFocused(page)).toBe(true);
});

test('a formula block in a table cell opens its box on screen', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('above');
  await page.locator(`${EDITOR} .bn-block-content`).first().hover();
  await visibleSpace(page).getByTestId('doc-block-handle').click();
  await page.getByTestId('doc-block-row-insertBelow').hover();
  await page.getByTestId('doc-block-insert-table').hover();
  await page.getByTestId('doc-table-size-2-2').click();
  await expect(page.locator(`${EDITOR} table`)).toHaveCount(1);

  const cell = page.locator(`${EDITOR} table td .bn-block-content`).first();
  await cell.hover();
  await visibleSpace(page).getByTestId(/^doc-block-(table-)?handle$|^doc-block-plus$/).first().click();
  const plus = page.getByTestId('doc-block-insert-formula');
  if (!(await plus.isVisible())) await page.getByTestId('doc-block-row-insertBelow').hover();
  await page.getByTestId('doc-block-insert-formula').click();
  await expect(page.locator(FIELD)).toBeFocused();
  await page.keyboard.type('x^2');
  await expect(page.locator(`${EDITOR} table .katex-display`)).toBeVisible();

  const box = await page.locator(BOX).boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  await page.keyboard.press('Enter');
  await expect(page.locator(OPEN)).toHaveCount(0);
  await expect.poll(() => lines(page)).toContain('mathBlock:x^2');
});

test('a box opened near the bottom of the window opens above its formula, inside the window', async () => {
  await openFreshDocument(page);
  await paste(page, { 'text/plain': `${Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n\n')}\n\n$$\n\\frac{a}{b}\n$$` });
  const formula = page.locator(`${EDITOR} .doc-math .katex-display`).first();
  await expect(formula).toBeVisible();
  await scrollFormulaTo(formula, 'window-bottom');

  await formula.click();
  await expect(page.locator(FIELD)).toBeFocused();

  const box = (await page.locator(BOX).boundingBox())!;
  const drawn = (await formula.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(box.y + box.height).toBeLessThanOrEqual(drawn.y);
});

test('a box opened in a table cell near the bottom of the window opens above its formula, inside the window', async () => {
  await openFreshDocument(page);
  const formula = await formulaInCellBelowLines(page, 2);
  await scrollFormulaTo(formula, 'window-bottom');

  await formula.click();
  await expect(page.locator(FIELD)).toBeFocused();

  const box = (await page.locator(BOX).boundingBox())!;
  const drawn = (await formula.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(box.y + box.height).toBeLessThanOrEqual(drawn.y);
});

test('a box open in a table cell stays inside the body when the body scrolls', async () => {
  await openFreshDocument(page);
  const formula = await formulaInCellBelowLines(page, 2);
  await scrollFormulaTo(formula, 'window-bottom');
  await formula.click();
  await expect(page.locator(FIELD)).toBeFocused();

  // The box sits above the formula; the formula now goes up to the body's top.
  await scrollFormulaTo(formula, 'body-top');

  const box = (await page.locator(BOX).boundingBox())!;
  const body = (await page.locator('.doc-body-scroller').boundingBox())!;
  expect(box.y).toBeLessThan(body.y);
  // A point of the box above the body, inside the window: the top bar's.
  const above = { x: box.x + box.width / 2, y: (Math.max(box.y, 0) + body.y) / 2 };
  const covered = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-formula-box]') != null, above);
  expect(covered).toBe(false);
});

test('a box open in a table cell hides while the table scrolls its formula away, and keeps the typing', async () => {
  await openFreshDocument(page);
  const formula = await formulaInCellBelowLines(page, 12);
  await formula.click();
  await expect(page.locator(FIELD)).toBeFocused();
  // Inside the body the clip reaches past each edge, so the shadow shows. The
  // browser writes equal sides once, so it lists one to four of them.
  expect(await page.locator(BOX).evaluate((box) => (box as HTMLElement).style.clipPath)).toMatch(/^inset\(-[\d.]+px( -[\d.]+px){0,3}\)$/);

  await scrollTableTo(formula, 'end');
  await expect.poll(() => boxShows(page)).toBe(false);
  await expect(page.locator(FIELD)).toBeFocused();
  await page.keyboard.type('+1');

  await scrollTableTo(formula, 'start');
  await expect.poll(() => boxShows(page)).toBe(true);
  await expect(page.locator(FIELD)).toHaveValue('x^2+1');
});

test('a box opened in a body column narrower than the box stays inside the column', async () => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await openFreshDocument(page);
  await page.keyboard.type(`${'word '.repeat(40)}$$a+b$$`);
  await expect.poll(() => lines(page)).toEqual([`paragraph:${'word '.repeat(40)}[math:a+b]`]);
  const column = (await page.locator('.doc-body-scroller').boundingBox())!;
  expect(column.width).toBeLessThan(560);

  await page.locator(`${EDITOR} .doc-math .katex`).first().click();
  await expect(page.locator(FIELD)).toBeFocused();

  const box = (await page.locator(BOX).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(column.x);
  expect(box.x + box.width).toBeLessThanOrEqual(column.x + column.width);
});

test('typing $$x^2$$ makes an inline formula; undo gives the words back and typing on keeps them', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('area $$x^2$$');
  await expect.poll(() => lines(page)).toEqual(['paragraph:area [math:x^2]']);
  await expect(page.locator(`${EDITOR} p .katex`)).toBeVisible();

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => lines(page)).toEqual(['paragraph:area $$x^2$$']);

  await page.keyboard.type(' more');
  await expect.poll(() => lines(page)).toEqual(['paragraph:area $$x^2$$ more']);
});

test('the arrow keys walk into an inline source and out again, and Backspace after it steps in', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('a $$xy$$');
  await expect.poll(() => lines(page)).toEqual(['paragraph:a [math:xy]']);
  await expect(page.locator(OPEN)).toHaveCount(0);

  // In from the right: the caret lands at the end of the source. Opening the
  // box leaves the body's selection where it is.
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(FIELD)).toBeFocused();
  expect(await caretInField(page)).toEqual({ at: 2, length: 2 });
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  expect(await caretInField(page)).toEqual({ at: 0, length: 2 });
  // Out on the left: the body's caret sits right before the formula.
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(OPEN)).toHaveCount(0);
  expect(await bodyFocused(page)).toBe(true);
  await page.keyboard.type('z');
  await expect.poll(() => lines(page)).toEqual(['paragraph:a z[math:xy]']);

  // In from the left: the caret lands at the start of the source.
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(FIELD)).toBeFocused();
  expect(await caretInField(page)).toEqual({ at: 0, length: 2 });
  await page.keyboard.press('Escape');
  await expect(page.locator(OPEN)).toHaveCount(0);

  await caretAtEndOfFirstLine(page);
  await page.keyboard.press('Backspace');
  await expect(page.locator(FIELD)).toBeFocused();
  expect(await caretInField(page)).toEqual({ at: 2, length: 2 });
  expect(await lines(page)).toEqual(['paragraph:a z[math:xy]']);
});

for (const how of ['Enter', 'Escape', 'a click outside', 'the confirm button'] as const) {
  test(`the box closes on ${how} and keeps what was typed`, async () => {
    await openFreshDocument(page);
    await insertFromPlus(page);
    await page.keyboard.type('y');
    if (how === 'Enter' || how === 'Escape') await page.keyboard.press(how);
    else if (how === 'a click outside') await page.mouse.click(5, 5);
    else await page.locator(BOX).getByRole('button', { name: 'OK', exact: true }).click();
    await expect(page.locator(OPEN)).toHaveCount(0);
    expect((await lines(page))[0]).toBe('mathBlock:y');
  });
}

test('an empty formula shows its placeholder, and one that does not parse shows the error face once closed', async () => {
  await openFreshDocument(page);
  await insertFromPlus(page);
  await page.keyboard.press('Escape');
  await expect(page.locator(`${EDITOR} .doc-math`).first()).toContainText('Add a formula');

  await openFirst(page);
  await page.keyboard.type('\\frac{a}{b');
  await expect(page.locator(BOX)).toContainText('expected \'}\'');
  await page.keyboard.press('Enter');
  await expect(page.locator(OPEN)).toHaveCount(0);
  await expect(page.locator(`${EDITOR} .doc-math`).first()).toContainText('Formula has an error');
  expect((await lines(page))[0]).toBe('mathBlock:\\frac{a}{b');
});

test('a word deletion and Shift+Home with Backspace in the box change only the source', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');
  await paste(page, { 'text/plain': '$$\nab cd\n$$' });
  await expect.poll(() => lines(page)).toContain('mathBlock:ab cd');

  await openFirst(page);
  await page.keyboard.press(process.platform === 'darwin' ? 'Alt+Backspace' : 'Control+Backspace');
  await expect.poll(() => lines(page)).toContain('mathBlock:ab ');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('z');
  await page.keyboard.press('Enter');

  await expect(page.locator(OPEN)).toHaveCount(0);
  expect((await lines(page)).slice(0, 2)).toEqual(['paragraph:hello', 'mathBlock:z']);
});

test('a paste in the box goes into the source, and Cmd+Z there takes it back', async () => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openFreshDocument(page);
  await insertFromPlus(page);
  await page.keyboard.type('a');
  await page.keyboard.press('Enter');
  const before = await lines(page);
  // Typing that close together is one undo step; the paste is its own.
  await page.waitForTimeout(600);

  await openFirst(page);
  await page.evaluate(() => navigator.clipboard.writeText('\\sqrt{2}'));
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(() => lines(page)).toEqual(before.map((line) => line.replace('mathBlock:a', 'mathBlock:a\\sqrt{2}')));
  await expect(page.locator(FIELD)).toHaveValue('a\\sqrt{2}');

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => lines(page)).toEqual(before);
  await expect(page.locator(FIELD)).toHaveValue('a');
});

test('Cmd+Z in the box of a formula just added takes it away and hands the keyboard back to the body', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  await insertFromPlus(page);

  await page.keyboard.press('ControlOrMeta+z');

  await expect(page.locator(`${EDITOR} .doc-math`)).toHaveCount(0);
  await expect.poll(() => bodyFocused(page)).toBe(true);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(page.locator(`${EDITOR} .doc-math`)).toHaveCount(1);
});

test('presses and a drag inside the box of a formula that ends the body add no line', async () => {
  await openFreshDocument(page);
  await insertFromPlus(page);
  await page.keyboard.type('abcdef');
  const before = await lines(page);
  expect(before[before.length - 1]).toBe('mathBlock:abcdef');

  const field = await page.locator(FIELD).boundingBox();
  if (field === null) throw new Error('no box for the field');
  await page.mouse.click(field.x + field.width / 2, field.y + field.height / 2);
  await page.mouse.move(field.x + 4, field.y + 8);
  await page.mouse.down();
  await page.mouse.move(field.x + field.width - 4, field.y + field.height - 4, { steps: 8 });
  await page.mouse.up();

  await expect(page.locator(FIELD)).toBeFocused();
  expect(await lines(page)).toEqual(before);
});

for (const [chord, key, modifiers, command] of [
  ['Ctrl+K', { key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75 }, 2, 'deleteToEndOfParagraph'],
  ['Cmd+Delete', { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }, 4, 'deleteToEndOfLine'],
] as const) {
  test(`${chord} right before an inline formula takes the whole formula with the rest of the line`, async () => {
    await openFreshDocument(page);
    await page.keyboard.type('a $$x^2$$ b');
    await expect.poll(() => lines(page)).toEqual(['paragraph:a [math:x^2] b']);
    // Right after `a `: `Home` only scrolls on macOS.
    await selectInBody(page, () => page.evaluate((selector) => {
      const range = document.createRange();
      range.setStart(document.querySelector(`${selector} p`)!.firstChild!, 2);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, EDITOR));

    // macOS binds the chord to this editing command, and Playwright presses
    // keys on macOS by naming the command the same way; naming it here sends
    // the same press on every platform.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key, modifiers, commands: [command] });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key, modifiers });

    await expect.poll(() => lines(page)).toEqual(['paragraph:a ']);
  });
}

test('a formula block selected from the line above is framed, and a wide one scrolls inside its frame', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');
  const wide = Array.from({ length: 120 }, (_, i) => `x_{${i}}`).join('+');
  await paste(page, { 'text/plain': `$$\n${wide}\n$$` });
  await expect.poll(() => lines(page)).toContain(`mathBlock:${wide}`);
  const frame = page.locator(`${EDITOR} .doc-math [data-math-frame]`).first();
  await caretAtEndOfFirstLine(page);
  expect(await frame.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('none');

  await page.keyboard.press('Delete');

  await expect(page.locator(OPEN)).toHaveCount(0);
  await expect.poll(() => frame.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('solid');
  expect(await frame.evaluate((element) => getComputedStyle(element).outlineWidth)).toBe('1px');
  expect((await lines(page)).slice(0, 2)).toEqual(['paragraph:hello', `mathBlock:${wide}`]);

  // The frame stays inside the column; the formula scrolls sideways in it.
  const measured = await frame.evaluate((element, selector) => {
    const viewport = element.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]')!;
    const column = document.querySelector(selector)!.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return {
      inside: box.left >= column.left - 1 && box.right <= column.right + 1,
      scrolls: viewport.scrollWidth > viewport.clientWidth,
    };
  }, EDITOR);
  expect(measured).toEqual({ inside: true, scrolls: true });
});

/**
 * The colour a token resolves to on this page.
 * @param p - The page.
 * @param token - The custom property, such as `--color-content-link`.
 * @returns The computed colour.
 */
async function tokenColour(p: Page, token: string): Promise<string> {
  return p.evaluate((name) => {
    const probe = document.createElement('div');
    probe.style.color = `var(${name})`;
    document.body.appendChild(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, token);
}

test('a formula under the pointer or open in its box is framed in the link colour, a block one 2px off its glyphs', async () => {
  await openFreshDocument(page);
  await paste(page, { 'text/plain': 'lead $$x$$ tail\n\n$$\ny\n$$\n\nlast' });
  await expect.poll(() => lines(page)).toContain('mathBlock:y');
  await page.getByText('last', { exact: true }).click();
  const link = await tokenColour(page, '--color-content-link');
  const frame = page.locator(`${EDITOR} .doc-math [data-math-frame]`).first();
  const inline = page.locator(`${EDITOR} span.doc-math > [data-math-face]`).first();
  const outline = (locator: Locator): Promise<string> =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor} ${style.outlineOffset}`;
    });
  expect(await outline(frame)).toMatch(/^none /);

  await page.locator(`${EDITOR} .katex-display`).hover();
  await expect.poll(() => outline(frame)).toBe(`solid 1px ${link} 2px`);

  await page.locator(`${EDITOR} p .katex`).first().hover();
  await expect.poll(() => outline(frame)).toMatch(/^none /);
  const accent = await tokenColour(page, '--color-accent');
  const lifted = await inline.evaluate((element) => [getComputedStyle(element).backgroundColor, getComputedStyle(element).cursor]);
  expect(lifted[1]).toBe('pointer');
  expect(lifted[0]).toBe(accent);

  await page.locator(`${EDITOR} p .katex`).first().click();
  await expect(page.locator(FIELD)).toBeFocused();
  await page.mouse.move(5, 5);
  await expect.poll(() => outline(inline)).toMatch(new RegExp(`^solid 1px ${link.replace(/[()]/g, '\\$&')}`));
  await page.keyboard.press('Escape');

  await page.locator(`${EDITOR} .katex-display`).click();
  await expect(page.locator(FIELD)).toBeFocused();
  await page.mouse.move(5, 5);
  await expect.poll(() => outline(frame)).toBe(`solid 1px ${link} 2px`);
});

test('a source that does not parse turns the field red while the box says what is wrong', async () => {
  await openFreshDocument(page);
  await insertFromPlus(page);
  await page.keyboard.type('\\frac{a');
  const red = await tokenColour(page, '--color-status-error-foreground');
  const field = page.locator(FIELD);
  await expect.poll(() => field.evaluate((element) => getComputedStyle(element).borderTopColor)).toBe(red);

  await page.keyboard.type('}{b}');
  await expect.poll(() => field.evaluate((element) => getComputedStyle(element).borderTopColor)).not.toBe(red);
});

test('a line holding a formula copies as $$source$$ and pastes back as a formula', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('a $$x^2$$ b');
  await expect.poll(() => lines(page)).toEqual(['paragraph:a [math:x^2] b']);

  await selectFirstParagraph(page);
  const written = await copy(page);
  expect(written['text/plain']).toContain('$$x^2$$');

  await caretAtEndOfFirstLine(page);
  await page.keyboard.press('Enter');
  await paste(page, written);
  await expect.poll(() => lines(page)).toEqual(['paragraph:a [math:x^2] b', 'paragraph:a [math:x^2] b']);
});

test('a reply copied from the chat pastes as a heading, a list and its formulas', async () => {
  await openFreshDocument(page);
  const display = '<span class="katex-display"><span class="katex"><math><semantics><mrow></mrow>'
    + '<annotation encoding="application/x-tex">\\int_0^1 x\\,dx</annotation></semantics></math></span></span>';
  await paste(page, {
    'text/html': `<h2>Title</h2><ul><li>one</li></ul><p>Mass is <span data-math="E=mc^2">$$E=mc^2$$</span>.</p>${display}`,
    'text/plain': '## Title\n\n- one\n\nMass is $$E=mc^2$$.\n\n$$\n\\int_0^1 x\\,dx\n$$',
  });
  await expect.poll(() => lines(page)).toEqual(
    expect.arrayContaining([
      'heading:Title',
      'bulletListItem:one',
      'paragraph:Mass is [math:E=mc^2].',
      'mathBlock:\\int_0^1 x\\,dx',
    ]),
  );
});

test('a drag across a rendered formula copies its source', async () => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openFreshDocument(page);
  await page.keyboard.type('start $$x^2$$ end');
  await expect.poll(() => lines(page)).toEqual(['paragraph:start [math:x^2] end']);

  const start = await page.locator(`${EDITOR} p`).first().boundingBox();
  const formula = await page.locator(`${EDITOR} p .katex`).first().boundingBox();
  await page.mouse.move(start!.x + 1, start!.y + start!.height / 2);
  await page.mouse.down();
  await page.mouse.move(formula!.x + formula!.width + 4, formula!.y + formula!.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('$$x^2$$');
});

test('select-all with a formula first asks before Backspace clears the body', async () => {
  await openFreshDocument(page);
  await paste(page, { 'text/plain': '$$\na\n$$\n\nwords' });
  await expect.poll(() => lines(page)).toEqual(['mathBlock:a', 'paragraph:words']);
  await page.locator(`${EDITOR} p`).first().click();

  // The first press takes the line, the second the whole body.
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');

  await expect(page.getByTestId('document-clear-confirm')).toBeVisible();
  expect((await lines(page))[0]).toBe('mathBlock:a');
});

test('two pages on one Space see each other change a formula', async ({ browser }) => {
  await openFreshDocument(page);
  const home = (await page.locator('[role="tab"][aria-selected="true"]').getAttribute('data-testid'))!;
  await insertFromPlus(page);
  await page.keyboard.type('a');
  await page.keyboard.press('Enter');

  const second = await browser.newContext({ viewport: { width: 1680, height: 950 } });
  const peer = await second.newPage();
  try {
    await peer.goto(page.url());
    await peer.getByTestId(home).click();
    await expect.poll(() => lines(peer), { timeout: 20_000 }).toContain('mathBlock:a');

    await openFirst(peer);
    await peer.keyboard.type('b');
    await expect.poll(() => lines(page), { timeout: 20_000 }).toContain('mathBlock:ab');
    await expect(page.locator(`${EDITOR} .katex-display annotation`)).toHaveText('ab');
  } finally {
    await second.close();
  }
});

test('the snapshot comparison marks a changed formula, and restoring brings the old one back', async () => {
  await openFreshDocument(page);
  await insertFromPlus(page);
  await page.keyboard.type('a+b');
  await page.keyboard.press('Enter');

  await page.getByTestId('doc-doc-menu-trigger').click();
  await page.getByTestId('doc-doc-menu-save-snapshot').click();
  await page.getByTestId('doc-snapshot-name-input').fill('Before');
  await page.getByTestId('doc-snapshot-name-submit').click();
  await expect(page.getByTestId('doc-snapshot-name-dialog')).toHaveCount(0, { timeout: 15_000 });

  await openFirst(page);
  await page.keyboard.press('Backspace');
  await page.keyboard.type('c');
  await page.keyboard.press('Enter');
  await expect.poll(() => lines(page)).toContain('mathBlock:a+c');

  await page.getByTestId('doc-doc-menu-trigger').click();
  await page.getByTestId('doc-doc-menu-restore-snapshot').click();
  await expect(page.getByTestId('doc-version-panel')).toBeVisible({ timeout: 15_000 });
  const row = page.locator('[data-testid^="doc-version-row-"]:not([data-testid="doc-version-row-current"])').first();
  await expect(row).toContainText('Before', { timeout: 15_000 });
  await row.click();
  await page.getByTestId('doc-version-compare-current').click();
  const preview = page.getByTestId('doc-version-preview-body');
  await expect(preview.locator('[class*="doc-version-format"] .doc-math')).toHaveCount(1, { timeout: 15_000 });
  await expect(preview.locator('.katex-display annotation')).toHaveText('a+c');

  await page.getByTestId('doc-version-exit-compare').click();
  await row.click();
  await page.getByTestId('doc-version-restore').click();
  await page.getByTestId('doc-version-restore-confirm').click();
  await expect(page.getByTestId('doc-version-panel')).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => lines(page)).toContain('mathBlock:a+b');
});

test('the snapshot comparison shows an added inline formula as added, not as changed', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('area');
  await page.getByTestId('doc-doc-menu-trigger').click();
  await page.getByTestId('doc-doc-menu-save-snapshot').click();
  await page.getByTestId('doc-snapshot-name-input').fill('Before');
  await page.getByTestId('doc-snapshot-name-submit').click();
  await expect(page.getByTestId('doc-snapshot-name-dialog')).toHaveCount(0, { timeout: 15_000 });

  await caretAtEndOfFirstLine(page);
  await page.keyboard.type(' $$x^2$$');
  await expect.poll(() => lines(page)).toEqual(['paragraph:area [math:x^2]']);

  await page.getByTestId('doc-doc-menu-trigger').click();
  await page.getByTestId('doc-doc-menu-restore-snapshot').click();
  const row = page.locator('[data-testid^="doc-version-row-"]:not([data-testid="doc-version-row-current"])').first();
  await expect(row).toContainText('Before', { timeout: 15_000 });
  await row.click();
  await page.getByTestId('doc-version-compare-current').click();
  const preview = page.getByTestId('doc-version-preview-body');
  const formula = preview.locator('.doc-version-insert .doc-math');
  await expect(formula).toHaveCount(1, { timeout: 15_000 });
  const backgrounds = await formula.evaluate((element) => {
    const out: string[] = [];
    for (let at: Element | null = element; at !== null && !at.classList.contains('ProseMirror'); at = at.parentElement) {
      if ([...at.classList].some((name) => name.startsWith('doc-version-'))) {
        out.push(`${[...at.classList].filter((name) => name.startsWith('doc-version-')).join(' ')}=${getComputedStyle(at).backgroundColor}`);
      }
    }
    return out;
  });
  expect(backgrounds.filter((entry) => entry.startsWith('doc-version-format') && !entry.endsWith('rgba(0, 0, 0, 0)'))).toEqual([]);
  await page.getByTestId('doc-version-close').click();
});

for (const theme of ['light', 'dark'] as const) {
  test(`the box takes the overlay corner and surface tokens (${theme})`, async () => {
    await openFreshDocument(page);
    await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
    await insertFromPlus(page);
    const measured = await page.evaluate((box) => {
      const element = document.querySelector(box)!;
      const probe = document.createElement('div');
      probe.style.borderRadius = 'var(--radius-overlay)';
      probe.style.backgroundColor = 'var(--color-popover)';
      document.body.appendChild(probe);
      const want = getComputedStyle(probe);
      const got = getComputedStyle(element);
      const result = {
        radius: [got.borderTopLeftRadius, want.borderTopLeftRadius],
        surface: [got.backgroundColor, want.backgroundColor],
      };
      probe.remove();
      return result;
    }, BOX);
    expect(measured.radius[0]).toBe(measured.radius[1]);
    expect(measured.surface[0]).toBe(measured.surface[1]);
    await expect(page.locator(BOX).getByRole('button', { name: 'OK', exact: true })).toBeVisible();
  });
}

test('clicking a formula puts the caret at the end of its source', async () => {
  await openFreshDocument(page);
  await insertFromPlus(page);
  await page.keyboard.type('pq');
  await page.keyboard.press('Enter');
  await openFirst(page);
  expect(await caretInField(page)).toEqual({ at: 2, length: 2 });
  await page.keyboard.type('r');
  await expect.poll(async () => (await lines(page))[0]).toBe('mathBlock:pqr');
});
