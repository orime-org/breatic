// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #978 验收 A1 · A4 · A5 · A6 · A14: where an ordered list starts over, typed
 * the way a reader types it.
 *
 * The jsdom cases build a document and read it. These build it by pressing
 * keys, which is the half those cannot reach: whether a chord makes the block
 * the rule is about, and whether the number the decoration layer computed is
 * the number that lands on screen.
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
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * Opens a freshly made Document Space with the caret in the body.
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
    await createSpace(p, 'document', `restart-${Date.now()}`),
  );

  const editor = p.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await expect(editor).toBeFocused();
}

/**
 * What each block shows, in reading order, and what kind of block it is.
 *
 * The kind travels with the number because a chord that failed to make the
 * block leaves a plausible-looking row of numbers behind: a paragraph that
 * never became a list item shows no number, and so does a list item the
 * decoration layer skipped.
 * @param p - The page.
 * @returns One entry per block.
 */
async function blocksOnScreen(
  p: Page,
): Promise<{ type: string | null; number: string | null; depth: number }[]> {
  return p.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (root === null) return [];
    return [...root.querySelectorAll('.bn-block-content')].map((element) => {
      let depth = 0;
      let node: Element | null = element.closest('.bn-block-outer');
      while (node !== null) {
        node = node.parentElement?.closest('.bn-block-outer') ?? null;
        if (node !== null) depth += 1;
      }
      return {
        type: element.getAttribute('data-content-type'),
        number: element.getAttribute('data-doc-number'),
        depth,
      };
    });
  }, EDITOR);
}

/**
 * Types one line as an ordered list item, opening a new block first.
 * @param p - The page.
 * @param text - What to type into it.
 */
async function orderedItem(p: Page, text: string): Promise<void> {
  // Back to a paragraph first. A block opened with Enter carries the kind of
  // the one above it, and the list chord on a heading turns that heading into
  // a NUMBERED one rather than into an item — measured on a real editor, where
  // Mod+Shift+7 over a plain level-two heading left it a heading and gave it
  // the number 1.1.
  await p.keyboard.press(`${MOD}+Alt+0`);
  await p.keyboard.press(`${MOD}+Shift+7`);
  await p.keyboard.type(text);
}

test('A1 — the items after a paragraph start over at one', async () => {
  await openFreshDocument(page);

  await orderedItem(page, 'one');
  for (const text of ['two', 'three', 'four']) {
    await page.keyboard.press('Enter');
    await page.keyboard.type(text);
  }
  await page.keyboard.press('Enter');
  await page.keyboard.press(`${MOD}+Alt+0`);
  await page.keyboard.type('a sentence in between');
  await page.keyboard.press('Enter');
  await orderedItem(page, 'five');
  for (const text of ['six', 'seven']) {
    await page.keyboard.press('Enter');
    await page.keyboard.type(text);
  }
  await page.waitForTimeout(300);

  const blocks = await blocksOnScreen(page);
  const listed = blocks.filter(
    (block) => block.type === 'numberedListItem',
  );
  expect(listed.map((block) => block.number)).toEqual([
    '1.',
    '2.',
    '3.',
    '4.',
    '1.',
    '2.',
    '3.',
  ]);
});

test('A4 — a bullet, a to-do, a plain heading and code each cut it', async () => {
  await openFreshDocument(page);

  await orderedItem(page, 'a');
  await page.keyboard.press('Enter');
  await page.keyboard.press(`${MOD}+Shift+8`);
  await page.keyboard.type('a bullet');
  await page.keyboard.press('Enter');
  await orderedItem(page, 'b');
  await page.keyboard.press('Enter');
  await page.keyboard.press(`${MOD}+Shift+9`);
  await page.keyboard.type('a to-do');
  await page.keyboard.press('Enter');
  await orderedItem(page, 'c');
  await page.keyboard.press('Enter');
  // Paragraph first, so the heading chord lands on a block carrying no number.
  await page.keyboard.press(`${MOD}+Alt+0`);
  await page.keyboard.press(`${MOD}+Alt+3`);
  await page.keyboard.type('a heading carrying no number');
  await page.keyboard.press('Enter');
  await orderedItem(page, 'd');
  await page.keyboard.press('Enter');
  await page.keyboard.press(`${MOD}+Alt+0`);
  // Three backticks and a space make a code block through the input rule,
  // which is the route a reader takes. Typed with a delay because the rule
  // fires per character.
  await page.keyboard.type('``` ', { delay: 40 });
  await page.keyboard.type('const a = 1;');
  // Shift+Enter leaves a code block; Enter inside one is a newline.
  await page.keyboard.press('Shift+Enter');
  await orderedItem(page, 'e');
  await page.waitForTimeout(300);

  const blocks = await blocksOnScreen(page);
  const kinds = blocks.map((block) => block.type);
  expect(kinds, 'every chord made the block it names').toEqual(
    expect.arrayContaining([
      'numberedListItem',
      'bulletListItem',
      'checkListItem',
      'heading',
      'codeBlock',
    ]),
  );
  const heading = blocks.find((block) => block.type === 'heading');
  expect(heading?.number, 'this heading carries no number of its own').toBe(
    null,
  );
  const listed = blocks.filter((block) => block.type === 'numberedListItem');
  expect(listed.map((block) => block.number)).toEqual([
    '1.',
    '1.',
    '1.',
    '1.',
    '1.',
  ]);
});

test('A5 — each section’s list starts over under its own heading', async () => {
  await openFreshDocument(page);

  // A numbered heading is an ordered item the reader turned into a heading.
  // The heading chord alone leaves the `numbered` prop off, so it takes both
  // rows in some order; this test takes the ordered one first.
  await orderedItem(page, 'first section');
  await page.keyboard.press(`${MOD}+Alt+1`);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await orderedItem(page, 'first one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('first two');

  await page.keyboard.press('Enter');
  await orderedItem(page, 'second section');
  await page.keyboard.press(`${MOD}+Alt+1`);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await orderedItem(page, 'second one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second two');
  await page.waitForTimeout(300);

  const blocks = await blocksOnScreen(page);
  const headings = blocks.filter((block) => block.type === 'heading');
  expect(headings.map((block) => block.number)).toEqual(['1.', '2.']);
  const listed = blocks.filter((block) => block.type === 'numberedListItem');
  expect(listed.map((block) => block.number)).toEqual([
    '1.',
    '2.',
    '1.',
    '2.',
  ]);
});

test('A6 — an item turned into a heading cuts the line it stood on', async () => {
  await openFreshDocument(page);

  await orderedItem(page, 'first');
  await page.keyboard.press('Enter');
  await page.keyboard.type('middle');
  // Turn this one into a heading where the caret already is. Walking back to
  // it with ArrowUp lands somewhere else often enough to matter.
  await page.keyboard.press(`${MOD}+Alt+1`);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await orderedItem(page, 'third');
  await page.waitForTimeout(300);

  const blocks = await blocksOnScreen(page);
  // The kinds in reading order, so a heading that landed on the wrong block
  // cannot leave the numbers looking right.
  expect(blocks.map((block) => block.type)).toEqual([
    'numberedListItem',
    'heading',
    'numberedListItem',
  ]);
  expect(blocks[1]?.number, 'its own number comes from the headings').toBe(
    '1.',
  );
  const listed = blocks.filter((block) => block.type === 'numberedListItem');
  expect(listed.map((block) => block.number)).toEqual(['1.', '1.']);
});

test('A14 — a cut inside an indented list leaves the outer one alone', async () => {
  await openFreshDocument(page);

  await orderedItem(page, 'outer one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('inner a');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.press(`${MOD}+Alt+0`);
  await page.keyboard.type('a note under the first');
  await page.keyboard.press('Enter');
  await orderedItem(page, 'inner b');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.type('outer two');
  await page.waitForTimeout(300);

  const blocks = await blocksOnScreen(page);
  const listed = blocks.filter((block) => block.type === 'numberedListItem');
  // Outer one, inner a, inner b, outer two — the note cuts the indented line
  // and leaves the outer one counting.
  expect(listed.map((block) => block.number)).toEqual([
    '1.',
    '1.',
    '1.',
    '2.',
  ]);
  // Without this, the numbers alone cannot tell the two lines apart: left where
  // it was, `outer two` would be the second item of the INDENTED line and read
  // `2.` just the same.
  expect(
    listed.map((block) => block.depth),
    'the last item came back out to the outer level',
  ).toEqual([
    listed[0]!.depth,
    listed[0]!.depth + 1,
    listed[0]!.depth + 1,
    listed[0]!.depth,
  ]);
});
