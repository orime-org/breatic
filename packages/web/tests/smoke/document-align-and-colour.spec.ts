// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #905 验收 A1 · A4 · A5 · A6 · A8: the two slots, used the way a reader uses
 * them.
 *
 * A6 is why this file exists rather than only the jsdom cases. What a coloured
 * run of text comes out as is decided in the cascade between BlockNote's own
 * stylesheet — which paints five of our seven hue names in Notion's hex — and
 * the rules written over it, and only a browser resolves that. The jsdom side
 * asserts the rules are there and unlayered; here the text is read for the
 * colour it actually took, in both themes.
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
const ALIGN = 'doc-bubble-align';
const COLOUR = 'doc-bubble-color';

/** The seven hues the panel offers. */
const PALETTE = [
  'red',
  'orange',
  'green',
  'blue',
  'violet',
  'pink',
  'teal',
] as const;

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

  createdSpaceIds.push(await createSpace(p, 'document', `colour-${Date.now()}`));

  const editor = p.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await expect(p.getByTestId('new-space-button')).toBeFocused();
  await editor.click();
  await expect(editor).toBeFocused();
}

/**
 * Selects the line the caret is on, and waits for the bar.
 *
 * Home to End rather than select-all: a fresh Space opens with an empty
 * paragraph after the one being typed into, and select-all covers both. Two
 * blocks whose alignment differs is exactly the case where no row reads as
 * active, so an assertion about the active row has to be about one line.
 * @param p - The page.
 * @param slot - Which slot to wait for.
 */
async function selectTheLine(p: Page, slot: string): Promise<void> {
  await p.keyboard.press('End');
  await p.keyboard.press('Shift+Home');
  await expect(p.getByTestId(slot)).toBeVisible({ timeout: 10_000 });
}

/**
 * Types a line and selects it, so the bar is on screen.
 * @param p - The page.
 * @param text - What to type.
 * @param slot - Which slot to wait for.
 */
async function typeAndSelect(
  p: Page,
  text: string,
  slot: string,
): Promise<void> {
  await p.keyboard.type(text);
  await selectTheLine(p, slot);
}

/**
 * Moves the pointer onto a slot and waits for its menu.
 * @param p - The page.
 * @param slot - Which slot.
 */
async function openSlot(p: Page, slot: string): Promise<void> {
  await p.getByTestId(slot).hover();
  await expect(p.getByTestId(`${slot}-menu`)).toBeVisible({ timeout: 10_000 });
}

/**
 * Selects the line again, since a press closes the menu and leaves a caret.
 * @param p - The page.
 * @param slot - Which slot to wait for.
 */
async function reselect(p: Page, slot: string): Promise<void> {
  await p.locator(`${EDITOR} .bn-block-content`).first().click();
  await selectTheLine(p, slot);
}

/**
 * How the first block's text is laid out and painted.
 * @param p - The page.
 * @returns The block's text-align, and the colour and background of the run
 *   inside it.
 */
async function firstRun(p: Page): Promise<{
  align: string;
  colour: string;
  background: string;
}> {
  return p.evaluate((sel) => {
    const block = document.querySelector(`${sel} .bn-block-content`)!;
    // Two styles at once nest, one span inside the other, so each is read off
    // its own element rather than off whichever came first.
    const coloured = block.querySelector('[data-style-type="textColor"]');
    const filled = block.querySelector('[data-style-type="backgroundColor"]');
    return {
      align: getComputedStyle(block).textAlign,
      colour: getComputedStyle(coloured ?? block).color,
      background: getComputedStyle(filled ?? block).backgroundColor,
    };
  }, EDITOR);
}

/**
 * The palette token's value in the theme now on screen.
 * @param p - The page.
 * @param name - The token, without the `--` prefix.
 * @returns Its computed colour, as `rgb(...)`.
 */
async function tokenColour(p: Page, name: string): Promise<string> {
  return p.evaluate((token) => {
    const probe = document.createElement('span');
    probe.style.color = `var(--${token})`;
    document.body.appendChild(probe);
    const seen = getComputedStyle(probe).color;
    probe.remove();
    return seen;
  }, name);
}

/**
 * Puts the page into one theme.
 *
 * The class on the root element is what the tokens switch on, and it is what
 * the theme store sets. Written here directly rather than through the store,
 * whose persisted shape this file would then have to know.
 * @param p - The page.
 * @param theme - Which one.
 */
async function setTheme(p: Page, theme: 'light' | 'dark'): Promise<void> {
  await p.evaluate((next) => {
    document.documentElement.classList.toggle('dark', next === 'dark');
  }, theme);
  await expect
    .poll(async () =>
      p.evaluate(() => document.documentElement.classList.contains('dark')),
    )
    .toBe(theme === 'dark');
}

test('aligns the line the reader selected, and draws the row it is on', async () => {
  await openFreshDocument(page);
  await typeAndSelect(page, 'a line to move about', ALIGN);

  // `left` is the prop's own default, and BlockNote writes no attribute for a
  // default — so the block carries no `text-align` and the computed value is
  // the initial one. Which is left, drawn the same way; what changes is only
  // what the property reads as.
  for (const [row, painted] of [
    ['center', 'center'],
    ['right', 'right'],
    ['left', 'start'],
  ] as const) {
    await openSlot(page, ALIGN);
    await page.getByTestId(`${ALIGN}-item-${row}`).click();
    await expect.poll(async () => (await firstRun(page)).align).toBe(painted);

    // The row the menu draws as active is the row the line is now on. The
    // selection is still over the line — a press puts it back — so the bar is
    // still up and the menu can be opened again where it stands.
    await openSlot(page, ALIGN);
    await expect(page.getByTestId(`${ALIGN}-item-${row}`)).toHaveAttribute(
      'data-active',
      'true',
    );
  }
});

test('paints each hue from the palette, in both themes', async () => {
  await openFreshDocument(page);
  await typeAndSelect(page, 'words that take a colour', COLOUR);

  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    for (const hue of PALETTE) {
      await reselect(page, COLOUR);
      await openSlot(page, COLOUR);
      await page.getByTestId(`${COLOUR}-text-${hue}`).click();

      const wanted = await tokenColour(page, `color-palette-${hue}`);
      await expect
        .poll(async () => (await firstRun(page)).colour, { timeout: 10_000 })
        .toBe(wanted);
    }
  }
});

test('fills each hue from the palette tint', async () => {
  await openFreshDocument(page);
  await typeAndSelect(page, 'words that take a fill', COLOUR);

  for (const hue of PALETTE) {
    await reselect(page, COLOUR);
    await openSlot(page, COLOUR);
    await page.getByTestId(`${COLOUR}-fill-${hue}`).click();

    const wanted = await tokenColour(page, `color-palette-${hue}-bg`);
    await expect
      .poll(async () => (await firstRun(page)).background, { timeout: 10_000 })
      .toBe(wanted);
  }
});

test('takes both colours off from the reset button', async () => {
  await openFreshDocument(page);
  await typeAndSelect(page, 'words to strip again', COLOUR);

  await openSlot(page, COLOUR);
  await page.getByTestId(`${COLOUR}-text-violet`).click();
  await reselect(page, COLOUR);
  await openSlot(page, COLOUR);
  await page.getByTestId(`${COLOUR}-fill-teal`).click();
  await reselect(page, COLOUR);
  // Both are on, so the reset has something to take off.
  await expect
    .poll(async () => (await firstRun(page)).background)
    .not.toBe('rgba(0, 0, 0, 0)');

  await openSlot(page, COLOUR);
  await page.getByTestId(`${COLOUR}-reset`).click();

  await expect
    .poll(async () =>
      page.evaluate(
        (sel) =>
          document.querySelectorAll(`${sel} [data-style-type]`).length,
        EDITOR,
      ),
    )
    .toBe(0);
});
