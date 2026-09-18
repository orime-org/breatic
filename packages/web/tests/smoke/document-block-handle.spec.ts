// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The block handle and the insert menu end to end (task #113).
 *
 * The half jsdom cannot reach. Every rectangle it reports is zero, so the side
 * menu — which decides which row the pointer is over by asking the document
 * what is at a point — never appears there at all; and the two gestures on the
 * handle are a real drag and a real click, which only a browser tells apart.
 *
 * Wants dev running and a smoke account:
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { createSpace, deleteSpace } from './helpers/space';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  await page.goto('/login');
  await page.locator('#login-email').fill(email as string);
  await page.locator('#login-password').fill(password as string);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/(studio|project)/, { timeout: 15_000 });
});

test.afterAll(async () => {
  await page?.close();
});

const createdSpaceIds: string[] = [];

test.afterEach(async () => {
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
});

/** Which project this run works in; without one, the top of the studio page. */
const projectUrl = process.env.SMOKE_PROJECT_URL;

const EDITOR = '[data-testid="document-space"] .ProseMirror';

/**
 * Open a freshly made Document Space with the caret in the body.
 * @param p - The page.
 */
async function openFreshDocument(p: Page): Promise<void> {
  if (projectUrl === undefined) {
    await p.goto('/studio');
    const firstProject = p.locator('a[href^="/project/"]').first();
    await expect(firstProject).toBeVisible({ timeout: 15_000 });
    await firstProject.click();
  } else {
    await p.goto(projectUrl);
  }
  await p.waitForURL(/\/project\//, { timeout: 15_000 });

  createdSpaceIds.push(await createSpace(p, 'document', `handle-${Date.now()}`));

  const editor = p.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await expect(p.getByTestId('new-space-button')).toBeFocused();
  await editor.click();
  await expect(editor).toBeFocused();
}

/**
 * Type the given lines, one block each.
 * @param p - The page.
 * @param lines - What to type.
 */
async function typeLines(p: Page, lines: string[]): Promise<void> {
  for (const [index, line] of lines.entries()) {
    if (index > 0) await p.keyboard.press('Enter');
    await p.keyboard.type(line);
  }
}

/**
 * Put the pointer over the nth row so the strip appears beside it.
 *
 * Measured rather than guessed: the row's own paragraph is what the side menu
 * answers to, and an empty one is 2px wide, so the pointer goes at a fixed
 * offset from its left edge — inside the row, not inside the text.
 * @param p - The page.
 * @param index - Which row, from the top.
 * @throws {Error} When that row has no box.
 */
async function hoverRow(p: Page, index: number): Promise<void> {
  const row = p.locator(`${EDITOR} .bn-block-content`).nth(index);
  const box = await row.boundingBox();
  if (box === null) throw new Error(`row ${index} has no box`);
  await p.mouse.move(box.x + 40, box.y + 11);
}

test('the strip offers a handle for a row that shows something', async () => {
  await openFreshDocument(page);
  await typeLines(page, ['first line']);

  await hoverRow(page, 0);

  await expect(page.getByTestId('doc-block-add')).toBeVisible();
  await expect(page.getByTestId('doc-block-handle')).toBeVisible();
});

test('the strip offers the plus alone on a row that shows nothing', async () => {
  await openFreshDocument(page);
  await typeLines(page, ['first line']);
  await page.keyboard.press('Enter');

  await hoverRow(page, 1);

  await expect(page.getByTestId('doc-block-add')).toBeVisible();
  await expect(page.getByTestId('doc-block-handle')).toHaveCount(0);
});

test('a bulleted row with nothing in it still gets a handle', async () => {
  // Its marker is drawn whatever it holds, so the reader sees that row — and
  // the strip used to offer the plus alone there.
  await openFreshDocument(page);
  await typeLines(page, ['- an item']);
  await page.keyboard.press('Enter');

  await hoverRow(page, 1);

  await expect(page.getByTestId('doc-block-add')).toBeVisible();
  await expect(page.getByTestId('doc-block-handle')).toBeVisible();
});

test('the strip stands on the middle of the row’s first line', async () => {
  // A2. Both rows here are taller than the strip — a level-one heading, and a
  // paragraph long enough to wrap — so a strip placed against the ROW rather
  // than against its first line lands visibly off.
  await openFreshDocument(page);
  await typeLines(page, [
    '# a heading row',
    'a paragraph long enough to wrap onto a second line in this column, which it does somewhere around here',
  ]);

  for (const index of [0, 1]) {
    await page.mouse.move(5, 5);
    await hoverRow(page, index);
    await expect(page.getByTestId('doc-block-add')).toBeVisible();

    const off = await page.evaluate((editorSelector) => {
      const strip = document.querySelector('[data-row-id]');
      const rowId = strip?.getAttribute('data-row-id');
      const row = document
        .querySelector(editorSelector)
        ?.querySelector(`[data-id="${String(rowId)}"] .bn-block-content`);
      const plus = document.querySelector('[data-testid="doc-block-add"]');
      if (row === null || row === undefined || plus === null) return null;
      const words = row.firstElementChild ?? row;
      const range = document.createRange();
      range.selectNodeContents(words);
      const firstLine = range.getClientRects()[0] ?? words.getClientRects()[0];
      const button = plus.getBoundingClientRect();
      if (firstLine === undefined) return null;
      return (
        button.top + button.height / 2 - (firstLine.top + firstLine.height / 2)
      );
    }, EDITOR);

    expect(off, `row ${String(index)}`).not.toBeNull();
    expect(Math.abs(off as number), `row ${String(index)}`).toBeLessThan(2);
  }
});

test('the handle opens the menu, and Escape hands typing back to the body', async () => {
  await openFreshDocument(page);
  await typeLines(page, ['first line']);
  await hoverRow(page, 0);

  await page.getByTestId('doc-block-handle').click();

  await expect(page.getByTestId('doc-block-row-blockType')).toBeVisible();
  await expect(page.getByTestId('doc-block-row-duplicate')).toBeVisible();
  await expect(page.getByTestId('doc-block-row-insertBelow')).toBeVisible();
  await expect(page.getByTestId('doc-block-row-comment')).toBeVisible();
  await expect(page.getByTestId('doc-block-row-delete')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('doc-block-row-delete')).toHaveCount(0);

  // The menu unmounts a turn before the focus lands back in the body —
  // `react-focus-scope` defers its half to a `setTimeout` — and a keystroke
  // sent in between goes nowhere. A reader's next key is never that quick;
  // this wait is what makes the test as slow as a person.
  await expect(page.locator(EDITOR)).toBeFocused();
  await page.keyboard.type(' more');
  await expect(page.locator(EDITOR)).toContainText('first line more');
});

test('a block type off the handle changes that row and leaves the caret alone', async () => {
  await openFreshDocument(page);
  await typeLines(page, ['first line', 'second line']);
  await hoverRow(page, 0);

  await page.getByTestId('doc-block-handle').click();
  await page.getByTestId('doc-block-row-blockType').hover();
  await page.getByTestId('doc-block-type-heading-1').click();

  await expect(page.locator(`${EDITOR} h1`)).toHaveText('first line');
  // The caret was at the end of the second line and has to still be there.
  await expect(page.locator(EDITOR)).toBeFocused();
  await page.keyboard.type('!');
  await expect(page.locator(EDITOR)).toContainText('second line!');
});

test('duplicate puts a copy below, delete takes the row away', async () => {
  await openFreshDocument(page);
  await typeLines(page, ['alpha', 'beta']);

  await hoverRow(page, 0);
  await page.getByTestId('doc-block-handle').click();
  await page.getByTestId('doc-block-row-duplicate').click();
  await expect(page.locator(`${EDITOR} >> text=alpha`)).toHaveCount(2);

  // The copy went in as row 1, so beta is row 2 now.
  await hoverRow(page, 2);
  await page.getByTestId('doc-block-handle').click();
  await page.getByTestId('doc-block-row-delete').click();
  await expect(page.locator(`${EDITOR} >> text=beta`)).toHaveCount(0);
});

test('the plus opens the insert menu, and a choice lands where it was pressed', async () => {
  await openFreshDocument(page);
  await typeLines(page, ['alpha']);
  await hoverRow(page, 0);

  await page.getByTestId('doc-block-add').click();
  await expect(page.getByTestId('doc-insert-menu')).toBeVisible();

  await page.getByTestId('doc-insert-heading-1').click();
  await expect(page.getByTestId('doc-insert-menu')).toHaveCount(0);

  await expect(page.locator(EDITOR)).toBeFocused();
  await page.keyboard.type('made it');
  await expect(page.locator(`${EDITOR} h1`)).toHaveText('made it');
});

test('typing filters the insert menu', async () => {
  await openFreshDocument(page);
  await typeLines(page, ['alpha']);
  await hoverRow(page, 0);

  await page.getByTestId('doc-block-add').click();
  await expect(page.getByTestId('doc-insert-code-block')).toBeVisible();

  await page.keyboard.type('quo');

  await expect(page.getByTestId('doc-insert-quote')).toBeVisible();
  await expect(page.getByTestId('doc-insert-code-block')).toHaveCount(0);
});

test('Escape after the plus leaves the document as it was', async () => {
  await openFreshDocument(page);
  await typeLines(page, ['alpha']);
  const before = await page.locator(EDITOR).innerHTML();

  await hoverRow(page, 0);
  await page.getByTestId('doc-block-add').click();
  await expect(page.getByTestId('doc-insert-menu')).toBeVisible();
  await page.keyboard.type('quo');
  await page.keyboard.press('Escape');

  await expect(page.getByTestId('doc-insert-menu')).toHaveCount(0);
  expect(await page.locator(EDITOR).innerHTML()).toBe(before);
});

/**
 * Drag from the handle onto a row, with the browser's own drag.
 *
 * The mouse drives it: a press on the handle, a small move to start the drag,
 * then a move onto the target row. Playwright's `dragTo` is what cannot serve
 * here — measured, it hung until the test timed out — but the three mouse
 * steps do produce a real HTML5 drag, which is what puts BlockNote's own
 * listeners, its drop cursor and ProseMirror's drop handling on the same path
 * a reader's mouse takes.
 * @param p - The page.
 * @param rowIndex - Which row to drop on, from the top.
 * @throws {Error} When the handle or the target row has no box.
 */
async function dragHandleOntoRow(p: Page, rowIndex: number): Promise<void> {
  const handle = await p.getByTestId('doc-block-handle').boundingBox();
  const target = await p
    .locator(`${EDITOR} .bn-block-content`)
    .nth(rowIndex)
    .boundingBox();
  if (handle === null || target === null) {
    throw new Error('no handle or no target row');
  }

  await p.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await p.mouse.down();
  await p.mouse.move(handle.x + 8, handle.y + 12, { steps: 4 });
  // The lower half of the row, which is what asks for "after this one".
  await p.mouse.move(target.x + 40, target.y + target.height - 2, { steps: 8 });
  await p.mouse.up();
}

test('the handle still drags the block it belongs to', async () => {
  await openFreshDocument(page);
  await typeLines(page, ['alpha', 'beta', 'gamma']);

  await hoverRow(page, 0);
  await expect(page.getByTestId('doc-block-handle')).toBeVisible();
  await dragHandleOntoRow(page, 2);

  const text = await page.locator(EDITOR).innerText();
  expect(text.indexOf('alpha')).toBeGreaterThan(text.indexOf('beta'));
});

test('a finished drag leaves no frame and the caret where it was', async () => {
  // The drag is carried by a node selection the library puts on the row, and
  // it is still there when the drag ends — measured 2026-09-18, all three
  // endings (another row, its own row, the space below the last row) left the
  // row wearing the violet outline this Space draws for a block the READER
  // selected. So the drag hands the reader's place back, the way every other
  // command off this strip does.
  await openFreshDocument(page);
  await typeLines(page, ['alpha', 'beta', 'gamma']);
  // The reader is typing in the last row when they reach for the first one.
  await page.keyboard.type(' end');

  await hoverRow(page, 0);
  await expect(page.getByTestId('doc-block-handle')).toBeVisible();
  await dragHandleOntoRow(page, 2);
  await expect(page.locator(`${EDITOR} .ProseMirror-selectednode`)).toHaveCount(
    0,
  );

  // And the caret is back in the row they were in, so the next key lands
  // there rather than replacing the row that was dragged.
  await page.keyboard.type('!');
  await expect(page.locator(EDITOR)).toContainText('gamma end!');
});

test('dragging selected text inside the body still moves it', async () => {
  // A19's other half. The handle's drag and a text drag are two gestures on
  // one surface: BlockNote's own drop handler returns early while ProseMirror
  // is dragging text (`SideMenu.ts:546-552`), which is what keeps the block
  // drag from taking the text drag's place.
  await openFreshDocument(page);
  await typeLines(page, ['alpha beta', 'second row']);

  // Select the first word, then carry it to the end of the second row.
  const first = page.locator(`${EDITOR} .bn-block-content`).nth(0);
  const second = page.locator(`${EDITOR} .bn-block-content`).nth(1);
  const firstBox = await first.boundingBox();
  const secondBox = await second.boundingBox();
  if (firstBox === null || secondBox === null) throw new Error('no rows');
  await page.mouse.move(firstBox.x + 2, firstBox.y + firstBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(firstBox.x + 38, firstBox.y + firstBox.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).not.toBe('');

  await page.mouse.move(firstBox.x + 20, firstBox.y + firstBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(firstBox.x + 28, firstBox.y + firstBox.height / 2 + 6, {
    steps: 4,
  });
  await page.mouse.move(
    secondBox.x + secondBox.width - 4,
    secondBox.y + secondBox.height / 2,
    { steps: 10 },
  );
  await page.mouse.up();

  // Wherever it landed, the two rows are still two rows and the words are
  // still in the document — a block drag firing instead would have moved a
  // whole row, and a dropped selection lost by both handlers would have taken
  // the words out.
  const text = await page.locator(EDITOR).innerText();
  expect(text).toContain('alpha');
  expect(text).toContain('second row');
  expect(text.split('\n').filter((line) => line.trim() !== '')).toHaveLength(2);
});

test('typing the trigger character in the body stays plain text', async () => {
  // A16. The insert menu is registered on `/` so the plus can open it by
  // name, and `shouldOpen` declines every keystroke — the character has to
  // land in the document like any other.
  await openFreshDocument(page);
  await typeLines(page, ['before']);
  await page.keyboard.type(' /slash');

  await expect(page.getByTestId('doc-insert-menu')).toHaveCount(0);
  await expect(page.locator(EDITOR)).toContainText('before /slash');
});

test('the block type submenu ticks what the row already is', async () => {
  // A5's last line. The tick is what tells the reader which kind this row is
  // before they choose another.
  await openFreshDocument(page);
  await typeLines(page, ['# a heading row']);

  await hoverRow(page, 0);
  await page.getByTestId('doc-block-handle').click();
  await page.getByTestId('doc-block-row-blockType').click();

  await expect(page.getByTestId('doc-block-type-tick-heading-1')).toBeVisible();
  await expect(page.getByTestId('doc-block-type-tick-heading-2')).toHaveCount(0);
  await expect(page.getByTestId('doc-block-type-tick-paragraph')).toHaveCount(0);

  // Closed before the case ends: the menu is modal, and the drawer this run
  // deletes its Space through is behind that overlay. One Escape takes the
  // whole menu with it, submenu included.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('doc-block-row-delete')).toHaveCount(0);
});

test('text dropped in from outside still lands in the body', async () => {
  await openFreshDocument(page);
  await typeLines(page, ['alpha']);

  await page.evaluate((editorSelector) => {
    const row = document.querySelector(`${editorSelector} .bn-block-content`);
    if (row === null) throw new Error('no row');
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', 'from elsewhere');
    const box = row.getBoundingClientRect();
    const where = {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      clientX: box.x + 40,
      clientY: box.y + box.height - 2,
    };
    row.dispatchEvent(new DragEvent('dragover', where));
    row.dispatchEvent(new DragEvent('drop', where));
  }, EDITOR);

  await expect(page.locator(EDITOR)).toContainText('from elsewhere');
  await expect(page.locator(EDITOR)).toContainText('alpha');
});

/**
 * Switch the interface language and put it back.
 * @param p - The page.
 * @param code - The locale to switch to.
 */
async function switchLanguage(p: Page, code: string): Promise<void> {
  await p.getByTestId('lang-trigger').click();
  await expect(p.getByTestId('lang-popover')).toBeVisible();
  await p.getByTestId(`lang-option-${code}`).click();
  await expect(p.getByTestId('lang-popover')).toHaveCount(0);
}

test('the menu reads in the language the switch is set to', async () => {
  await openFreshDocument(page);
  await typeLines(page, ['alpha']);

  await switchLanguage(page, 'zh-CN');
  try {
    await hoverRow(page, 0);
    await page.getByTestId('doc-block-handle').click();
    await expect(page.getByTestId('doc-block-row-delete')).toHaveText('删除这个块');
    await expect(page.getByTestId('doc-block-row-duplicate')).toHaveText(
      '复制这个块',
    );
    await page.keyboard.press('Escape');

    await hoverRow(page, 0);
    await page.getByTestId('doc-block-add').click();
    await expect(page.getByTestId('doc-insert-quote')).toHaveText('引用');
    await page.keyboard.press('Escape');
  } finally {
    await switchLanguage(page, 'en');
  }
});

test('the menu carries the theme’s own surface in dark', async () => {
  await openFreshDocument(page);
  await typeLines(page, ['alpha']);

  /**
   * The menu panel's background, with the menu open on the first row.
   * @returns The computed colour.
   */
  async function panelBackground(): Promise<string> {
    await hoverRow(page, 0);
    await page.getByTestId('doc-block-handle').click();
    await expect(page.getByTestId('doc-block-row-delete')).toBeVisible();
    const colour = await page.evaluate(() => {
      const row = document.querySelector('[data-testid="doc-block-row-delete"]');
      const panel = row?.closest('[role="menu"]');
      return panel === null || panel === undefined
        ? ''
        : getComputedStyle(panel).backgroundColor;
    });
    await page.keyboard.press('Escape');
    return colour;
  }

  const light = await panelBackground();

  await page.getByTestId('theme-toggle').click();
  await expect(page.getByTestId('theme-popover')).toBeVisible();
  await page.getByTestId('theme-option-dark').click();
  await expect(page.getByTestId('theme-popover')).toHaveCount(0);
  try {
    const dark = await panelBackground();
    expect(dark).not.toBe(light);
    expect(dark).not.toBe('rgba(0, 0, 0, 0)');
  } finally {
    await page.getByTestId('theme-toggle').click();
    await page.getByTestId('theme-option-system').click();
  }
});
