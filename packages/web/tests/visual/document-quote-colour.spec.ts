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
 * What each case reads is one run's own computed colour, which is one part's
 * own appearance — so these live in the visual tier.
 *
 *   pnpm --filter @breatic/web test:visual
 */
import { test, expect, type Page } from 'playwright/test';

import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace } from '../helpers/space';

const EDITOR = '[data-testid="document-space"] .ProseMirror';
const BLOCK = `${EDITOR} .bn-block-content`;
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const COLOURED = 'coloured words';
const FILLED = 'filled words';

let page: Page;
let spaceId = '';

// Each case builds the two coloured lines it reads: one of them quotes a line,
// and a case sharing that document with the next would hand it a line already
// quoted.
test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  await openSmokeProject(page);
  spaceId = await createSpace(page, 'document', `quotecolour-${Date.now()}`);

  const editor = page.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  // The new-Space dialog hands focus back to its trigger as it closes, and
  // typing before that lands on the button.
  await expect(page.getByTestId('new-space-button')).toBeFocused();
  await editor.click();

  await page.keyboard.type(COLOURED);
  await page.keyboard.press('Enter');
  await page.keyboard.type(FILLED);
  await page.waitForTimeout(400);

  await colourLine(COLOURED, 'text', 'red');
  await colourLine(FILLED, 'fill', 'blue');
});

test.afterEach(async () => {
  if (spaceId) await deleteSpace(page, spaceId);
  await page?.close();
  spaceId = '';
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
