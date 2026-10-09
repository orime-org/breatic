// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The body's focus end to end (inner#1127 A20, A21).
 *
 * What jsdom cannot show: a real press on the blank space beside the body
 * column, where the browser's focus then is, the native selection highlight
 * going with it, and the keys the page sends while the body is let go.
 *
 * Wants dev running:
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { pressAndSettle } from '../helpers/editor-keys';
import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, DOCUMENT_EDITOR as EDITOR, VISIBLE_SPACE } from '../helpers/space';

const SCROLLER = `${VISIBLE_SPACE} [data-testid="document-space"] [data-radix-scroll-area-viewport][data-document-body-blank]`;
const BUBBLE_BAR = '[data-testid="doc-selection-bubble-bar"]';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

let page: Page;
const createdSpaceIds: string[] = [];

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
});

test.afterEach(async () => {
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
  await page?.close();
});

/**
 * Opens a fresh Document Space holding one line of text, the body holding.
 * @param p - The page.
 */
async function openWithLine(p: Page): Promise<void> {
  await openSmokeProject(p);
  createdSpaceIds.push(await createSpace(p, 'document', `body-focus-${Date.now()}`));
  const editor = p.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await p.keyboard.type('hello world');
  await expect(editor).toHaveAttribute('data-body-holds', /.*/);
}

/** Where beside the body column a blank point is taken. */
type BlankSide = 'left' | 'right' | 'rail';

/**
 * A point on the blank space beside the body column, checked to be blank.
 * @param p - The page.
 * @param side - Left or right of the column, or between it and the open comment rail.
 * @returns The point.
 */
async function blankPoint(p: Page, side: BlankSide = 'left'): Promise<{ x: number; y: number }> {
  const point = await p.evaluate(
    ([selector, where]) => {
      const editor = document.querySelector(selector)!.getBoundingClientRect();
      const line = document.querySelector(`${selector} p`)!.getBoundingClientRect();
      const rail = document.querySelector('[data-testid="doc-comment-rail"]')?.getBoundingClientRect();
      const x =
        where === 'left' ? editor.left - 40 : where === 'right' ? editor.right + 40 : (editor.right + rail!.left) / 2;
      return { x, y: line.top + line.height / 2 };
    },
    [EDITOR, side] as const,
  );
  const blank = await p.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.hasAttribute('data-document-body-blank') ?? false,
    point,
  );
  expect(blank).toBe(true);
  return point;
}

/**
 * Selects the word "hello" on the first line, from the caret the typing left
 * at its end.
 * @param p - The page.
 */
async function selectHello(p: Page): Promise<void> {
  await pressAndSettle(p, process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home');
  for (let i = 0; i < 5; i += 1) await pressAndSettle(p, 'Shift+ArrowRight');
  await expect(p.locator(BUBBLE_BAR)).toBeVisible();
}

for (const side of ['left', 'right', 'rail'] as const) {
  test(`a press on blank space ${side === 'rail' ? 'between the column and the comment rail' : `${side} of the column`} lets the body go and leaves the focus on the body scroller (A20)`, async () => {
    await openWithLine(page);
    if (side === 'rail') {
      await page.getByTestId('doc-doc-menu-trigger').click();
      await page.getByTestId('doc-doc-menu-comments').click();
      await expect(page.getByTestId('doc-comment-rail')).toBeVisible();
      await page.locator(`${EDITOR} p`).first().click();
    }
    await selectHello(page);
    const { x, y } = await blankPoint(page, side);

    await page.mouse.click(x, y);

    const editor = page.locator(EDITOR);
    await expect(editor).not.toHaveAttribute('data-body-holds', /.*/);
    await expect(page.locator(BUBBLE_BAR)).toHaveCount(0);
    await expect(page.locator(SCROLLER)).toBeFocused();
    expect(await page.locator(SCROLLER).evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');
    // The selection is kept, only not drawn: a press back in the text takes it.
    await editor.click();
    await expect(editor).toHaveAttribute('data-body-holds', /.*/);
  });
}

test('cut and paste do nothing while the body is let go, and undo still reaches the document', async () => {
  await openWithLine(page);
  await selectHello(page);
  const { x, y } = await blankPoint(page);
  await page.mouse.click(x, y);
  const editor = page.locator(EDITOR);

  await page.keyboard.press(`${MOD}+x`);
  await page.keyboard.press(`${MOD}+v`);
  await expect(editor).toHaveText('hello world');

  await page.keyboard.press(`${MOD}+z`);
  await expect(editor).not.toHaveText('hello world');
  await expect(editor).not.toHaveAttribute('data-body-holds', /.*/);
});

test('a drag that starts on blank space selects from the press point and takes the body back', async () => {
  await openWithLine(page);
  const { x, y } = await blankPoint(page);
  await page.mouse.click(x, y);
  const end = await page.evaluate((selector) => {
    const line = document.querySelector(`${selector} p`)!.getBoundingClientRect();
    return { x: line.left + 40, y: line.top + line.height / 2 };
  }, EDITOR);

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();

  await expect(page.locator(EDITOR)).toHaveAttribute('data-body-holds', /.*/);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).not.toBe('');
});

test('Tab back into the body after the caption field keeps the scroll position and the selected picture', async () => {
  await openWithLine(page);
  for (let i = 0; i < 30; i += 1) await page.keyboard.type(`\nline ${String(i)}`);
  const png = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 220;
    canvas.height = 120;
    canvas.getContext('2d')!.fillRect(0, 0, 220, 120);
    const blob = await new Promise<Blob>((done) => {
      canvas.toBlob((b) => done(b!), 'image/png');
    });
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  await page.locator(EDITOR).evaluate((element, bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], 'tab.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, png);
  const picture = page.locator(`${EDITOR} [data-content-type="image"]`);
  await expect(picture.locator('img')).toBeVisible({ timeout: 60_000 });
  const knob = picture.locator('[data-testid="doc-media-resize-se"]');
  await picture.locator('img').click();
  await expect(knob).toBeVisible();
  await picture.getByTestId('doc-media-caption-button').click();
  await page.keyboard.type('Dusk');
  const beside = await picture.evaluate((row, selector) => {
    const editor = document.querySelector(selector)!.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    return { x: editor.left - 40, y: box.top + box.height / 2 };
  }, EDITOR);
  expect(
    await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.hasAttribute('data-document-body-blank'), beside),
  ).toBe(true);
  await page.mouse.click(beside.x, beside.y);
  await expect(page.locator(SCROLLER)).toBeFocused();
  const before = await page.locator(SCROLLER).evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(0);

  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab');
    if (await page.locator(EDITOR).evaluate((el) => el === document.activeElement)) break;
  }

  await expect(page.locator(EDITOR)).toBeFocused();
  expect(await page.locator(SCROLLER).evaluate((el) => el.scrollTop)).toBe(before);
  await expect(knob).toBeVisible();
});

test('a body let go draws neither its text selection nor its selected cells (A20, A21)', async () => {
  await openWithLine(page);
  await selectHello(page);
  const editor = page.locator(EDITOR);
  const textHighlight = (): Promise<string> =>
    page.locator(`${EDITOR} p`).first().evaluate((el) => getComputedStyle(el, '::selection').backgroundColor);
  expect(await textHighlight()).not.toBe('rgba(0, 0, 0, 0)');

  const { x, y } = await blankPoint(page);
  await page.mouse.click(x, y);
  await expect(editor).not.toHaveAttribute('data-body-holds', /.*/);
  expect(await textHighlight()).toBe('rgba(0, 0, 0, 0)');

  // A 2x2 table below the line, its four cells selected by a drag.
  await editor.click();
  await page.mouse.move(5, 5);
  const row = (await page.locator(`${EDITOR} .bn-block-content`).first().boundingBox())!;
  await page.mouse.move(row.x + 40, row.y + 12, { steps: 3 });
  await page.getByTestId('doc-block-handle').click();
  await page.getByTestId('doc-block-row-insertBelow').hover();
  await page.getByTestId('doc-block-insert-table').hover();
  await page.getByTestId('doc-table-size-2-2').click();
  const first = (await page.locator(`${EDITOR} td`).first().boundingBox())!;
  const last = (await page.locator(`${EDITOR} td`).last().boundingBox())!;
  await page.mouse.move(first.x + 10, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width - 10, last.y + last.height / 2, { steps: 6 });
  await page.mouse.up();
  const cell = page.locator(`${EDITOR} .selectedCell`).first();
  await expect(cell).toBeVisible();
  const tint = (): Promise<string> => cell.evaluate((el) => getComputedStyle(el, '::after').content);
  expect(await tint()).not.toBe('none');

  await page.mouse.click(x, y);
  await expect(editor).not.toHaveAttribute('data-body-holds', /.*/);
  expect(await tint()).toBe('none');
});

test('Cmd/Ctrl+click on a divider selects it whole, the body holding or not (A22)', async () => {
  await openWithLine(page);
  const editor = page.locator(EDITOR);
  await page.keyboard.press('Enter');
  await page.keyboard.type('---');
  const divider = page.locator(`${EDITOR} [data-content-type="divider"]`);
  await expect(divider).toHaveCount(1);
  const selected = (): Promise<{ kind: string; painted: number }> =>
    page.evaluate((selector) => {
      const el = document.querySelector(selector) as unknown as {
        editor: { state: { selection: { constructor: { name: string }; node?: { type: { name: string } } } } };
      };
      const { selection } = el.editor.state;
      return {
        kind: `${selection.constructor.name}:${selection.node?.type.name ?? ''}`,
        painted: document.querySelectorAll(`${selector} [data-content-type="divider"].doc-in-selection, ${selector} .doc-in-selection [data-content-type="divider"]`).length,
      };
    }, EDITOR);

  await divider.click({ modifiers: [MOD] });
  await expect.poll(selected).toEqual({ kind: '_NodeSelection:divider', painted: 1 });

  const { x, y } = await blankPoint(page);
  await page.mouse.click(x, y);
  await expect(editor).not.toHaveAttribute('data-body-holds', /.*/);
  await divider.click({ modifiers: [MOD] });
  await expect.poll(selected).toEqual({ kind: '_NodeSelection:divider', painted: 1 });
});

test('Shift+click on a divider while the body is let go selects the divider and leaves the old words out (A20)', async () => {
  await openWithLine(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('---');
  const divider = page.locator(`${EDITOR} [data-content-type="divider"]`);
  await expect(divider).toHaveCount(1);
  await page.locator(`${EDITOR} p`).first().click();
  await selectHello(page);
  const { x, y } = await blankPoint(page);
  await page.mouse.click(x, y);
  await expect(page.locator(EDITOR)).not.toHaveAttribute('data-body-holds', /.*/);

  await divider.click({ modifiers: ['Shift'] });

  await expect
    .poll(() =>
      page.evaluate((selector) => {
        const el = document.querySelector(selector) as unknown as {
          editor: { state: { selection: { constructor: { name: string }; node?: { type: { name: string } } } } };
        };
        const { selection } = el.editor.state;
        return `${selection.constructor.name}:${selection.node?.type.name ?? ''}|${window.getSelection()?.toString() ?? ''}`;
      }, EDITOR),
    )
    .toBe('_NodeSelection:divider|');
});

/**
 * Inserts a 2x2 table under the first row through its handle menu.
 * @param p - The page.
 */
async function insertTable(p: Page): Promise<void> {
  await p.mouse.move(5, 5);
  const row = (await p.locator(`${EDITOR} .bn-block-content`).first().boundingBox())!;
  await p.mouse.move(row.x + 40, row.y + 12, { steps: 3 });
  await p.getByTestId('doc-block-handle').click();
  await p.getByTestId('doc-block-row-insertBelow').hover();
  await p.getByTestId('doc-block-insert-table').hover();
  await p.getByTestId('doc-table-size-2-2').click();
  await expect(p.locator(`${EDITOR} table`)).toHaveCount(1);
}

/**
 * Drag-selects the four cells of the table.
 * @param p - The page.
 */
async function selectCells(p: Page): Promise<void> {
  const first = (await p.locator(`${EDITOR} td`).first().boundingBox())!;
  const last = (await p.locator(`${EDITOR} td`).last().boundingBox())!;
  await p.mouse.move(first.x + 10, first.y + first.height / 2);
  await p.mouse.down();
  await p.mouse.move(last.x + last.width - 10, last.y + last.height / 2, { steps: 6 });
  await p.mouse.up();
  await expect(p.locator(`${EDITOR} .selectedCell`).first()).toBeVisible();
}

/**
 * The editor's selection, as JSON text.
 * @param p - The page.
 * @returns It.
 */
async function selectionOf(p: Page): Promise<string> {
  return p.evaluate(
    (selector) =>
      JSON.stringify(
        (document.querySelector(selector) as unknown as {
          editor: { state: { selection: { toJSON: () => unknown } } };
        }).editor.state.selection.toJSON(),
      ),
    EDITOR,
  );
}

test('a selected divider is drawn as not selected once the body is let go (A20, A21)', async () => {
  await openWithLine(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('---');
  const divider = page.locator(`${EDITOR} [data-content-type="divider"]`);
  await divider.click();
  const painted = (): Promise<number> =>
    page.evaluate((selector) => document.querySelectorAll(`${selector} .doc-in-selection`).length, EDITOR);
  await expect.poll(painted).toBe(1);

  const { x, y } = await blankPoint(page);
  await page.mouse.click(x, y);

  await expect(page.locator(EDITOR)).not.toHaveAttribute('data-body-holds', /.*/);
  await expect.poll(painted).toBe(0);
});

test('after a drag selection and a press on blank space, hovering a row shows its handle (A20)', async () => {
  await openWithLine(page);
  const line = (await page.locator(`${EDITOR} p`).first().boundingBox())!;
  await page.mouse.move(line.x + 2, line.y + line.height / 2);
  await page.mouse.down();
  await page.mouse.move(line.x + 60, line.y + line.height / 2, { steps: 5 });
  await page.mouse.up();
  const { x, y } = await blankPoint(page);
  await page.mouse.click(x, y);

  await page.mouse.move(line.x + 40, line.y + line.height / 2, { steps: 3 });

  await expect(page.getByTestId('doc-block-handle')).toBeVisible();
});

test('a right press or a Ctrl press on blank space, then Escape, leaves no caret and no drag selection (A20)', async () => {
  await openWithLine(page);
  const before = await selectionOf(page);
  const { x, y } = await blankPoint(page);
  const line = (await page.locator(`${EDITOR} p`).first().boundingBox())!;

  for (const press of ['right', 'control'] as const) {
    if (press === 'right') await page.mouse.click(x, y, { button: 'right' });
    else {
      await page.keyboard.down('Control');
      await page.mouse.click(x, y);
      await page.keyboard.up('Control');
    }
    await page.keyboard.press('Escape');
    await expect(page.locator(EDITOR)).not.toHaveAttribute('data-body-holds', /.*/);
    await page.mouse.move(line.x + 60, line.y + line.height / 2, { steps: 5 });
    expect(await selectionOf(page)).toBe(before);
    await expect(page.locator(BUBBLE_BAR)).toHaveCount(0);
  }
});

test('while let go, typing changes nothing and PageDown and Space scroll the body (A20)', async () => {
  await openWithLine(page);
  for (let i = 0; i < 80; i += 1) await page.keyboard.type(`\nline ${String(i)}`);
  await pressAndSettle(page, process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
  for (let i = 0; i < 5; i += 1) await pressAndSettle(page, 'Shift+ArrowRight');
  await expect(page.locator(BUBBLE_BAR)).toBeVisible();
  expect(await page.locator(SCROLLER).evaluate((el) => el.scrollTop)).toBe(0);
  const text = await page.locator(EDITOR).innerText();
  const beside = await page.evaluate((selector) => {
    const editor = document.querySelector(selector)!.getBoundingClientRect();
    const row = [...document.querySelectorAll(`${selector} p`)]
      .map((p) => p.getBoundingClientRect())
      .find((box) => box.top > window.innerHeight / 3 && box.bottom < (window.innerHeight * 2) / 3)!;
    return { x: editor.left - 40, y: row.top + row.height / 2 };
  }, EDITOR);
  expect(
    await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.hasAttribute('data-document-body-blank'), beside),
  ).toBe(true);
  await page.mouse.click(beside.x, beside.y);
  const scroller = page.locator(SCROLLER);
  await expect(scroller).toBeFocused();

  await page.keyboard.type('abc');
  expect(await page.locator(EDITOR).innerText()).toBe(text);
  await expect(scroller).toBeFocused();
  expect(await scroller.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');

  const top = (): Promise<number> => scroller.evaluate((el) => el.scrollTop);
  const start = await top();
  await page.keyboard.press('PageDown');
  await expect.poll(top).toBeGreaterThan(start);
  const afterPage = await top();
  await page.keyboard.press('Space');
  await expect.poll(top).toBeGreaterThan(afterPage);
  await expect(page.locator(EDITOR)).not.toHaveAttribute('data-body-holds', /.*/);
});

test('copy while let go leaves the clipboard as it was (A20)', async () => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openWithLine(page);
  await selectHello(page);
  await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
  const { x, y } = await blankPoint(page);
  await page.mouse.click(x, y);

  await page.keyboard.press(`${MOD}+c`);

  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('sentinel');
  await expect(page.locator(EDITOR)).toHaveText('hello world');
});

test('a press inside the old selection after letting go starts a new drag selection (A20)', async () => {
  await openWithLine(page);
  await selectHello(page);
  const { x, y } = await blankPoint(page);
  await page.mouse.click(x, y);
  const line = (await page.locator(`${EDITOR} p`).first().boundingBox())!;

  await page.mouse.move(line.x + 18, line.y + line.height / 2);
  await page.mouse.down();
  await page.mouse.move(line.x + line.width - 4, line.y + line.height / 2, { steps: 6 });
  await page.mouse.up();

  await expect(page.locator(EDITOR)).toHaveText('hello world');
  const selection = JSON.parse(await selectionOf(page)) as { anchor: number; head: number };
  expect(selection.anchor).toBeGreaterThan(1);
  expect(selection.head).toBeGreaterThan(selection.anchor);
});

test('after selected cells and a press on blank space, hovering the table shows its row and column handles (A21)', async () => {
  await openWithLine(page);
  await insertTable(page);
  await selectCells(page);
  const { x, y } = await blankPoint(page);
  await page.mouse.click(x, y);

  const cell = (await page.locator(`${EDITOR} td`).first().boundingBox())!;
  await page.mouse.move(cell.x + cell.width / 2, cell.y + cell.height / 2, { steps: 4 });

  await expect(page.getByTestId('doc-table-row-handle').first()).toBeVisible();
  await expect(page.getByTestId('doc-table-col-handle').first()).toBeVisible();
});
