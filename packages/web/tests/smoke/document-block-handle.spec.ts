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

  createdSpaceIds.push(
    await createSpace(p, 'document', `handle-${Date.now()}`),
  );

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
 * Run one HTML5 drag from the handle onto a row, the way the browser would.
 *
 * Playwright's own `dragTo` drives the mouse, and a native drag started that
 * way never completes here — measured, it hung until the test timed out. The
 * events below are the ones a real drag produces, carrying one `DataTransfer`
 * from start to drop, which is what BlockNote reads on the way down
 * (`SideMenu.ts` listens for `dragover` and `drop` on the document).
 * @param p - The page.
 * @param rowIndex - Which row to drop on, from the top.
 */
async function dragHandleOntoRow(p: Page, rowIndex: number): Promise<void> {
  await p.evaluate(
    ({ editorSelector, index }) => {
      const handle = document.querySelector('[data-testid="doc-block-handle"]');
      const rows = document.querySelectorAll(
        `${editorSelector} .bn-block-content`,
      );
      const target = rows[index];
      if (handle === null || target === undefined) {
        throw new Error('no handle or no target row');
      }
      const dataTransfer = new DataTransfer();
      handle.dispatchEvent(
        new DragEvent('dragstart', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }),
      );
      const box = target.getBoundingClientRect();
      const where = {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: box.x + 40,
        // The lower half of the row, which is what asks for "after this one".
        clientY: box.y + box.height - 2,
      };
      target.dispatchEvent(new DragEvent('dragover', where));
      target.dispatchEvent(new DragEvent('drop', where));
      handle.dispatchEvent(
        new DragEvent('dragend', { bubbles: true, dataTransfer }),
      );
    },
    { editorSelector: EDITOR, index: rowIndex },
  );
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
    await expect(page.getByTestId('doc-block-row-delete')).toHaveText(
      '删除这个块',
    );
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
      const row = document.querySelector(
        '[data-testid="doc-block-row-delete"]',
      );
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
