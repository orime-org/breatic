// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Quoting greys a coloured run down, words and fill together.
 *
 * A quote states that the words belong to someone else, and it says so by
 * stepping the text back to `--color-muted-foreground`. Plain text follows
 * that by inheritance. A coloured run carries its own `color` on the inline
 * span and a fill its own `background-color`, so neither was reached — a
 * quoted line could hold full-strength red words, and a filled one put grey
 * words on a full-strength blue (measured before this: red stayed
 * rgb(220, 62, 66) on both sides of quoting).
 *
 * The hue now mixes 55% of that same grey in (user 2026-09-19, from the four
 * depths in `2026-09-19-1002-quote-grey-depth.html`), and the fill is built
 * from the greyed hue at the 30% it already had.
 *
 * Both expectations are resolved from the tokens on the page rather than
 * written out here, so this measures the rule and not a copy of its numbers.
 *
 * Needs dev running plus a smoke account:
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { createSpace, deleteSpace } from './helpers/space';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');
test.describe.configure({ mode: 'serial' });

const EDITOR = '[data-testid="document-space"] .ProseMirror';
const BLOCK = `${EDITOR} .bn-block-content`;
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const COLOURED = 'coloured words';
const FILLED = 'filled words';

let page: Page;
let spaceId = '';

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  await page.goto('/login');
  await page.locator('#login-email').fill(email as string);
  await page.locator('#login-password').fill(password as string);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/(studio|project)/, { timeout: 15_000 });

  await page.goto('/studio');
  const first = page.locator('a[href^="/project/"]').first();
  await expect(first).toBeVisible({ timeout: 15_000 });
  await first.click();
  await page.waitForURL(/\/project\//, { timeout: 15_000 });
  spaceId = await createSpace(page, 'document', `quotecolour-${Date.now()}`);

  const editor = page.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('new-space-button')).toBeFocused();
  await editor.click();

  await page.keyboard.type(COLOURED);
  await page.keyboard.press('Enter');
  await page.keyboard.type(FILLED);
  await page.waitForTimeout(400);

  await colourLine(COLOURED, 'text', 'red');
  await colourLine(FILLED, 'fill', 'blue');
});

test.afterAll(async () => {
  test.setTimeout(60_000);
  if (spaceId) await deleteSpace(page, spaceId);
  await page?.close();
});

/** The block holding one line. */
function lineOf(text: string) {
  return page.locator(BLOCK).filter({ hasText: text }).last();
}

/**
 * Puts the caret in one line with the bubble bar out of the way.
 * @param text - That line's text.
 */
async function caretIn(text: string): Promise<void> {
  // A selection keeps the bar over the body, and it takes the next press.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await lineOf(text).click({ position: { x: 6, y: 10 } });
}

/**
 * Colours one whole line through the bubble bar's colour panel.
 * @param text - That line's text.
 * @param kind - The panel's row, `text` or `fill`.
 * @param hue - Which of the seven.
 * @throws {Error} When the panel or the cell never appears.
 */
async function colourLine(
  text: string,
  kind: 'text' | 'fill',
  hue: string,
): Promise<void> {
  await caretIn(text);
  await page.keyboard.press(`${MOD}+a`);
  const slot = page.getByTestId('doc-bubble-color');
  await expect(slot).toBeVisible({ timeout: 10_000 });
  await slot.hover();
  const cell = page.getByTestId(`doc-bubble-color-${kind}-${hue}`);
  await expect(cell).toBeVisible({ timeout: 10_000 });
  await cell.click();
  await page.waitForTimeout(250);
}

/** Turns the line the caret is on into a quote. */
async function quoteLine(text: string): Promise<void> {
  await caretIn(text);
  await page.keyboard.press(`${MOD}+a`);
  const slot = page.getByTestId('doc-bubble-block-type');
  await expect(slot).toBeVisible({ timeout: 10_000 });
  await slot.hover();
  const row = page.getByTestId('doc-bubble-block-type-item-quote');
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await page.waitForTimeout(350);
}

/**
 * What one CSS colour expression resolves to on this page.
 *
 * Asked of a throwaway element inside the body, so the tokens it names are
 * the ones the body itself reads, in whichever theme is on.
 * @param expression - Any value `color` accepts.
 * @returns The computed colour.
 */
async function resolved(expression: string): Promise<string> {
  return page.evaluate(
    ({ sel, expression }) => {
      const probe = document.createElement('span');
      probe.style.color = expression;
      document.querySelector(sel)!.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    },
    { sel: EDITOR, expression },
  );
}

/**
 * The painted colours of one line's coloured span.
 * @param text - That line's text.
 */
async function paintOf(
  text: string,
): Promise<{ quoted: string | null; colour: string; fill: string }> {
  return lineOf(text).evaluate((block: HTMLElement) => {
    const span = block.querySelector('[data-style-type]') as HTMLElement;
    const style = getComputedStyle(span);
    return {
      quoted: block.getAttribute('data-quoted'),
      colour: style.color,
      fill: style.backgroundColor,
    };
  });
}

const GREYED_RED =
  'color-mix(in srgb, var(--color-muted-foreground) 55%, var(--color-palette-red))';
const GREYED_BLUE_FILL =
  'color-mix(in srgb, color-mix(in srgb, var(--color-muted-foreground) 55%,'
  + ' var(--color-palette-blue)) 30%, transparent)';

test('leaves a coloured run at its own hue outside a quote', async () => {
  const paint = await paintOf(COLOURED);
  expect(paint.quoted).toBeNull();
  expect(paint.colour).toBe(await resolved('var(--color-palette-red)'));
});

test('greys a coloured run down inside a quote', async () => {
  await quoteLine(COLOURED);
  const paint = await paintOf(COLOURED);
  expect(paint.quoted).toBe('true');
  expect(paint.colour).toBe(await resolved(GREYED_RED));
});

test('leaves a fill at its own depth outside a quote', async () => {
  const paint = await paintOf(FILLED);
  expect(paint.quoted).toBeNull();
  expect(paint.fill).toBe(
    await resolved('var(--color-palette-blue-highlight)'),
  );
});

test('greys a fill down inside a quote', async () => {
  await quoteLine(FILLED);
  const paint = await paintOf(FILLED);
  expect(paint.quoted).toBe('true');
  expect(paint.fill).toBe(await resolved(GREYED_BLUE_FILL));
});
