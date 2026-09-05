// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The block type menu end to end (task #904).
 *
 * The half jsdom cannot reach: the nine chords really held down, the menu
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
 * The body as one line per block: its type, its quote, its indent, its text.
 *
 * The editor's markup is not this shape. A block sits inside three wrappers,
 * each carrying an id generated per block, so comparing the HTML would compare
 * ids that differ on every run. What every case here is about is which type a
 * block ended up as and whether it stayed inside the quote, and the editor
 * states both on the content element — `data-content-type`, plus `data-level`
 * for a heading past the first and `data-quoted` for a quoted one.
 * @param p - The page.
 * @returns One line per block, indented two spaces per level of nesting.
 */
async function bodyShape(p: Page): Promise<string> {
  return p.evaluate((sel) => {
    const root = document.querySelector(sel)!;
    return [...root.querySelectorAll('.bn-block-content')]
      .map((element) => {
        const type = element.getAttribute('data-content-type') ?? '?';
        // The first level is the one every block sits in, so it is not indent.
        let depth = -1;
        for (let at = element.parentElement; at !== null; at = at.parentElement) {
          if (at === root) break;
          if (at.classList.contains('bn-block-group')) depth += 1;
        }
        const level = element.getAttribute('data-level');
        const named = type === 'heading' ? `heading${level ?? '1'}` : type;
        const quoted = element.hasAttribute('data-quoted') ? '[quoted]' : '';
        return `${'  '.repeat(Math.max(depth, 0))}${named}${quoted} ${element.textContent ?? ''}`;
      })
      .join('\n');
  }, EDITOR);
}

/**
 * Click a block and wait until the caret is really inside it.
 *
 * A click hands the editor a selection asynchronously, and `Mod-a`'s first
 * tier takes whichever textblock the caret is in AT THAT MOMENT
 * (`document-select-all-guard.ts:117`). Pressing the chord in the same turn as
 * the click therefore selects the block the caret was in beforehand — measured
 * on a list item holding a sub-list, where the run ended in the child and the
 * press then landed there rather than on the clicked parent.
 * @param p - The page.
 * @param selector - Which block content to click.
 */
async function clickIntoBlock(p: Page, selector: string): Promise<void> {
  const target = p.locator(selector).first();
  const text = ((await target.textContent()) ?? '').trim();
  // Landed at the block's leading edge rather than its middle. A click inside
  // text that is already taken leaves the range as it is — measured, ten
  // seconds of it, and a key pressed first goes to the menu that owns the
  // focus. The edge is outside the range, so the click places a caret.
  await target.click({ position: { x: 1, y: 4 } });
  await expect
    .poll(
      async () =>
        p.evaluate(() => {
          const selection = document.getSelection();
          const node = selection?.anchorNode ?? null;
          const element =
            node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element | null);
          const block = element?.closest('.bn-block-content')?.textContent?.trim() ?? '';
          return `${selection?.isCollapsed === true ? 'caret' : 'range'} in ${block}`;
        }),
      { timeout: 10_000 },
    )
    .toBe(`caret in ${text}`);
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

  const line = 'a line the menu will work on';
  const expected: Array<[id: string, shape: string]> = [
    ['heading-1', `heading1 ${line}`],
    ['heading-2', `heading2 ${line}`],
    ['heading-3', `heading3 ${line}`],
    ['bullet-list', `bulletListItem ${line}`],
    ['ordered-list', `numberedListItem ${line}`],
    ['code-block', `codeBlock ${line}`],
    ['paragraph', `paragraph ${line}`],
    ['quote', `paragraph[quoted] ${line}`],
  ];

  for (const [id, shape] of expected) {
    await openBlockTypeMenu(page);
    await page.getByTestId(`${SLOT}-item-${id}`).click();
    await expect
      .poll(async () => bodyShape(page), { timeout: 10_000 })
      .toBe(shape);
  }

  // The ninth row is the task list, which this editor brings with it (A3).
  await openBlockTypeMenu(page);
  await expect(page.getByTestId(`${SLOT}-item-task-list`)).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.getByTestId(`${SLOT}-item-task-list`).click();
  // Quote was the last row pressed above, and a quote is a prop rather than a
  // container here, so changing the type leaves the block inside it.
  await expect
    .poll(async () => bodyShape(page), { timeout: 10_000 })
    .toBe(`checkListItem[quoted] ${line}`);
});

test('holds each of the nine chords and lands where the row does', async () => {
  await openFreshDocument(page);
  await typeAndSelectLine(page, 'a line the keys will work on');

  const line = 'a line the keys will work on';
  const chords: Array<[chord: string, shape: string]> = [
    [`${MOD}+Alt+1`, `heading1 ${line}`],
    [`${MOD}+Alt+2`, `heading2 ${line}`],
    [`${MOD}+Alt+3`, `heading3 ${line}`],
    [`${MOD}+Shift+8`, `bulletListItem ${line}`],
    [`${MOD}+Shift+7`, `numberedListItem ${line}`],
    [`${MOD}+Alt+c`, `codeBlock ${line}`],
    [`${MOD}+Alt+0`, `paragraph ${line}`],
    [`${MOD}+Shift+b`, `paragraph[quoted] ${line}`],
  ];

  for (const [chord, shape] of chords) {
    await page.keyboard.press(chord);
    await expect.poll(async () => bodyShape(page), { timeout: 10_000 }).toBe(shape);
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
    .poll(async () => bodyShape(page), { timeout: 10_000 })
    .toBe('bulletListItem[quoted] quoted list item');

  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+Alt+1`);
  await expect
    .poll(async () => bodyShape(page), { timeout: 10_000 })
    .toBe('heading1[quoted] quoted list item');

  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+Shift+b`);
  await expect
    .poll(async () => bodyShape(page), { timeout: 10_000 })
    .toBe('heading1 quoted list item');
});

test('draws the tick right of the chord and a rule at each group boundary', async () => {
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
    const rows = ['task-list', 'ordered-list', 'quote'].map((id) => ({
      id,
      top: rect(`${slot}-item-${id}`)?.top ?? null,
      bottom: rect(`${slot}-item-${id}`)?.bottom ?? null,
    }));
    const rules = [
      ...document.querySelectorAll(
        `[data-testid="${slot}-menu"] [data-testid="doc-bubble-rule"]`,
      ),
    ].map((element) => element.getBoundingClientRect().top);
    return {
      tickLeft: tick?.left ?? null,
      shortcutRight: shortcut?.right ?? null,
      sameRow: shortcut && tick
        ? Math.abs((shortcut.top + shortcut.height / 2) - (tick.top + tick.height / 2)) < 4
        : false,
      rules,
      rows,
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

  // The two rules fall where the three groups meet (§3.1 / A2): after the
  // seven that set the block's type, and after Ordered. Pinned where they
  // fall rather than by a pair of comparisons that hold for more than one
  // arrangement — "some rule between Code block and Quote" was satisfied by
  // both rules side by side, or by the type group split in half.
  expect(geometry.rules).toHaveLength(2);
  const [afterTypes, afterOrdered] = geometry.rules as [number, number];
  const row = (id: string): { top: number; bottom: number } => {
    const found = geometry.rows.find((each) => each.id === id);
    return { top: found?.top as number, bottom: found?.bottom as number };
  };
  expect(afterTypes).toBeGreaterThanOrEqual(row('task-list').bottom);
  expect(afterTypes).toBeLessThanOrEqual(row('ordered-list').top);
  expect(afterOrdered).toBeGreaterThanOrEqual(row('ordered-list').bottom);
  expect(afterOrdered).toBeLessThanOrEqual(row('quote').top);

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

test('a body holding an indented list lights every row, the task list with it', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('lead');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- one');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('deep');
  await expect
    .poll(async () => bodyShape(page), { timeout: 10_000 })
    .toBe(['paragraph lead', 'bulletListItem one', '  bulletListItem deep'].join('\n'));

  // Select-all has two tiers: the block, then the body (`select-all-tiers-and-keys`).
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+a`);
  await expect(page.getByTestId(SLOT)).toBeVisible({ timeout: 10_000 });
  await openBlockTypeMenu(page);
  expect(await greyedRows(page)).toEqual([]);

  await page.getByTestId(`${SLOT}-item-heading-1`).click();
  await expect
    .poll(async () => bodyShape(page), { timeout: 10_000 })
    .toBe(['heading1 lead', 'heading1 one', '  heading1 deep'].join('\n'));
});

test('an item opening a sub-list is reachable from its first line alone', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('- one');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('deep');
  await expect
    .poll(async () => bodyShape(page), { timeout: 10_000 })
    .toBe(['bulletListItem one', '  bulletListItem deep'].join('\n'));

  // Only the line reading "one". It is that item's first block, and the item
  // holds a sub-list, so it cannot give that block up on its own — the whole
  // item's content comes out together.
  await clickIntoBlock(page, `${EDITOR} .bn-block-content`);
  await page.keyboard.press(`${MOD}+a`);
  await expect(page.getByTestId(SLOT)).toBeVisible({ timeout: 10_000 });
  await openBlockTypeMenu(page);
  expect(await greyedRows(page)).toEqual([]);

  await page.getByTestId(`${SLOT}-item-heading-1`).click();
  await expect
    .poll(async () => bodyShape(page), { timeout: 10_000 })
    .toBe(['heading1 one', '  bulletListItem deep'].join('\n'));
});

/** One selection: how to type it and how to put it back. */
interface SelectionShape {
  name: string;
  /** Type the body. Done once. */
  type: (p: Page) => Promise<void>;
  /** Put the selection back, which every undo needs again. */
  select: (p: Page) => Promise<void>;
}

/** The nine chords, one per row of `document-block-type-shortcuts.ts`. */
const CHORDS: Array<[id: string, chord: string]> = [
  ['paragraph', `${MOD}+Alt+0`],
  ['heading-1', `${MOD}+Alt+1`],
  ['heading-2', `${MOD}+Alt+2`],
  ['heading-3', `${MOD}+Alt+3`],
  ['bullet-list', `${MOD}+Shift+8`],
  ['ordered-list', `${MOD}+Shift+7`],
  ['task-list', `${MOD}+Shift+9`],
  ['code-block', `${MOD}+Alt+c`],
  ['quote', `${MOD}+Shift+b`],
];

/** The nine rows, in the order the menu draws them. */
const NINE_ROWS = [
  'paragraph', 'heading-1', 'heading-2', 'heading-3',
  'bullet-list', 'ordered-list', 'task-list', 'code-block', 'quote',
];

/**
 * Take one block: click into it, collapse, then the Cmd+A whose first tier it
 * is.
 *
 * The collapse is what makes the cells repeatable. `Mod-a` reads the selection
 * it is pressed on: over a caret it takes the block, and over a block already
 * taken whole it goes up to the document (`document-select-all-guard.ts:117`).
 * A cell that reselects while the previous cell's range is still in place gets
 * the second tier, and the bar the cells drive is not drawn over that.
 * @param p - The page.
 * @param selector - That block's selector.
 */
async function selectBlockAt(p: Page, selector: string): Promise<void> {
  await clickIntoBlock(p, selector);
  await barGone(p);
  await p.keyboard.press(`${MOD}+a`);
  await expect(p.getByTestId(SLOT)).toBeVisible({ timeout: 10_000 });
}

/**
 * Wait until the editor has read the caret back from the browser.
 *
 * A selection reaches the browser before the editor reads it, and everything
 * a cell does next asks the EDITOR what is selected. Acting too early gets the
 * range the previous cell left: `Mod-a` calls it the first tier already taken
 * and goes up to the document, and a menu row runs against blocks the reader
 * is no longer on. The bar is drawn from the editor's own selection, so its
 * leaving is the editor saying the range is gone.
 * @param p - The page.
 */
async function barGone(p: Page): Promise<void> {
  await expect(p.getByTestId(SLOT)).toBeHidden({ timeout: 10_000 });
}

/**
 * Put the caret where the selection starts, and wait for the editor to have it.
 *
 * By key rather than by click: the bar sits over the selection it belongs to,
 * and a click aimed at the block under it is refused as intercepted — measured,
 * three minutes of retries.
 * @param p - The page.
 */
async function collapseSelection(p: Page): Promise<void> {
  await p.keyboard.press('ArrowLeft');
  await barGone(p);
}

const SHAPES: SelectionShape[] = [
  {
    name: 'a plain paragraph',
    type: async (p) => { await p.keyboard.type('plain line'); },
    select: async (p) => { await selectBlockAt(p, `${EDITOR} [data-content-type="paragraph"]`); },
  },
  {
    name: 'a line inside a quote',
    type: async (p) => {
      await p.keyboard.type('quoted line');
      await p.keyboard.press(`${MOD}+a`);
      await p.keyboard.press(`${MOD}+Shift+b`);
    },
    select: async (p) => { await selectBlockAt(p, `${EDITOR} [data-content-type="paragraph"][data-quoted]`); },
  },
  {
    name: 'a list item',
    type: async (p) => { await p.keyboard.type('- an item'); },
    select: async (p) => { await selectBlockAt(p, `${EDITOR} [data-content-type="bulletListItem"]`); },
  },
  {
    name: 'a list inside a quote',
    type: async (p) => {
      await p.keyboard.type('- quoted item');
      await p.keyboard.press(`${MOD}+a`);
      await p.keyboard.press(`${MOD}+Shift+b`);
    },
    select: async (p) => { await selectBlockAt(p, `${EDITOR} [data-content-type="bulletListItem"][data-quoted]`); },
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
      await collapseSelection(p);
      const first = await p.locator(`${EDITOR} .bn-block-content`).first().boundingBox();
      const last = await p.locator(`${EDITOR} .bn-block-content`).last().boundingBox();
      if (!first || !last) throw new Error('both blocks have to be measurable');
      await p.mouse.move(first.x + 2, first.y + first.height / 2);
      await p.mouse.down();
      await p.mouse.move(last.x + last.width - 2, last.y + last.height / 2, { steps: 8 });
      await p.mouse.up();
      await expect(p.getByTestId(SLOT)).toBeVisible({ timeout: 10_000 });
    },
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
      await collapseSelection(p);
      await p.locator(`${EDITOR} .bn-block-content`).first().click();
      // The first tier takes the block, the second the body
      // (`select-all-tiers-and-keys`).
      await p.keyboard.press(`${MOD}+a`);
      await p.keyboard.press(`${MOD}+a`);
      await expect(p.getByTestId(SLOT)).toBeVisible({ timeout: 10_000 });
    },
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

// The checklist wants all nine rows pressed and all nine chords held on each
// of six selections. What each cell produces is pinned by the unit tests; what
// is asked here is whether the real path runs: a real pointer opening the menu,
// a real row taking the click, a real keystroke reaching the same command. One
// undo returns to the start, so every cell begins on the same document — which
// walks "one press, one transaction" over all six as well.
//
// One kind of "nothing moved" is right and everything else is a problem: a
// ticked Text row, whose target is the state the blocks are already in (the
// exception in §6.7).
for (const shape of SHAPES) {
  test(`${shape.name}: nine rows pressed and nine chords held`, async () => {
    // Seventeen cells, each of them reselecting, opening, pressing, undoing.
    test.setTimeout(180_000);
    await openFreshDocument(page);
    await shape.type(page);
    // Y.UndoManager merges a change into the item before it when the two are
    // under `captureTimeout` apart (`yjs.cjs:3690`, 500 ms by default). The
    // typing above and the press below are one undo step without this pause,
    // and the undo each cell ends with then takes the text away with the type.
    await page.waitForTimeout(700);
    await shape.select(page);
    const start = await bodyShape(page);

    await openBlockTypeMenu(page);
    // Every row acts on a text block, the task list with them (A3, A19).
    expect(await greyedRows(page), `${shape.name}: greyed rows`).toEqual([]);
    const alreadyText = (await tickedRows(page)).includes('paragraph');
    await page.keyboard.press('Escape');

    /** Whether pressing this row should move the document. */
    const moves = (id: string): boolean =>
      !(id === 'paragraph' && alreadyText);

    for (const id of NINE_ROWS) {
      await shape.select(page);
      await openBlockTypeMenu(page);
      // A greyed row carries `cursor-not-allowed`, which playwright's
      // actionability check will not pass, and what is asked here is what a
      // real press does — so it presses anyway.
      await page.getByTestId(`${SLOT}-item-${id}`).click({ force: true });
      if (!moves(id)) {
        expect(await bodyShape(page), `${shape.name}: ${id} moved the document`).toBe(start);
        continue;
      }
      await expect
        .poll(async () => bodyShape(page), { timeout: 10_000 })
        .not.toBe(start);
      await page.keyboard.press(`${MOD}+z`);
      await expect
        .poll(async () => bodyShape(page), {
          timeout: 10_000,
          message: `${shape.name}: undo after ${id}`,
        })
        .toBe(start);
    }

    for (const [id, chord] of CHORDS) {
      await shape.select(page);
      await page.keyboard.press(chord);
      if (!moves(id)) {
        expect(await bodyShape(page), `${shape.name}: ${chord} moved the document`).toBe(start);
        continue;
      }
      await expect
        .poll(async () => bodyShape(page), { timeout: 10_000 })
        .not.toBe(start);
      await page.keyboard.press(`${MOD}+z`);
      await expect
        .poll(async () => bodyShape(page), { timeout: 10_000 })
        .toBe(start);
    }
  });
}
