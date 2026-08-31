// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The block type menu end to end (task #904).
 *
 * The half jsdom cannot reach: the eight chords really held down, the menu
 * really opened with a pointer and a row really clicked, and where the ticks
 * and the rule land in a real layout — every rectangle jsdom reports is zero,
 * and a keystroke there is handed to `handleKeyDown` by hand, so the browser's
 * own layer never runs.
 *
 * What each cell produces is pinned cell by cell in the unit tests
 * (`__tests__/block-type-transitions.test.ts` and five others).
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

const SLOT = 'doc-bubble-block-type';
const EDITOR = '[data-testid="document-space"] .ProseMirror';

/** The Cmd key on macOS, Ctrl everywhere else. */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

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

  createdSpaceIds.push(await createSpace(p, 'document', `blocktype-${Date.now()}`));

  const editor = p.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  // Closing the new-Space dialog hands focus back to the button that opened
  // it, asynchronously. Wait for that, or the typing below goes to the button.
  await expect(p.getByTestId('new-space-button')).toBeFocused();
  await editor.click();
  await expect(editor).toBeFocused();
}

/**
 * Type one line and take the whole of it.
 * @param p - The page.
 * @param text - What to type.
 */
async function typeAndSelectLine(p: Page, text: string): Promise<void> {
  await p.keyboard.type(text);
  await p.keyboard.press(`${MOD}+a`);
  await expect(p.getByTestId(SLOT)).toBeVisible({ timeout: 10_000 });
}

/**
 * The body's HTML as it stands, without the placeholder attribute.
 * @param p - The page.
 * @returns That HTML.
 */
async function bodyHtml(p: Page): Promise<string> {
  return p.evaluate(
    (sel) =>
      document.querySelector(sel)!.innerHTML.replace(/ data-block-placeholder="[^"]*"/g, ''),
    EDITOR,
  );
}

/**
 * Move the pointer onto the block type slot and wait for its menu.
 * @param p - The page.
 */
async function openBlockTypeMenu(p: Page): Promise<void> {
  await p.getByTestId(SLOT).hover();
  await expect(p.getByTestId(`${SLOT}-menu`)).toBeVisible({ timeout: 10_000 });
}

test('presses each of the nine rows and the document follows every time', async () => {
  await openFreshDocument(page);
  await typeAndSelectLine(page, 'a line the menu will work on');

  const expected: Array<[id: string, html: string]> = [
    ['heading-1', '<h1>a line the menu will work on</h1>'],
    ['heading-2', '<h2>a line the menu will work on</h2>'],
    ['heading-3', '<h3>a line the menu will work on</h3>'],
    ['bullet-list', '<ul><li><p>a line the menu will work on</p></li></ul>'],
    ['ordered-list', '<ol><li><p>a line the menu will work on</p></li></ol>'],
    ['code-block', '<pre><code>a line the menu will work on</code></pre>'],
    ['paragraph', '<p>a line the menu will work on</p>'],
    ['quote', '<blockquote><p>a line the menu will work on</p></blockquote>'],
  ];

  for (const [id, html] of expected) {
    await openBlockTypeMenu(page);
    await page.getByTestId(`${SLOT}-item-${id}`).click();
    await expect
      .poll(async () => bodyHtml(page), { timeout: 10_000 })
      .toBe(html);
    // The first block itself rather than the editor around it: a click in the
    // space below the last block has `DocumentClickToWrite` add a block at the
    // end, and the next select-all would take that one in too.
    await page.locator(`${EDITOR} > *`).first().click();
    await page.keyboard.press(`${MOD}+a`);
  }

  // The task list is the ninth row: greyed, with no schema node (#13).
  await openBlockTypeMenu(page);
  await expect(page.getByTestId(`${SLOT}-item-task-list`)).toHaveAttribute(
    'aria-disabled',
    'true',
  );
});

test('holds each of the eight chords and lands where the row does', async () => {
  await openFreshDocument(page);
  await typeAndSelectLine(page, 'a line the keys will work on');

  const chords: Array<[chord: string, html: string]> = [
    [`${MOD}+Alt+1`, '<h1>a line the keys will work on</h1>'],
    [`${MOD}+Alt+2`, '<h2>a line the keys will work on</h2>'],
    [`${MOD}+Alt+3`, '<h3>a line the keys will work on</h3>'],
    [`${MOD}+Shift+8`, '<ul><li><p>a line the keys will work on</p></li></ul>'],
    [`${MOD}+Shift+7`, '<ol><li><p>a line the keys will work on</p></li></ol>'],
    [`${MOD}+Alt+c`, '<pre><code>a line the keys will work on</code></pre>'],
    [`${MOD}+Alt+0`, '<p>a line the keys will work on</p>'],
    [`${MOD}+Shift+b`, '<blockquote><p>a line the keys will work on</p></blockquote>'],
  ];

  for (const [chord, html] of chords) {
    await page.keyboard.press(chord);
    await expect.poll(async () => bodyHtml(page), { timeout: 10_000 }).toBe(html);
    await page.keyboard.press(`${MOD}+a`);
  }
});

test('a quoted list: a heading moves the block, Quote takes the quote off', async () => {
  await openFreshDocument(page);
  await typeAndSelectLine(page, 'quoted list item');
  // A list first, then a quote around it.
  await page.keyboard.press(`${MOD}+Shift+8`);
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+Shift+b`);
  await expect
    .poll(async () => bodyHtml(page), { timeout: 10_000 })
    .toBe('<blockquote><ul><li><p>quoted list item</p></li></ul></blockquote>');

  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+Alt+1`);
  await expect
    .poll(async () => bodyHtml(page), { timeout: 10_000 })
    .toBe('<blockquote><h1>quoted list item</h1></blockquote>');

  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+Shift+b`);
  await expect
    .poll(async () => bodyHtml(page), { timeout: 10_000 })
    .toBe('<h1>quoted list item</h1>');
});

test('draws the tick right of the chord and the rule after Code block', async () => {
  await openFreshDocument(page);
  await typeAndSelectLine(page, 'a heading to tick');
  await page.keyboard.press(`${MOD}+Alt+1`);
  await page.keyboard.press(`${MOD}+a`);
  await openBlockTypeMenu(page);

  // The tick is on the Heading 1 row and on no other.
  const ticks = page.locator(`[data-testid^="${SLOT}-tick-"]`);
  await expect(ticks).toHaveCount(1);
  await expect(page.getByTestId(`${SLOT}-tick-heading-1`)).toBeVisible();

  const geometry = await page.evaluate((slot) => {
    const rect = (testid: string): DOMRect | null =>
      document.querySelector(`[data-testid="${testid}"]`)?.getBoundingClientRect() ?? null;
    const shortcut = rect(`${slot}-shortcut-heading-1`);
    const tick = rect(`${slot}-tick-heading-1`);
    const shortcutRights = ['heading-1', 'heading-2', 'heading-3'].map(
      (id) => Math.round(rect(`${slot}-shortcut-${id}`)?.right ?? -1),
    );
    const codeBlock = rect(`${slot}-item-code-block`);
    const quote = rect(`${slot}-item-quote`);
    const rule = document
      .querySelector(`[data-testid="${slot}-menu"] [data-testid="doc-bubble-rule"]`)
      ?.getBoundingClientRect() ?? null;
    return {
      tickLeft: tick?.left ?? null,
      shortcutRight: shortcut?.right ?? null,
      sameRow: shortcut && tick
        ? Math.abs((shortcut.top + shortcut.height / 2) - (tick.top + tick.height / 2)) < 4
        : false,
      ruleTop: rule?.top ?? null,
      codeBlockBottom: codeBlock?.bottom ?? null,
      quoteTop: quote?.top ?? null,
      activeRows: document.querySelectorAll(
        `[data-testid="${slot}-menu"] [data-active="true"]`,
      ).length,
      shortcutRights,
    };
  }, SLOT);

  // The demo draws the tick right of the chord, on the same line.
  expect(geometry.sameRow).toBe(true);
  expect(geometry.tickLeft).not.toBeNull();
  expect(geometry.shortcutRight).not.toBeNull();
  expect(geometry.tickLeft as number).toBeGreaterThan(geometry.shortcutRight as number);

  // The rule sits between Code block and Quote.
  expect(geometry.ruleTop as number).toBeGreaterThanOrEqual(
    geometry.codeBlockBottom as number,
  );
  expect(geometry.quoteTop as number).toBeGreaterThanOrEqual(geometry.ruleTop as number);

  // Every row keeps the tick's column, so the ticked row's chord stays on the
  // line the others sit on (the demo's `.row .tick`).
  expect(new Set(geometry.shortcutRights).size).toBe(1);
  expect(geometry.shortcutRights[0]).toBeGreaterThan(0);

  // The row fill is gone; the tick is the only mark.
  expect(geometry.activeRows).toBe(0);
});

/**
 * The rows the open menu greys.
 * @param p - The page.
 * @returns Their ids, in the order the menu draws them.
 */
async function greyedRows(p: Page): Promise<string[]> {
  return p.evaluate((slot) => {
    const rows = document.querySelectorAll(`[data-testid^="${slot}-item-"]`);
    return Array.from(rows)
      .filter((row) => row.getAttribute('aria-disabled') === 'true')
      .map((row) => row.getAttribute('data-testid')?.replace(`${slot}-item-`, '') ?? '');
  }, SLOT);
}

test('a body holding an indented list lights every row but the task list', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('lead');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- one');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('deep');
  await expect
    .poll(async () => bodyHtml(page), { timeout: 10_000 })
    .toBe('<p>lead</p><ul><li><p>one</p><ul><li><p>deep</p></li></ul></li></ul>');

  // Select-all has two tiers: the block, then the body (`select-all-tiers-and-keys`).
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+a`);
  await expect(page.getByTestId(SLOT)).toBeVisible({ timeout: 10_000 });
  await openBlockTypeMenu(page);
  expect(await greyedRows(page)).toEqual(['task-list']);

  await page.getByTestId(`${SLOT}-item-heading-1`).click();
  await expect
    .poll(async () => bodyHtml(page), { timeout: 10_000 })
    .toBe('<h1>lead</h1><h1>one</h1><h1>deep</h1>');
});

test('an item opening a sub-list is reachable from its first line alone', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('- one');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('deep');
  await expect
    .poll(async () => bodyHtml(page), { timeout: 10_000 })
    .toBe('<ul><li><p>one</p><ul><li><p>deep</p></li></ul></li></ul>');

  // Only the line reading "one". It is that item's first block, and the item
  // holds a sub-list, so it cannot give that block up on its own — the whole
  // item's content comes out together.
  await page.locator(`${EDITOR} p`).first().click();
  await page.keyboard.press(`${MOD}+a`);
  await expect(page.getByTestId(SLOT)).toBeVisible({ timeout: 10_000 });
  await openBlockTypeMenu(page);
  expect(await greyedRows(page)).toEqual(['task-list']);

  await page.getByTestId(`${SLOT}-item-heading-1`).click();
  await expect
    .poll(async () => bodyHtml(page), { timeout: 10_000 })
    .toBe('<h1>one</h1><ul><li><p>deep</p></li></ul>');
});

/** One selection: how to type it, how to (re)select it, which rows it greys. */
interface SelectionShape {
  name: string;
  /** Type the body. Done once. */
  type: (p: Page) => Promise<void>;
  /** Put the selection back, which every undo needs again. */
  select: (p: Page) => Promise<void>;
  /** The rows expected greyed, in the order the menu draws them. */
  grey: string[];
}

/** The eight chords, one per row of `document-block-type-shortcuts.ts`. */
const CHORDS: Array<[id: string, chord: string]> = [
  ['paragraph', `${MOD}+Alt+0`],
  ['heading-1', `${MOD}+Alt+1`],
  ['heading-2', `${MOD}+Alt+2`],
  ['heading-3', `${MOD}+Alt+3`],
  ['bullet-list', `${MOD}+Shift+8`],
  ['ordered-list', `${MOD}+Shift+7`],
  ['code-block', `${MOD}+Alt+c`],
  ['quote', `${MOD}+Shift+b`],
];

/** The nine rows, in the order the menu draws them. */
const NINE_ROWS = [
  'paragraph', 'heading-1', 'heading-2', 'heading-3',
  'bullet-list', 'ordered-list', 'task-list', 'code-block', 'quote',
];

/**
 * Take one block: click it, then one Cmd+A, whose first tier is that block.
 * @param p - The page.
 * @param selector - That block's selector.
 */
async function selectBlockAt(p: Page, selector: string): Promise<void> {
  await p.locator(selector).first().click();
  await p.keyboard.press(`${MOD}+a`);
  await expect(p.getByTestId(SLOT)).toBeVisible({ timeout: 10_000 });
}

const SHAPES: SelectionShape[] = [
  {
    name: 'a plain paragraph',
    type: async (p) => { await p.keyboard.type('plain line'); },
    select: async (p) => { await selectBlockAt(p, `${EDITOR} > p`); },
    grey: ['task-list'],
  },
  {
    name: 'a line inside a quote',
    type: async (p) => {
      await p.keyboard.type('quoted line');
      await p.keyboard.press(`${MOD}+a`);
      await p.keyboard.press(`${MOD}+Shift+b`);
    },
    select: async (p) => { await selectBlockAt(p, `${EDITOR} blockquote p`); },
    grey: ['task-list'],
  },
  {
    name: 'a list item',
    type: async (p) => { await p.keyboard.type('- an item'); },
    select: async (p) => { await selectBlockAt(p, `${EDITOR} li p`); },
    grey: ['task-list'],
  },
  {
    name: 'a list inside a quote',
    type: async (p) => {
      await p.keyboard.type('- quoted item');
      await p.keyboard.press(`${MOD}+a`);
      await p.keyboard.press(`${MOD}+Shift+b`);
    },
    select: async (p) => { await selectBlockAt(p, `${EDITOR} blockquote li p`); },
    grey: ['task-list'],
  },
  {
    name: 'a selection across two blocks',
    type: async (p) => {
      await p.keyboard.type('first line');
      await p.keyboard.press('Enter');
      await p.keyboard.type('second line');
    },
    select: async (p) => {
      // A real drag from the first block to the last, so both are in the
      // selection and it is not a select-all. Shift+ArrowDown does not hold
      // here: inside a code block that keystroke moves within the block, which
      // leaves the selection in one block.
      const first = await p.locator(`${EDITOR} > *`).first().boundingBox();
      const last = await p.locator(`${EDITOR} > *`).last().boundingBox();
      if (!first || !last) throw new Error('both blocks have to be measurable');
      await p.mouse.move(first.x + 2, first.y + first.height / 2);
      await p.mouse.down();
      await p.mouse.move(last.x + last.width - 2, last.y + last.height / 2, { steps: 8 });
      await p.mouse.up();
      await expect(p.getByTestId(SLOT)).toBeVisible({ timeout: 10_000 });
    },
    grey: ['task-list'],
  },
  {
    name: 'two presses of Cmd+A',
    type: async (p) => {
      await p.keyboard.type('lead');
      await p.keyboard.press('Enter');
      await p.keyboard.type('- one');
      await p.keyboard.press('Enter');
      await p.keyboard.press('Tab');
      await p.keyboard.type('deep');
    },
    select: async (p) => {
      await p.locator(`${EDITOR} > *`).first().click();
      // The first tier takes the block, the second the body
      // (`select-all-tiers-and-keys`).
      await p.keyboard.press(`${MOD}+a`);
      await p.keyboard.press(`${MOD}+a`);
      await expect(p.getByTestId(SLOT)).toBeVisible({ timeout: 10_000 });
    },
    grey: ['task-list'],
  },
];

/**
 * The rows the open menu ticks.
 * @param p - The page.
 * @returns Their ids.
 */
async function tickedRows(p: Page): Promise<string[]> {
  return p.evaluate((slot) => {
    const ticks = document.querySelectorAll(`[data-testid^="${slot}-tick-"]`);
    return Array.from(ticks)
      .map((t) => t.getAttribute('data-testid')?.replace(`${slot}-tick-`, '') ?? '');
  }, SLOT);
}

// The checklist wants all nine rows pressed and all eight chords held on each
// of six selections. What each cell produces is pinned by the unit tests; what
// is asked here is whether the real path runs: a real pointer opening the menu,
// a real row taking the click, a real keystroke reaching the same command. One
// undo returns to the start, so every cell begins on the same document — which
// walks A31, one press one transaction, over all six as well.
//
// Two kinds of "nothing moved" are right and everything else is a problem: a
// greyed row, and a ticked Text row, whose target is the state the blocks are
// already in (the exception in §6.7).
for (const shape of SHAPES) {
  test(`${shape.name}: nine rows pressed and eight chords held`, async () => {
    // Seventeen cells, each of them reselecting, opening, pressing, undoing.
    test.setTimeout(180_000);
    await openFreshDocument(page);
    await shape.type(page);
    await shape.select(page);
    const start = await bodyHtml(page);

    await openBlockTypeMenu(page);
    expect(await greyedRows(page), `${shape.name}: greyed rows`).toEqual(shape.grey);
    const alreadyText = (await tickedRows(page)).includes('paragraph');
    await page.keyboard.press('Escape');

    /** Whether pressing this row should move the document. */
    const moves = (id: string): boolean =>
      !shape.grey.includes(id) && !(id === 'paragraph' && alreadyText);

    for (const id of NINE_ROWS) {
      await shape.select(page);
      await openBlockTypeMenu(page);
      // A greyed row carries `cursor-not-allowed`, which playwright's
      // actionability check will not pass, and what is asked here is what a
      // real press does — so it presses anyway.
      await page.getByTestId(`${SLOT}-item-${id}`).click({ force: true });
      if (!moves(id)) {
        expect(await bodyHtml(page), `${shape.name}: ${id} moved the document`).toBe(start);
        continue;
      }
      await expect
        .poll(async () => bodyHtml(page), { timeout: 10_000 })
        .not.toBe(start);
      await page.keyboard.press(`${MOD}+z`);
      await expect
        .poll(async () => bodyHtml(page), { timeout: 10_000 })
        .toBe(start);
    }

    for (const [id, chord] of CHORDS) {
      await shape.select(page);
      await page.keyboard.press(chord);
      if (!moves(id)) {
        expect(await bodyHtml(page), `${shape.name}: ${chord} moved the document`).toBe(start);
        continue;
      }
      await expect
        .poll(async () => bodyHtml(page), { timeout: 10_000 })
        .not.toBe(start);
      await page.keyboard.press(`${MOD}+z`);
      await expect
        .poll(async () => bodyHtml(page), { timeout: 10_000 })
        .toBe(start);
    }
  });
}
