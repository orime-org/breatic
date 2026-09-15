// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Selected text looks the same with a link panel open as without one.
 *
 * A document holds one selection. The link panel's address input takes it, so
 * the browser stops painting the body's, and BlockNote draws a substitute in
 * its place. The substitute asks for the system colour keyword `highlight`,
 * which is not what the browser paints a real selection with — measured in
 * Chromium, dark theme paints rgb(70, 98, 129) at alpha 0.79 while the keyword
 * resolves to rgb(179, 215, 255) at 0.8.
 *
 * Colour is compared as images and shape as numbers. One pixel-for-pixel
 * assertion cannot cover both: an inline decoration stops at the last glyph
 * while a real selection paints to the end of the line box, so text that wraps
 * differs at every wrap however the colour is set (design §7.4.1, and the forty
 * lines of `index.css:879-922` that measured the same thing for a co-editor's
 * band).
 *
 * Needs dev running plus a smoke account:
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { createSpace, deleteSpace } from './helpers/space';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');
// Not serial: each case makes its own Space and shares nothing but the login,
// and serial would stop reporting at the first red one.
test.describe.configure({ mode: 'default' });

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** One line, short enough that 1680px never wraps it. */
const ONE_LINE = 'one short line';

let page: Page;
const createdSpaceIds: string[] = [];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  await page.goto('/login');
  await page.locator('#login-email').fill(email as string);
  await page.locator('#login-password').fill(password as string);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/(studio|project)/, { timeout: 15_000 });
});

test.afterAll(async () => {
  for (const id of createdSpaceIds) await deleteSpace(page, id);
  await page?.close();
});

/** Open a new document Space, put the caret in its body, and set the theme. */
async function freshBody(p: Page, theme: 'light' | 'dark'): Promise<void> {
  await p.goto('/studio');
  const first = p.locator('a[href^="/project/"]').first();
  await expect(first).toBeVisible({ timeout: 15_000 });
  await first.click();
  await p.waitForURL(/\/project\//, { timeout: 15_000 });
  createdSpaceIds.push(await createSpace(p, 'document', `paint-${Date.now()}`));

  const editor = p.locator('[data-testid="document-space"] .ProseMirror');
  await expect(editor).toBeVisible({ timeout: 15_000 });
  // The new-Space dialog hands focus back to its trigger asynchronously; typing
  // before that lands goes to the button.
  await expect(p.getByTestId('new-space-button')).toBeFocused();
  await editor.click();
  await expect(editor).toBeFocused();
  await p.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
}

/** The first paragraph's box, as a screenshot clip. */
async function firstLineClip(
  p: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  return p.evaluate(() => {
    const r = document.querySelector<HTMLElement>(
      '[data-testid="document-space"] .ProseMirror p',
    )!.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  });
}

/**
 * Whether two screenshots of the same clip hold the same pixels.
 *
 * Decoded by the page rather than by an image library here: the browser has a
 * decoder, and comparing the encoded bytes would answer about the encoder.
 * @param p - The page, used as the decoder.
 * @param a - One screenshot.
 * @param b - The other.
 * @returns How many pixels differ and the first one that does.
 */
async function pixelDiff(
  p: Page,
  a: Buffer,
  b: Buffer,
): Promise<{ differing: number; total: number; firstAt: string | null }> {
  return p.evaluate(async ([oneUrl, twoUrl]) => {
    const load = async (url: string): Promise<ImageData> => {
      const img = new Image();
      await new Promise((done) => { img.onload = done; img.src = url; });
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, canvas.width, canvas.height);
    };
    const one = await load(oneUrl);
    const two = await load(twoUrl);
    let differing = 0;
    let firstAt: string | null = null;
    for (let i = 0; i < one.data.length; i += 4) {
      const same =
        one.data[i] === two.data[i] &&
        one.data[i + 1] === two.data[i + 1] &&
        one.data[i + 2] === two.data[i + 2];
      if (same) continue;
      differing += 1;
      if (firstAt === null) {
        const px = (i / 4) % one.width;
        const py = Math.floor(i / 4 / one.width);
        firstAt =
          `(${px}, ${py}): rgb(${one.data[i]}, ${one.data[i + 1]}, ${one.data[i + 2]})` +
          ` vs rgb(${two.data[i]}, ${two.data[i + 1]}, ${two.data[i + 2]})`;
      }
    }
    return { differing, total: one.data.length / 4, firstAt };
  }, [`data:image/png;base64,${a.toString('base64')}`, `data:image/png;base64,${b.toString('base64')}`]);
}

/** Select the whole first block and wait for the bar. */
async function selectTheLine(p: Page): Promise<void> {
  await p.keyboard.press(`${MOD}+a`);
  await expect(p.getByTestId('doc-selection-bubble-bar')).toBeVisible({ timeout: 5_000 });
}

/** Press the bar's link tool and wait for whichever face opens. */
async function openLinkPanel(p: Page, expectInput: boolean): Promise<void> {
  await p.getByTestId('doc-bubble-tool-link').click();
  await expect(
    p.getByTestId(expectInput ? 'doc-link-input' : 'doc-link-popover'),
  ).toBeVisible({ timeout: 5_000 });
}

for (const theme of ['light', 'dark'] as const) {
  test(`plain text looks the same with the panel open, in ${theme}`, async () => {
    await freshBody(page, theme);
    await page.keyboard.type(ONE_LINE);

    await selectTheLine(page);
    const clip = await firstLineClip(page);
    const focused = await page.screenshot({ clip });

    await openLinkPanel(page, true);
    const panelOpen = await page.screenshot({ clip });

    const diff = await pixelDiff(page, focused, panelOpen);
    expect(
      diff.differing,
      `the selection is painted differently with the panel open; first at ${diff.firstAt}`,
    ).toBe(0);
  });

  test(`a link looks the same with the panel open, in ${theme}`, async () => {
    await freshBody(page, theme);
    await page.keyboard.type(ONE_LINE);
    await selectTheLine(page);
    await openLinkPanel(page, true);
    await page.getByTestId('doc-link-input').fill('https://example.com');
    await page.getByTestId('doc-link-confirm').click();
    await expect(page.getByTestId('doc-link-popover')).toBeHidden({ timeout: 5_000 });

    // No click into the body: the whole line is a link now, and pressing one
    // opens it in a new tab. The confirm already handed focus back.
    await selectTheLine(page);
    const clip = await firstLineClip(page);
    const focused = await page.screenshot({ clip });

    await openLinkPanel(page, false);
    const panelOpen = await page.screenshot({ clip });

    const diff = await pixelDiff(page, focused, panelOpen);
    expect(
      diff.differing,
      `the selection over a link is painted differently with the panel open; first at ${diff.firstAt}`,
    ).toBe(0);
  });

  test(`the body paints the selection the browser would, in ${theme}`, async () => {
    // What pins the token's value. Everything else compares our paint against
    // our own paint and would agree on any value; this compares it against the
    // browser's own, which is what the value was solved from.
    await freshBody(page, theme);
    await page.keyboard.type(ONE_LINE);
    await selectTheLine(page);

    // Asked first, or the comparison below is vacuous: with no rule of our own
    // the revert changes nothing and two identical shots agree on any value.
    const token = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--color-selection')
        .trim());
    expect(token, 'the body has no selection colour of its own').not.toBe('');

    const clip = await firstLineClip(page);
    const ours = await page.screenshot({ clip });

    const handle = await page.addStyleTag({
      content: '.doc-body-editor .ProseMirror ::selection { background-color: revert; }',
    });
    const reverted = await page.screenshot({ clip });
    await handle.evaluate((el) => el.remove());

    const diff = await pixelDiff(page, ours, reverted);
    expect(
      diff.differing,
      `the body's selection colour differs from the browser's own; first at ${diff.firstAt}`,
    ).toBe(0);
  });
}
