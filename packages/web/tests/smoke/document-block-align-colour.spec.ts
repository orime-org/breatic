// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Alignment and colour off the block handle, end to end (task #995).
 *
 * The half jsdom cannot reach. The side menu decides which row the pointer is
 * over by asking the document what is at a point, and every rectangle jsdom
 * reports is zero — so the handle never appears there, and the whole path from
 * "the pointer is over THIS row" to "the write landed on THAT row" exists only
 * in a browser.
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

/**
 * Sign the smoke account in.
 * @param p - The page to sign in.
 */
async function signIn(p: Page): Promise<void> {
  await p.goto('/login');
  await p.locator('#login-email').fill(email as string);
  await p.locator('#login-password').fill(password as string);
  await p.locator('form button[type="submit"]').click();
  await p.waitForURL(/\/(studio|project)/, { timeout: 15_000 });
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  await signIn(page);
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
const ROW = `${EDITOR} .bn-block-content`;

/** What each row of the body is, in the order this spec types them. */
const ROWS = {
  paragraph: 0,
  listItem: 1,
  emptyParagraph: 2,
  codeBlock: 3,
} as const;

/**
 * Open a fresh Document Space holding one row of each kind this spec walks.
 * @param p - The page.
 */
async function openBody(p: Page): Promise<void> {
  if (projectUrl === undefined) {
    await p.goto('/studio');
    const firstProject = p.locator('a[href^="/project/"]').first();
    await expect(firstProject).toBeVisible({ timeout: 15_000 });
    await firstProject.click();
  } else {
    await p.goto(projectUrl);
  }
  await p.waitForURL(/\/project\//, { timeout: 15_000 });

  createdSpaceIds.push(await createSpace(p, 'document', `a995-${Date.now()}`));

  const editor = p.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();

  await p.keyboard.type('alpha words');
  await p.keyboard.press('Enter');
  // The marker turns this line into a list item as it is typed.
  await p.keyboard.type('- an item');
  await p.keyboard.press('Enter');
  // A second Enter on an empty item leaves the list, which is the empty
  // paragraph below.
  await p.keyboard.press('Enter');
  await p.keyboard.press('Enter');
  // The fence turns the row into a code block when the word after it ends —
  // that word is the language, so `code` names it and `here` is the content.
  await p.keyboard.type('```');
  await p.keyboard.type('code here');
  await expect(p.locator(ROW).nth(ROWS.codeBlock)).toHaveAttribute(
    'data-content-type',
    'codeBlock',
  );
}

/**
 * Put the pointer over one row so the strip appears beside it.
 *
 * At a fixed offset from the row's left edge rather than at its middle: an
 * empty row is 2px wide, so its middle is not inside it in any useful sense.
 * @param p - The page.
 * @param index - Which row, from the top.
 * @throws {Error} When that row has no box.
 */
async function hoverRow(p: Page, index: number): Promise<void> {
  const box = await p.locator(ROW).nth(index).boundingBox();
  if (box === null) throw new Error(`row ${index} has no box`);
  await p.mouse.move(box.x + 40, box.y + 11);
  await expect(p.getByTestId('doc-block-handle')).toBeVisible();
}

/**
 * Open the handle menu over one row.
 * @param p - The page.
 * @param index - Which row.
 */
async function openMenuOver(p: Page, index: number): Promise<void> {
  await hoverRow(p, index);
  await p.getByTestId('doc-block-handle').click();
  await expect(p.getByTestId('doc-block-row-blockType')).toBeVisible();
}

/**
 * Press one element where it sits, whatever Playwright makes of its state.
 * @param p - The page.
 * @param testId - What to press.
 * @throws {Error} When it has no box.
 */
async function pressAt(p: Page, testId: string): Promise<void> {
  const box = await p.getByTestId(testId).boundingBox();
  if (box === null) throw new Error(`${testId} has no box`);
  await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * Every row's type, alignment and inline colours, as the DOM shows them.
 * @param p - The page to read.
 * @returns One entry per row.
 */
async function bodyOf(p: Page): Promise<
  { type: string | null; alignment: string | null; colours: (string | null)[] }[]
> {
  return p.evaluate((selector) => {
    const root = document.querySelector(selector);
    return [...(root?.querySelectorAll('.bn-block-content') ?? [])].map(
      (row) => ({
        type: row.getAttribute('data-content-type'),
        alignment: row.getAttribute('data-text-alignment'),
        colours: [
          ...row.querySelectorAll('[data-style-type="textColor"]'),
        ].map((span) => span.getAttribute('data-value')),
      }),
    );
  }, EDITOR);
}

/**
 * Which row the reader's own caret is in, off the browser's own selection.
 * @param p - The page to read.
 * @returns The row index, or -1 where the caret is outside the body.
 */
async function caretRow(p: Page): Promise<number> {
  return p.evaluate((selector) => {
    const anchor = window.getSelection()?.anchorNode ?? null;
    if (anchor === null) return -1;
    const from =
      anchor.nodeType === Node.ELEMENT_NODE
        ? (anchor as Element)
        : anchor.parentElement;
    const row = from?.closest('.bn-block-content') ?? null;
    const rows = [
      ...(document
        .querySelector(selector)
        ?.querySelectorAll('.bn-block-content') ?? []),
    ];
    return row === null ? -1 : rows.indexOf(row);
  }, EDITOR);
}

test('each row says which of the two commands can reach it', async () => {
  await openBody(page);

  const reach: Record<string, [boolean, boolean]> = {};
  for (const [what, index] of Object.entries(ROWS)) {
    await openMenuOver(page, index);
    reach[what] = [
      (await page
        .getByTestId('doc-block-row-align')
        .getAttribute('aria-disabled')) === 'true',
      (await page
        .getByTestId('doc-block-row-color')
        .getAttribute('aria-disabled')) === 'true',
    ];
    await page.keyboard.press('Escape');
  }

  // [alignment greyed, colour greyed]. An empty paragraph can be centred —
  // the caret goes with it — but holds no run to colour; a code block takes
  // no marks at all, and alignment reaches neither it nor a list item.
  expect(reach).toEqual({
    paragraph: [false, false],
    listItem: [true, false],
    emptyParagraph: [false, true],
    codeBlock: [true, true],
  });
});

test('a greyed row does not open, by pointer or by keyboard', async () => {
  await openBody(page);
  await openMenuOver(page, ROWS.codeBlock);

  // The pointer RESTING on the row, which is how Radix opens a submenu: its
  // `onPointerMove` starts a 100ms timer. A case that asserts straight after
  // moving passes whether or not the row cancels that event, because the
  // assertion resolves before the timer would fire.
  const row = page.getByTestId('doc-block-row-align');
  const box = await row.boundingBox();
  if (box === null) throw new Error('the alignment row has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(400);
  await expect(page.getByTestId('doc-block-align-left')).toHaveCount(0);

  // And a press where a reader would press. Through `page.mouse` rather than
  // `locator.click`: Playwright reads `aria-disabled` as "not enabled" and
  // waits for the row to become actionable, which it never does, so the call
  // would time out without ever pressing.
  await pressAt(page, 'doc-block-row-align');
  await expect(page.getByTestId('doc-block-align-left')).toHaveCount(0);

  // The keyboard walks down to the colour row the way a reader does — a
  // greyed row stays reachable, which is what `aria-disabled` rather than
  // Radix's `disabled` buys — and the key Radix opens a submenu with does
  // nothing there.
  const landed: (string | null)[] = [];
  for (let i = 0; i < 7; i += 1) {
    await page.keyboard.press('ArrowDown');
    landed.push(
      await page.evaluate(
        () => document.activeElement?.getAttribute('data-testid') ?? null,
      ),
    );
    if (landed[landed.length - 1] === 'doc-block-row-color') break;
  }
  expect(landed).toContain('doc-block-row-color');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('doc-block-color-text-red')).toHaveCount(0);

  // Still open: a row that cannot act takes nothing away either.
  await expect(page.getByTestId('doc-block-row-blockType')).toBeVisible();

  // And closed again before the Space is cleaned up: the menu is modal, so
  // anything left open swallows the drawer's own clicks.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('doc-block-row-blockType')).toHaveCount(0);
});

test('both rows act on the hovered row, leaving the reader where they are', async () => {
  await openBody(page);

  // The reader's caret stays in the code block throughout; the presses below
  // are aimed at the first row. The handle is only on screen while the reader
  // holds no selection, so this is every press, not an edge case.
  await page.locator(ROW).nth(ROWS.codeBlock).click();
  expect(await caretRow(page)).toBe(ROWS.codeBlock);

  await openMenuOver(page, ROWS.paragraph);
  await page.getByTestId('doc-block-row-align').click();
  // The row the block is on, read off that block rather than off the reader.
  await expect(page.getByTestId('doc-block-align-left')).toHaveAttribute(
    'data-ticked',
    'true',
  );
  await expect(page.getByTestId('doc-block-align-right')).not.toHaveAttribute(
    'data-ticked',
    'true',
  );
  await page.getByTestId('doc-block-align-right').click();

  await openMenuOver(page, ROWS.paragraph);
  await page.getByTestId('doc-block-row-color').click();
  await page.getByTestId('doc-block-color-text-red').click();

  await expect
    .poll(async () => (await bodyOf(page))[ROWS.paragraph])
    .toEqual({ type: 'paragraph', alignment: 'right', colours: ['red'] });
  const others = (await bodyOf(page)).filter(
    (_, index) => index !== ROWS.paragraph,
  );
  expect(others.map((row) => row.alignment)).toEqual([null, null, null]);
  expect(others.flatMap((row) => row.colours)).toEqual([]);
  expect(await caretRow(page)).toBe(ROWS.codeBlock);
});
