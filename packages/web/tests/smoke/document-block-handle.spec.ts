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

/**
 * Sign the smoke account in on the page given.
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

/**
 * Every row's text, in order, with a collaborator's caret label trimmed off.
 *
 * The awareness cursor renders the other reader's name into the row it stands
 * in, and that name is part of `textContent`.
 * @param p - The page to read.
 * @returns One string per row.
 */
async function bodyOf(p: Page): Promise<string[]> {
  return p.evaluate((editorSelector) => {
    const root = document.querySelector(editorSelector);
    return [...(root?.querySelectorAll('.bn-block-content') ?? [])].map((row) =>
      (row.textContent ?? '').replace(/doc-smoke-[ab]$/, ''),
    );
  }, EDITOR);
}

/**
 * How far the handle's middle sits from the middle of its row's first line.
 *
 * Read off `data-row-id` rather than off an index: the row the pointer is over
 * is not always the row it was aimed at, since a heading's top margin answers
 * for the row above it.
 * @param p - The page to measure.
 * @returns The signed gap in pixels; A2 wants it at zero.
 * @throws {Error} When there is no strip, row or first line to measure.
 */
async function gapToFirstLine(p: Page): Promise<number> {
  const gap = await p.evaluate((editorSelector) => {
    const strip = document.querySelector('[data-row-id]');
    const rowId = strip?.getAttribute('data-row-id');
    const row = document
      .querySelector(editorSelector)
      ?.querySelector(`[data-id="${String(rowId)}"] .bn-block-content`);
    const handle = document.querySelector('[data-testid="doc-block-handle"]');
    if (row === null || row === undefined || handle === null) return null;
    const words = row.firstElementChild ?? row;
    const range = document.createRange();
    range.selectNodeContents(words);
    const firstLine = range.getClientRects()[0] ?? words.getClientRects()[0];
    if (firstLine === undefined) return null;
    const button = handle.getBoundingClientRect();
    return (
      button.top + button.height / 2 - (firstLine.top + firstLine.height / 2)
    );
  }, EDITOR);
  if (gap === null) throw new Error('nothing to measure the handle against');
  return gap;
}

test('the strip offers the handle, and nothing else', async () => {
  await openFreshDocument(page);
  await typeLines(page, ['first line']);

  await hoverRow(page, 0);

  await expect(page.getByTestId('doc-block-handle')).toBeVisible();
  // Said as a count of what the strip holds: an assertion naming the plus's
  // old testid would pass by construction now that nothing renders it, and
  // would stay green if a different button were added beside the handle.
  await expect(page.locator('[data-row-id] button')).toHaveCount(1);
});

test('a row with nothing on it gets the handle too', async () => {
  // A1. Every command in the handle's menu applies to an empty row — change
  // its type, duplicate it, insert below it, delete it — and dragging a blank
  // line is a thing the reader can mean, so the gutter answers there as well.
  await openFreshDocument(page);
  await typeLines(page, ['first line']);
  await page.keyboard.press('Enter');

  await hoverRow(page, 1);

  await expect(page.getByTestId('doc-block-handle')).toBeVisible();
});

test('a bulleted row with nothing in it gets the handle', async () => {
  await openFreshDocument(page);
  await typeLines(page, ['- an item']);
  await page.keyboard.press('Enter');

  await hoverRow(page, 1);

  await expect(page.getByTestId('doc-block-handle')).toBeVisible();
});

test('the strip stays away while the reader has a selection', async () => {
  // A1, second half (user 2026-09-18): a selection is the bubble bar's to
  // serve, and the two are never on screen together.
  //
  // The row hovered here is far below the selection on purpose. The library
  // hides the strip by itself whenever the pointer lands on something that is
  // not the editor (`SideMenu.ts:632-640`), and the bubble bar stands over the
  // rows it is about — so hovering those would pass whatever this Space does.
  await openFreshDocument(page);
  await typeLines(page, ['first line', 'second line', 'third line', 'fourth']);

  // Triple-click the first row: that selects its own text and nothing else.
  const first = await page.locator(`${EDITOR} .bn-block-content`).first().boundingBox();
  if (first === null) throw new Error('no first row');
  await page.mouse.click(first.x + 20, first.y + first.height / 2, {
    clickCount: 3,
  });
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible();

  await hoverRow(page, 3);

  await expect(page.getByTestId('doc-block-handle')).toHaveCount(0);
});

test('the strip goes away as a drag-selection grows', async () => {
  // The reader's own gesture (2026-09-18): press in a row, drag upwards, and
  // carry the pointer out to the left. The strip is there for the row the
  // caret sits in, and it leaves the moment the selection covers anything.
  await openFreshDocument(page);
  await typeLines(page, ['first line', 'second line', 'third line']);

  const rows = page.locator(`${EDITOR} .bn-block-content`);
  const third = await rows.nth(2).boundingBox();
  const first = await rows.nth(0).boundingBox();
  if (third === null || first === null) throw new Error('rows have no box');

  await page.mouse.move(third.x + 30, third.y + third.height / 2);
  await page.mouse.down();
  await page.mouse.move(first.x + 30, first.y + first.height / 2, {
    steps: 6,
  });
  await page.mouse.move(first.x - 40, first.y + first.height / 2, {
    steps: 3,
  });

  await expect(page.getByTestId('doc-block-handle')).toHaveCount(0);
  await page.mouse.up();
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
    await expect(page.getByTestId('doc-block-handle')).toBeVisible();

    expect(
      Math.abs(await gapToFirstLine(page)),
      `row ${String(index)}`,
    ).toBeLessThan(2);
  }
});

test('the handle keeps its alignment across the selection gate', async () => {
  // A2, after the gate added on 2026-09-18. The measurement below is the same
  // one the case above makes; what this adds is the gate closing and opening
  // in between. Measured on this gesture: the old code left the handle
  // -48.59px off the line with `translateY(0px)`, the fix -0.75px with
  // `translateY(47.84px)`. (A first reading of 72.34px was a transient — it
  // collapsed the selection with a key, and the library then hides the strip
  // outright 400ms later, which is why the click below is a click.)
  await openFreshDocument(page);
  await typeLines(page, ['a plain first row with some words', '# a heading row']);

  const rows = page.locator(`${EDITOR} .bn-block-content`);
  const first = await rows.nth(0).boundingBox();
  const heading = await rows.nth(1).boundingBox();
  if (first === null || heading === null) throw new Error('rows have no box');

  // Hold a selection on the first row, so the strip leaves.
  await page.mouse.click(first.x + 20, first.y + first.height / 2, {
    clickCount: 3,
  });
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible();

  // Move onto the heading while the strip is away: the row it points at
  // changes with no element to measure against.
  await page.mouse.move(heading.x + 40, heading.y + 11);
  await expect(page.getByTestId('doc-block-handle')).toHaveCount(0);

  // Collapse the selection with a click on the row the pointer is over: a
  // keystroke would make the library hide the strip outright
  // (`SideMenu.ts:600-604`), which is a different state from the one A2 is
  // about.
  await page.mouse.click(heading.x + 40, heading.y + heading.height - 6);
  await expect(page.getByTestId('doc-block-handle')).toBeVisible();
  await page.waitForTimeout(400);

  expect(Math.abs(await gapToFirstLine(page))).toBeLessThan(2);
});

test('the handle re-aligns when a co-editor reshapes the row under it', async ({
  browser,
}) => {
  // A2, on the one gesture that changes the hovered row's own leading with the
  // pointer standing still and no local keystroke: somebody else changes its
  // type. Measured 2026-09-18 before this was driven by the row's geometry:
  // the gap went from -1.25px to -6.25px and stayed there, three times the
  // tolerance the case above holds the same measurement to.
  //
  // The library refreshes its own state on a document change
  // (`SideMenu.ts:683-688`) but `updateStateFromMousePos` returns early while
  // the hovered element still carries the same `data-id` (`:229-236`), so
  // nothing upstream reports this.
  await openFreshDocument(page);
  await typeLines(page, ['the row a co-editor reshapes', 'a second row']);

  const second = await browser.newContext({
    viewport: { width: 1680, height: 950 },
  });
  const coEditor = await second.newPage();
  try {
    await signIn(coEditor);
    await coEditor.goto(page.url());
    await coEditor.waitForURL(/\/project\//, { timeout: 15_000 });
    await expect(coEditor.locator(EDITOR)).toContainText('reshapes', {
      timeout: 20_000,
    });

    // Hover row 0 here, and from now on this pointer does not move.
    await hoverRow(page, 0);
    await expect(page.getByTestId('doc-block-handle')).toBeVisible();

    // The other page turns that row into a level-one heading.
    await hoverRow(coEditor, 0);
    await expect(coEditor.getByTestId('doc-block-handle')).toBeVisible({
      timeout: 10_000,
    });
    await coEditor.getByTestId('doc-block-handle').click();
    await coEditor.getByTestId('doc-block-row-blockType').hover();
    await coEditor.getByTestId('doc-block-type-heading-1').click();

    // The change arrives here, and the handle follows the line it moved to.
    await expect(
      page.locator(`${EDITOR} .bn-block-content`).first(),
    ).toHaveAttribute('data-content-type', 'heading', { timeout: 20_000 });
    await expect
      .poll(async () => Math.abs(await gapToFirstLine(page)), {
        timeout: 10_000,
      })
      .toBeLessThan(2);
  } finally {
    await second.close();
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
  // Said positively as well: the row went and the editor is still standing,
  // which `beta` being gone does not say on its own — the error boundary
  // taking the editor's place satisfies that count just as well.
  await expect(page.locator(EDITOR)).toBeVisible();
  await expect(page.locator(`${EDITOR} .bn-block-content`)).toHaveCount(2);
});

test('duplicate copies the row as it stands, not as it was hovered', async ({
  browser,
}) => {
  // A8. The block the menu is about is a snapshot taken when the pointer
  // arrived: the library refreshes its state on a document change
  // (`SideMenu.ts:683-688`) but `updateStateFromMousePos` returns early while
  // the hovered element still carries the same `data-id` (`:229-236`).
  // Measured 2026-09-18 before the commands read the row again at press time:
  // the screen said `alpha PLUS` and Duplicate inserted `alpha`.
  await openFreshDocument(page);
  await typeLines(page, ['alpha', 'a second row']);

  const second = await browser.newContext({
    viewport: { width: 1680, height: 950 },
  });
  const coEditor = await second.newPage();
  try {
    await signIn(coEditor);
    await coEditor.goto(page.url());
    await coEditor.waitForURL(/\/project\//, { timeout: 15_000 });
    await expect(coEditor.locator(EDITOR)).toContainText('alpha', {
      timeout: 20_000,
    });

    await hoverRow(page, 0);
    await expect(page.getByTestId('doc-block-handle')).toBeVisible();
    await page.getByTestId('doc-block-handle').click();
    await expect(page.getByTestId('doc-block-row-duplicate')).toBeVisible();

    // The other page appends to that row while this menu stands open.
    const theirRow = coEditor.locator(`${EDITOR} .bn-block-content`).first();
    await theirRow.click();
    await coEditor.keyboard.press('End');
    await coEditor.keyboard.type(' PLUS');
    await expect(page.locator(EDITOR)).toContainText('alpha PLUS', {
      timeout: 20_000,
    });

    await page.getByTestId('doc-block-row-duplicate').click();

    // Three rows, and the copy carries what the other page had just typed.
    const rows = page.locator(`${EDITOR} .bn-block-content`);
    await expect(rows).toHaveCount(3, { timeout: 10_000 });
    await expect(rows.nth(1)).toContainText('PLUS');
  } finally {
    await second.close();
  }
});

test('insert below puts a row of the chosen type under that row', async () => {
  // A7 and A12. The insert menu is the handle menu's own submenu, and a choice
  // is written in one go: a row appears below the hovered one and is already
  // the type the reader picked.
  await openFreshDocument(page);
  await typeLines(page, ['alpha', 'beta']);

  await hoverRow(page, 0);
  await page.getByTestId('doc-block-handle').click();
  await page.getByTestId('doc-block-row-insertBelow').hover();
  await expect(page.getByTestId('doc-block-insert-heading-1')).toBeVisible();
  await page.getByTestId('doc-block-insert-heading-1').click();

  // Three rows now: alpha, the new heading, beta.
  await expect(page.locator(`${EDITOR} .bn-block-content`)).toHaveCount(3);
  const rows = page.locator(`${EDITOR} .bn-block-content`);
  await expect(rows.nth(0)).toHaveText('alpha');
  await expect(rows.nth(2)).toHaveText('beta');
  await expect(rows.nth(1)).toHaveAttribute('data-content-type', 'heading');

  // And the reader can type into it straight away.
  await expect(page.locator(EDITOR)).toBeFocused();
  await page.keyboard.type('made it');
  await expect(page.locator(`${EDITOR} h1`)).toHaveText('made it');
});

test('insert below a row that has nothing on it still goes below', async () => {
  // A7's amended half: an empty row is not turned into the chosen type, the
  // new row lands under it.
  await openFreshDocument(page);
  await typeLines(page, ['alpha']);
  await page.keyboard.press('Enter');

  await hoverRow(page, 1);
  await page.getByTestId('doc-block-handle').click();
  await page.getByTestId('doc-block-row-insertBelow').hover();
  await page.getByTestId('doc-block-insert-quote').click();

  const rows = page.locator(`${EDITOR} .bn-block-content`);
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toHaveText('');
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

test('a drag keeps what a co-editor typed into the row mid-flight', async ({
  browser,
}) => {
  // A11. The drop used to write the row back from an HTML snapshot taken at
  // mousedown: BlockNote's `dragStart` never sets `view.dragging`, so
  // ProseMirror parsed the dataTransfer instead (`input.ts:790`). Measured
  // 2026-09-18, ` MID` typed by the other page during the flight was gone on
  // both ends; an edit to any OTHER row survived, and the row itself moved
  // correctly. Design §8 carries all three runs.
  await openFreshDocument(page);
  await typeLines(page, ['alpha', 'beta', 'gamma']);

  const second = await browser.newContext({
    viewport: { width: 1680, height: 950 },
  });
  const coEditor = await second.newPage();
  try {
    await signIn(coEditor);
    await coEditor.goto(page.url());
    await coEditor.waitForURL(/\/project\//, { timeout: 15_000 });
    await expect(coEditor.locator(EDITOR)).toContainText('gamma', {
      timeout: 20_000,
    });

    // The other page parks its caret at the end of the row about to be moved.
    await coEditor.locator(`${EDITOR} .bn-block-content`).first().click();
    await coEditor.keyboard.press('End');

    const rows = page.locator(`${EDITOR} .bn-block-content`);
    const source = await rows.nth(0).boundingBox();
    const target = await rows.nth(2).boundingBox();
    if (source === null || target === null) throw new Error('no rows');
    await page.mouse.move(source.x + 40, source.y + source.height / 2);
    await expect(page.getByTestId('doc-block-handle')).toBeVisible();
    const grip = await page.getByTestId('doc-block-handle').boundingBox();
    if (grip === null) throw new Error('no handle');

    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + 40, target.y + target.height - 2, {
      steps: 12,
    });
    // Mid-flight, and it arrives here before the drop.
    await coEditor.keyboard.type(' MID');
    await expect(page.locator(EDITOR)).toContainText('alpha MID', {
      timeout: 20_000,
    });
    await page.mouse.up();

    // The row moved, and it took the other page's word with it.
    await expect
      .poll(async () => (await bodyOf(page)).join('|'), { timeout: 15_000 })
      .toBe('beta|gamma|alpha MID');
    await expect
      .poll(async () => (await bodyOf(coEditor)).join('|'), { timeout: 15_000 })
      .toBe('beta|gamma|alpha MID');
  } finally {
    await second.close();
  }
});

test('undoing a drag puts the row back with nothing selected', async () => {
  // Reported 2026-09-18 with a screenshot: after a drag, Cmd+Z brought the row
  // back wearing the violet outline with the bubble bar over it, while nothing
  // was selected. Every undo item records the selection from BEFORE the change
  // that made it (`y-prosemirror/src/plugins/undo-plugin.js`: `prevSel` off
  // `oldState`, handed to `stack-item-added`), and before the move that
  // selection was the node selection `blockDragStart` puts on the row.
  //
  // Undoing a DELETE off the same menu never did this, which is what says the
  // drag is the only path that leaves one there.
  await openFreshDocument(page);
  await typeLines(page, ['alpha', 'beta', 'gamma']);

  await hoverRow(page, 0);
  await expect(page.getByTestId('doc-block-handle')).toBeVisible();
  await dragHandleOntoRow(page, 2);
  await expect
    .poll(async () => (await bodyOf(page)).join('|'), { timeout: 10_000 })
    .toBe('beta|gamma|alpha');

  // Off the strip, so nothing hover-driven is in the way of the reading.
  await page.mouse.move(5, 5);
  await page.keyboard.press('Meta+z');

  await expect
    .poll(async () => (await bodyOf(page)).join('|'), { timeout: 10_000 })
    .toBe('alpha|beta|gamma');
  await expect(page.locator(`${EDITOR} .ProseMirror-selectednode`)).toHaveCount(
    0,
  );
  await expect(page.getByTestId('doc-selection-bubble-bar')).toHaveCount(0);
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

test('a text drag in the body does not become a block drag', async () => {
  // A19's other half, as far as a driven mouse reaches. The handle's drag and
  // a text drag are two gestures on one surface: BlockNote's own drop handler
  // returns early while ProseMirror is dragging text (`SideMenu.ts:546-552`),
  // which is what keeps the block drag from taking the text drag's place.
  //
  // WHAT THIS DOES NOT ESTABLISH: that the words moved. Measured 2026-09-18,
  // the document after this sequence is `alpha beta\n\nsecond row` — unchanged
  // — because the mouse steps do not take ProseMirror's own text-drag path.
  // What the assertions below do catch is a block drag firing instead (a whole
  // row would have moved) and a drop lost by both handlers (the words would be
  // gone). A19's moving half is checked by hand in the app.
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

  // Two rows are still two rows and the words are still in the document.
  const text = await page.locator(EDITOR).innerText();
  expect(text).toContain('alpha');
  expect(text).toContain('second row');
  expect(text.split('\n').filter((line) => line.trim() !== '')).toHaveLength(2);
});

test('a selection swept out to the left takes no extra rows', async () => {
  // The reader's report (2026-09-18). The strip leaves as soon as the
  // selection covers anything, so the gutter the pointer sweeps through is
  // bare — and the selection follows the pointer rather than jumping to the
  // top of the document.
  await openFreshDocument(page);
  await typeLines(page, ['alpha', 'beta', 'gamma', 'delta']);

  const rows = page.locator(`${EDITOR} .bn-block-content`);
  const third = await rows.nth(2).boundingBox();
  const fourth = await rows.nth(3).boundingBox();
  if (third === null || fourth === null) throw new Error('rows have no box');

  await page.mouse.move(fourth.x + fourth.width - 2, fourth.y + fourth.height / 2);
  await page.mouse.down();
  await page.mouse.move(third.x + 30, third.y + third.height / 2, { steps: 6 });
  await page.mouse.move(third.x - 40, third.y + third.height / 2, { steps: 4 });
  const swept = await page.evaluate(
    () => window.getSelection()?.toString() ?? '',
  );
  await page.mouse.up();

  // The two rows the pointer was in, and no row above them. The third row's
  // first word can be clipped: the pointer's own x is what the browser maps
  // to a position in that line.
  expect(swept).toContain('delta');
  expect(swept).toContain('amma');
  expect(swept).not.toContain('alpha');
  expect(swept).not.toContain('beta');
  expect(swept.split('\n').filter((line) => line.trim() !== '')).toHaveLength(
    2,
  );
});

test('typing the trigger character in the body stays plain text', async () => {
  // A16. No suggestion menu is registered at all, so `/` has no second
  // identity — it lands in the document like any other character.
  await openFreshDocument(page);
  await typeLines(page, ['before']);
  await page.keyboard.type(' /slash');

  await expect(page.locator(EDITOR)).toContainText('before /slash');
  await expect(page.locator('[role="listbox"]')).toHaveCount(0);
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
    await page.getByTestId('doc-block-handle').click();
    await page.getByTestId('doc-block-row-insertBelow').hover();
    await expect(page.getByTestId('doc-block-insert-quote')).toHaveText('引用');
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
