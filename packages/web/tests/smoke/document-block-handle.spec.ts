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
 * Wants dev running:
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace } from '../helpers/space';


let page: Page;

// A page per case: every case opens a Space of its own, and a page carried
// between them carries whatever the last one left on screen.
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

const EDITOR = '[data-testid="document-space"] .ProseMirror';

/**
 * Open a freshly made Document Space with the caret in the body.
 * @param p - The page.
 */
async function openFreshDocument(p: Page): Promise<void> {
  await openSmokeProject(p);

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
 * Every row's text, in order, with a collaborator's caret taken out.
 *
 * `documentCaretExtension` draws a remote caret as a span inside the row it
 * stands in, and hangs a label carrying that collaborator's display name off
 * it (`caret-render.ts:227-290`), so the name is part of the row's
 * `textContent`. The caret is removed from a copy of the row rather than the
 * name trimmed off the string: the element is what this build draws, whereas
 * the name is whatever the account happens to be called.
 * @param p - The page to read.
 * @returns One string per row.
 */
async function bodyOf(p: Page): Promise<string[]> {
  return p.evaluate((editorSelector) => {
    const root = document.querySelector(editorSelector);
    return [...(root?.querySelectorAll('.bn-block-content') ?? [])].map((row) => {
      const copy = row.cloneNode(true) as HTMLElement;
      for (const caret of copy.querySelectorAll('.collaboration-carets__caret')) {
        caret.remove();
      }
      return copy.textContent ?? '';
    });
  }, EDITOR);
}

/**
 * How far off the line's middle the handle may be and still read as centred.
 *
 * One pixel. Measured 2026-09-19 across the four type sizes, the handle's
 * middle lands within 0.28px of the line's, and the line's own middle stands
 * within 0.71px of the middle of the ink the reader compares it against — so a
 * pixel is the whole budget with room to spare. It was 2 until then, and that
 * let a systematic 1.25px lift through at every type size: the handle's
 * wrapper was a block box, which holds an inline-level button on a line
 * baseline with the line's descent space below it, making the strip 26.5px
 * tall around a 24px handle.
 */
const CENTRED_WITHIN = 1;

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
    ).toBeLessThan(CENTRED_WITHIN);
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

  expect(Math.abs(await gapToFirstLine(page))).toBeLessThan(CENTRED_WITHIN);
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
    storageState: STATE_FILE.A,
    viewport: { width: 1680, height: 950 },
  });
  const coEditor = await second.newPage();
  try {
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
      .toBeLessThan(CENTRED_WITHIN);
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

test('the comment row is drawn unusable and does nothing when pressed (A10)', async () => {
  // A10 asks for the row to stand in the menu so the shape is whole AND to
  // look unusable. Only a browser answers the second half: the treatment is
  // `hover:` classes cancelling what the ghost variant would otherwise paint,
  // and whether they win is a question about twMerge and the cascade. Radix
  // highlights the row under the pointer by MOVING FOCUS to it, so the pointer
  // is put on the row before reading.
  await openFreshDocument(page);
  await typeLines(page, ['a line to leave alone']);
  await hoverRow(page, 0);
  await page.getByTestId('doc-block-handle').click();

  const row = page.getByTestId('doc-block-row-comment');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('aria-disabled', 'true');
  await row.hover();

  const drawn = await row.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      opacity: style.opacity,
      cursor: style.cursor,
      background: style.backgroundColor,
    };
  });
  expect(drawn.opacity, 'the row is dimmed').toBe('0.5');
  expect(drawn.cursor, 'the pointer says it cannot be pressed').toBe(
    'not-allowed',
  );
  expect(drawn.background, 'the pointer does not light it up').toBe(
    'rgba(0, 0, 0, 0)',
  );

  // AND THE KEYBOARD STILL SEES WHERE IT IS. The ARIA authoring practices ask
  // a menu to keep disabled items focusable, so an arrow key lands on this row
  // — and the row's own background is the only thing that says so, since the
  // menu item's base class turns the browser's outline off. Measured
  // 2026-09-18 before this: the row read `rgba(0, 0, 0, 0)` under the keyboard
  // while the other four read `rgba(228, 228, 228, ~1)`, so the reader arrowed
  // onto a row and nothing on screen moved.
  //
  // The keys go through the page, not through a constructed `KeyboardEvent`:
  // measured, dispatching one at the menu element moved no focus at all, so
  // the case passed nothing and failed on an empty walk.
  const walked: { testid: string | null; background: string }[] = [];
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press('ArrowDown');
    // The row's background arrives through `transition-colors`, so a reading
    // taken in the same tick catches it part-way: measured, all five came back
    // between `rgba(0, 0, 0, 0)` and `rgba(228, 228, 228, 0.004)`.
    await page.waitForTimeout(250);
    walked.push(
      await page.evaluate(() => {
        const on = document.activeElement;
        return {
          testid: on?.getAttribute('data-testid') ?? null,
          background: on === null ? '' : getComputedStyle(on).backgroundColor,
        };
      }),
    );
  }
  const onComment = walked.find(
    (step) => step.testid === 'doc-block-row-comment',
  );
  expect(onComment, 'an arrow key reaches the comment row').toBeDefined();
  const lit = walked
    .filter((step) => step.testid !== null)
    .map((step) => step.background);
  expect(new Set(lit).size, `every row lights the same: ${lit.join(' ')}`).toBe(
    1,
  );


  // And pressing it leaves the document exactly as it was — the row's own
  // `onSelect` is what has to stop, since Radix would otherwise run it.
  //
  // `force`, because the press a reader makes really does land: the row is
  // marked `aria-disabled`, which is a word for assistive software and not the
  // `disabled` attribute, so the browser delivers the click. Playwright's own
  // actionability check reads `aria-disabled` as "not enabled" and would wait
  // for an enabled state that never comes — measured, it waited out the whole
  // 30s timeout and left the menu open behind it.
  const before = await page.locator(EDITOR).innerText();
  await row.click({ force: true });
  expect(await page.locator(EDITOR).innerText()).toBe(before);

  // Left closed, so the next case starts on a page whose body takes clicks
  // again — Radix holds `pointer-events: none` on the document while a menu
  // is open, and the teardown that deletes the Space presses a button on it.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('doc-block-row-comment')).toHaveCount(0);
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
    storageState: STATE_FILE.A,
    viewport: { width: 1680, height: 950 },
  });
  const coEditor = await second.newPage();
  try {
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

test('dragging the one row a fresh Space has leaves it one row', async () => {
  // A11. Removing the row emptied the only group the document has, and
  // `BlockGroup.ts:11` is `blockGroupChild+`, so the schema put an empty
  // paragraph back before the row was written again: one row in, two rows out.
  // A Space opens on exactly this document, so it is the first row a reader
  // can reach for.
  await openFreshDocument(page);
  await hoverRow(page, 0);
  await expect(page.getByTestId('doc-block-handle')).toBeVisible();

  await dragHandleOntoRow(page, 0);

  await expect(page.locator(`${EDITOR} .bn-block-content`)).toHaveCount(1);
});

test('a drag keeps what a co-editor typed into the row mid-flight', async ({
  browser,
}) => {
  // A11. The drop used to write the row back from the slice BlockNote parses
  // out of `blocknote/html` at dragstart and hands ProseMirror as
  // `view.dragging` (`SideMenu.ts:295-318`), which is the row as it stood when
  // the pointer went down. Measured 2026-09-18, ` MID` typed by the other page
  // during the flight was gone on both ends; an edit to any OTHER row
  // survived, and the row itself moved correctly. Design §8 carries all three
  // runs.
  await openFreshDocument(page);
  await typeLines(page, ['alpha', 'beta', 'gamma']);

  const second = await browser.newContext({
    storageState: STATE_FILE.A,
    viewport: { width: 1680, height: 950 },
  });
  const coEditor = await second.newPage();
  try {
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

test('a modifier-click puts the caret there and selects no block', async () => {
  // user 2026-09-18: this Space does not offer selecting a whole block by
  // holding the modifier and clicking it. ProseMirror's own mousedown answers
  // that gesture with a node selection (`input.ts:347` reads metaKey on a Mac
  // and hands it to `selectClickedNode`), which is the one remaining way to
  // put the violet outline on a row.
  await openFreshDocument(page);
  await typeLines(page, ['alpha', 'beta']);

  const row = await page.locator(`${EDITOR} .bn-block-content`).first().boundingBox();
  if (row === null) throw new Error('no row');
  // Held down rather than passed as an option: `page.mouse.click` takes no
  // modifiers, and a click that quietly drops the modifier tests nothing —
  // measured, the first version of this case passed before the fix existed.
  await page.keyboard.down('Meta');
  await page.mouse.click(row.x + 20, row.y + row.height / 2);
  await page.keyboard.up('Meta');

  await expect(page.locator(`${EDITOR} .ProseMirror-selectednode`)).toHaveCount(
    0,
  );
  await expect(page.getByTestId('doc-selection-bubble-bar')).toHaveCount(0);
  // The click still puts the caret where it landed, so typing goes on there.
  await page.keyboard.type('!');
  await expect(page.locator(EDITOR)).toContainText('!');
  await expect
    .poll(async () => (await bodyOf(page)).join('|'), { timeout: 5_000 })
    .toContain('beta');
});

test('a finished drag leaves no selection and the caret where it was', async () => {
  // The drag is carried by a node selection the library puts on the row, and
  // it is still there when the drag ends. Nothing is drawn for one any more
  // (user 2026-09-18), so what this pins is that the selection itself is gone:
  // the bubble bar comes up for any selection that is not empty, and a node
  // selection is not empty. So the drag hands the reader's place back, the way
  // every other command off this strip does.
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

test('a drag puts the caret back in the row that travelled', async () => {
  // The other half of A11's promise, and the one the case above cannot see:
  // `handleDrop` puts the reader's place back against the document BEFORE the
  // move, so a caret that was in the dragged row sits inside the range about
  // to be removed. What carries it to where the row ended up is the second
  // restore, in the handle's own `onDragEnd`.
  await openFreshDocument(page);
  await typeLines(page, ['alpha', 'beta', 'gamma']);
  // The reader is typing in the row they then reach for.
  await page.locator(`${EDITOR} .bn-block-content`).first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' here');

  await hoverRow(page, 0);
  await expect(page.getByTestId('doc-block-handle')).toBeVisible();
  await dragHandleOntoRow(page, 2);

  await page.keyboard.type('!');
  await expect
    .poll(async () => (await bodyOf(page)).join('|'), { timeout: 15_000 })
    .toBe('beta|gamma|alpha here!');
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
      '复制副本',
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

test('a drag whose anchors a co-editor removes leaves nothing selected', async ({
  browser,
}) => {
  // A11.2. The drag is carried on a node selection, and putting the reader
  // back used to be skipped whole when the row either end was anchored to had
  // gone — so the node selection stood, and with it the bubble bar over a row
  // nobody selected (measured 2026-09-18, `bar: true`).
  await openFreshDocument(page);
  await typeLines(page, ['alpha', 'beta', 'gamma']);

  const second = await browser.newContext({
    storageState: STATE_FILE.A,
    viewport: { width: 1680, height: 950 },
  });
  const coEditor = await second.newPage();
  try {
    await coEditor.goto(page.url());
    await coEditor.waitForURL(/\/project\//, { timeout: 15_000 });
    await expect(coEditor.locator(EDITOR)).toContainText('gamma', {
      timeout: 20_000,
    });

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

    // The other page runs the rows together, taking away both the row in
    // flight and the row the reader's own caret was in.
    await coEditor.locator(`${EDITOR} .bn-block-content`).first().click();
    await coEditor.keyboard.press('Home');
    for (let i = 0; i < 12; i += 1) {
      await coEditor.keyboard.press('Delete');
    }
    await coEditor.keyboard.press('Backspace');
    await page.waitForTimeout(1_500);
    await page.mouse.up();

    await expect(page.getByTestId('doc-selection-bubble-bar')).toHaveCount(0);
    await expect(
      page.locator(`${EDITOR} .ProseMirror-selectednode`),
    ).toHaveCount(0);
  } finally {
    await second.close();
  }
});

/**
 * Open the handle menu on the first row.
 * @param p - The page.
 */
async function openHandleMenu(p: Page): Promise<void> {
  await hoverRow(p, 0);
  await p.getByTestId('doc-block-handle').click();
  await expect(p.getByTestId('doc-block-row-delete')).toBeVisible();
  await settleMenus(p);
}

/**
 * Wait for every open menu panel to finish arriving.
 *
 * The panels come in on `zoom-in-95`, so a box read mid-flight is 95% of its
 * settled size — measured, a 4px gap read 3.81 while the animation was still
 * running.
 * @param p - The page.
 */
async function settleMenus(p: Page): Promise<void> {
  await p.evaluate(async () => {
    await Promise.all(
      [...document.querySelectorAll('[role="menu"]')].flatMap((panel) =>
        panel.getAnimations().map((one) => one.finished.catch(() => undefined)),
      ),
    );
  });
}

/**
 * Shut the handle menu and wait for it to go.
 *
 * A case that leaves it open leaves the document unable to take a click:
 * Radix holds `pointer-events: none` there while a menu stands, and the
 * teardown that removes the Space presses a button on it.
 * @param p - The page.
 */
async function closeHandleMenu(p: Page): Promise<void> {
  await p.keyboard.press('Escape');
  await expect(p.getByTestId('doc-block-row-delete')).toHaveCount(0);
}

test('offers the insert rows in the block type menu’s own order', async () => {
  // The two menus name the same blocks, and `document-insert-menu-items.ts`
  // says so in its own first line. Reading the order off one table is what
  // makes that true: a reader who learns where Code block sits in one menu
  // finds it in the same place in the other.
  await openFreshDocument(page);
  await typeLines(page, ['a row to act on']);
  await openHandleMenu(page);

  await page.getByTestId('doc-block-row-blockType').hover();
  await expect(page.getByTestId('doc-block-type-heading-1')).toBeVisible();
  const types = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="doc-block-type-"]')]
      .map((r) => r.getAttribute('data-testid') ?? '')
      .filter((id) => !id.includes('tick')),
  );
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('doc-block-row-delete')).toHaveCount(0);

  await openHandleMenu(page);
  await page.getByTestId('doc-block-row-insertBelow').hover();
  await expect(page.getByTestId('doc-block-insert-quote')).toBeVisible();
  const inserts = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="doc-block-insert-"]')].map(
      (r) => r.getAttribute('data-testid') ?? '',
    ),
  );

  // Paragraph is the one row insert leaves out: the row it makes is already
  // one, so offering it would offer nothing.
  expect(inserts.map((id) => id.replace('doc-block-insert-', ''))).toEqual(
    types
      .map((id) => id.replace('doc-block-type-', ''))
      .filter((id) => id !== 'paragraph'),
  );

  await closeHandleMenu(page);
});

test('rules the block type submenu where the bubble bar rules it', async () => {
  // The bubble bar's own type menu draws a line wherever the order crosses
  // from one dimension to the next (`DIMENSION_OF_ROW`): seven rows set the
  // type, one sets the number, one sets the quote. Measured there, the gaps
  // run 4,4,4,4,4,4,9,9 — the two nines are the lines.
  await openFreshDocument(page);
  await typeLines(page, ['a row to act on']);
  await openHandleMenu(page);
  await page.getByTestId('doc-block-row-blockType').hover();
  await expect(page.getByTestId('doc-block-type-heading-1')).toBeVisible();
  await settleMenus(page);

  const shape = await page.evaluate(() => {
    const panel = document
      .querySelector('[data-testid="doc-block-type-heading-1"]')
      ?.closest('[role="menu"]');
    if (panel === null || panel === undefined) return null;
    return [...panel.children].map((child) =>
      child.getAttribute('data-testid') ?? child.getAttribute('role') ?? '',
    );
  });

  expect(shape).toEqual([
    'doc-block-type-paragraph',
    'doc-block-type-heading-1',
    'doc-block-type-heading-2',
    'doc-block-type-heading-3',
    'doc-block-type-code-block',
    'doc-block-type-bullet-list',
    'doc-block-type-task-list',
    'separator',
    'doc-block-type-ordered-list',
    'separator',
    'doc-block-type-quote',
  ]);

  await closeHandleMenu(page);
});

test('keeps the handle menu’s rows 4px apart', async () => {
  // A menu whose contents are rows keeps a gap between them (user
  // 2026-08-27). The bubble bar's menus are the family this one joins, and
  // theirs measures 4px.
  await openFreshDocument(page);
  await typeLines(page, ['a row to act on']);
  await openHandleMenu(page);

  const gaps = await page.evaluate(() => {
    const rows = [
      'blockType',
      'duplicate',
      'insertBelow',
      'comment',
      'delete',
    ].map((id) =>
      document
        .querySelector(`[data-testid="doc-block-row-${id}"]`)
        ?.getBoundingClientRect(),
    );
    return rows
      .slice(1)
      .map((box, i) =>
        box === undefined || rows[i] === undefined
          ? null
          : Math.round((box.top - rows[i].bottom) * 100) / 100,
      );
  });

  expect(gaps).toEqual([4, 4, 4, 4]);

  await closeHandleMenu(page);
});

test('keeps 4px between the handle menu and the submenu it flies out', async () => {
  // The same 4px, on the axis this menu opens along: the submenu flies out to
  // the side, so the gap is between the parent's right edge and the
  // submenu's left. Measured before this, the submenu sat 4.67px INSIDE the
  // parent.
  await openFreshDocument(page);
  await typeLines(page, ['a row to act on']);
  await openHandleMenu(page);
  await page.getByTestId('doc-block-row-blockType').hover();
  await expect(page.getByTestId('doc-block-type-heading-1')).toBeVisible();
  await settleMenus(page);

  const gap = await page.evaluate(() => {
    const menus = [...document.querySelectorAll('[role="menu"]')];
    if (menus.length < 2) return null;
    const parent = menus[0]?.getBoundingClientRect();
    const sub = menus[1]?.getBoundingClientRect();
    if (parent === undefined || sub === undefined) return null;
    return Math.round((sub.left - parent.right) * 100) / 100;
  });

  // Within half a pixel of 4, because the panel lays out on fractional widths
  // (199.67 measured) and the trigger row's right edge lands 4.67px inside the
  // panel's rather than the 5px its padding and border add up to. Nobody sees
  // a third of a pixel, and pinning the exact figure would pin the rounding.
  expect(gap, `gap was ${String(gap)}`).not.toBeNull();
  expect(Math.abs((gap ?? 0) - 4), `gap was ${String(gap)}`).toBeLessThan(0.5);

  await closeHandleMenu(page);
});

test('rules the insert submenu the same way', async () => {
  // The same three dimensions, on the menu that makes a row rather than
  // changes one: six rows set the type, one sets the number, one sets the
  // quote. Paragraph is absent, so the first group is one shorter than the
  // block type menu's.
  await openFreshDocument(page);
  await typeLines(page, ['a row to act on']);
  await openHandleMenu(page);
  await page.getByTestId('doc-block-row-insertBelow').hover();
  await expect(page.getByTestId('doc-block-insert-quote')).toBeVisible();
  await settleMenus(page);

  const shape = await page.evaluate(() => {
    const panel = document
      .querySelector('[data-testid="doc-block-insert-quote"]')
      ?.closest('[role="menu"]');
    if (panel === null || panel === undefined) return null;
    return [...panel.children].map(
      (child) =>
        child.getAttribute('data-testid') ?? child.getAttribute('role') ?? '',
    );
  });

  expect(shape).toEqual([
    'doc-block-insert-heading-1',
    'doc-block-insert-heading-2',
    'doc-block-insert-heading-3',
    'doc-block-insert-code-block',
    'doc-block-insert-bullet-list',
    'doc-block-insert-task-list',
    'separator',
    'doc-block-insert-ordered-list',
    'separator',
    'doc-block-insert-quote',
  ]);

  await closeHandleMenu(page);
});
