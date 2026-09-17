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
 * These cases are about the colour. One pixel-for-pixel assertion cannot also
 * cover the shape: an inline decoration stops at the last glyph while a real
 * selection paints to the end of the line box, and their boxes differ
 * vertically by about a pixel for a reason no CSS constant can fix (see
 * EDGE_INSET, design §7.4.1, and the forty lines of `index.css` that measured
 * the same thing for a co-editor's band). The shape is todo #100.
 *
 * The second defect these cases hold down is the panel that does NOT take the
 * focus. The read face carries no field, so the body keeps painting, and a
 * substitute drawn there is the same colour laid over itself — which is what a
 * selection over a link used to be.
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

/**
 * Rows dropped from each end of the clip, so these cases ask about colour.
 *
 * The two paints do not agree on where the band stops. A real selection fills
 * the line box; an inline decoration fills its own content box plus whatever
 * padding it is given, and no padding is right, because the content box is a
 * per-build rounding of the font's metrics (`index.css` records 1.192em at 13px
 * through 1.229em at 24px on one Chrome and 1.267em at 15px on another; this
 * one measures 1.266em at 15px, against the 1.21em the shared rule assumes).
 * Measured here: the band runs 1.17px above the line box and stops 0.33px short
 * of its bottom, which lands entirely in the first and last row of the clip.
 *
 * That is the shape, it is what todo #100 replaces with positioned rectangles
 * measured from the selection's own client rects, and it is not what these
 * cases are for. Two rows cover the measured disagreement with room to spare
 * and leave 18 of the 22 to compare.
 */
const EDGE_INSET = 2;

/**
 * The largest single-channel difference that is not a difference in colour.
 *
 * A translucent fill lands between two 8-bit values and the browser dithers it,
 * and the two paints dither independently — one goes through `::selection` and
 * the other through a `background-image`, which is what the substitute needs to
 * sit above the background colour a remote collaborator's band uses. Censused
 * over a 96x23 clip of one selected line, each side's own band pixels:
 *
 *   light   real  173,192,239 only
 *           ours  173,192,239 and 172,192,238
 *   dark    real  61,83,107 and 60,82,106
 *           ours  61,83,107, 61,83,108 and 60,82,107
 *
 * So each side sits within one step of the exact composite, in either
 * direction, and the gap between them reaches two — which is where this number
 * comes from rather than from a run that needed to go green. Nothing is two
 * steps from being the wrong colour: both defects this file guards against move
 * a channel by 17 to 27.
 */
const NOISE = 2;

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
  // One drawer trip each, and the co-editor case brings the count to seven.
  test.setTimeout(180_000);
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

/**
 * The first paragraph's box, as a screenshot clip.
 * @param p - The page.
 * @param insetY - Rows to drop from the top and the bottom.
 * @returns The clip.
 */
async function firstLineClip(
  p: Page,
  insetY = 0,
): Promise<{ x: number; y: number; width: number; height: number }> {
  return p.evaluate((inset) => {
    const r = document.querySelector<HTMLElement>(
      '[data-testid="document-space"] .ProseMirror p',
    )!.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y) + inset,
      width: Math.round(r.width),
      height: Math.round(r.height) - inset * 2,
    };
  }, insetY);
}

/**
 * The furthest apart any one channel gets between two shots of the same clip.
 *
 * Decoded by the page rather than by an image library here: the browser has a
 * decoder, and comparing the encoded bytes would answer about the encoder.
 *
 * The answer is a worst case rather than a count of differing pixels, because a
 * count cannot tell a wrong colour from rendering noise: a selection painted
 * through a gradient and one painted flat land one 8-bit step apart on some
 * pixels, and either of the defects this file is about moves whole channels by
 * 17 to 27.
 * @param p - The page, used as the decoder.
 * @param a - One screenshot.
 * @param b - The other.
 * @returns The largest single-channel difference and where it is.
 */
async function pixelDiff(
  p: Page,
  a: Buffer,
  b: Buffer,
): Promise<{ worst: number; at: string | null }> {
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
    let worst = 0;
    let at: string | null = null;
    for (let i = 0; i < one.data.length; i += 4) {
      const delta = Math.max(
        Math.abs((one.data[i] ?? 0) - (two.data[i] ?? 0)),
        Math.abs((one.data[i + 1] ?? 0) - (two.data[i + 1] ?? 0)),
        Math.abs((one.data[i + 2] ?? 0) - (two.data[i + 2] ?? 0)),
      );
      if (delta <= worst) continue;
      worst = delta;
      at =
        `(${(i / 4) % one.width}, ${Math.floor(i / 4 / one.width)}): ` +
        `rgb(${one.data[i]}, ${one.data[i + 1]}, ${one.data[i + 2]})` +
        ` vs rgb(${two.data[i]}, ${two.data[i + 1]}, ${two.data[i + 2]})`;
    }
    return { worst, at };
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
    const clip = await firstLineClip(page, EDGE_INSET);
    const focused = await page.screenshot({ clip });

    await openLinkPanel(page, true);
    const panelOpen = await page.screenshot({ clip });

    const diff = await pixelDiff(page, focused, panelOpen);
    expect(
      diff.worst,
      `the selection is painted a different colour with the panel open; worst at ${diff.at}`,
    ).toBeLessThanOrEqual(NOISE);
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
    const clip = await firstLineClip(page, EDGE_INSET);
    const focused = await page.screenshot({ clip });

    await openLinkPanel(page, false);
    const panelOpen = await page.screenshot({ clip });

    const diff = await pixelDiff(page, focused, panelOpen);
    expect(
      diff.worst,
      `the selection over a link is painted a different colour with the panel open; worst at ${diff.at}`,
    ).toBeLessThanOrEqual(NOISE);
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
    // Exact, with no inset: both shots are the browser's own `::selection`, so
    // only the colour can differ. Nothing here paints through a gradient and
    // nothing here has a box of its own to disagree about.
    expect(
      diff.worst,
      `the body's selection colour differs from the browser's own; worst at ${diff.at}`,
    ).toBe(0);
  });
}

test('a selection a co-editor also holds looks the same with the panel open', async ({
  browser,
}) => {
  // The third situation. A remote selection and this reader's own land on the
  // SAME span element — the decoration that stands in for the selection and
  // the one that paints the co-editor's band carry a class and a style each
  // with no element name between them, so prosemirror-view puts both on one
  // span. The band is the background colour under this reader's paint there,
  // and the substitute's own `background-color` has to leave it alone.
  //
  // Light only: what the two themes settle is the token's value, which the
  // cases above take in both. This one is about the band still being there.
  test.setTimeout(120_000);
  await freshBody(page, 'light');
  await page.keyboard.type(ONE_LINE);

  const projectUrl = page.url();
  const spaceTab = await page.evaluate(
    () =>
      document
        .querySelector('[data-testid^="space-tab-"][aria-selected="true"]')!
        .getAttribute('data-testid')!,
  );

  const peer = await browser.newContext({ viewport: { width: 1680, height: 950 } });
  try {
    const other = await peer.newPage();
    await other.goto('/login');
    await other.locator('#login-email').fill(email as string);
    await other.locator('#login-password').fill(password as string);
    await other.locator('form button[type="submit"]').click();
    await other.waitForURL(/\/(studio|project)/, { timeout: 15_000 });
    await other.goto(projectUrl);
    await other.getByTestId(spaceTab).click();
    const peerBody = other.locator('[data-testid="document-space"] .ProseMirror');
    await expect(peerBody).toContainText(ONE_LINE, { timeout: 15_000 });

    await peerBody.click();
    await other.keyboard.press(MOD + '+a');

    const band = page.locator(
      '[data-testid="document-space"] .ProseMirror .collaboration-carets__selection',
    );
    await expect(band).toBeVisible({ timeout: 15_000 });

    /** The colour the co-editor's band is painted in, as this page sees it. */
    const bandColour = async (): Promise<string> =>
      band.first().evaluate((el) =>
        getComputedStyle(el).getPropertyValue('--collab-selection-bg').trim());

    await selectTheLine(page);
    const focusedBand = await bandColour();
    const clip = await firstLineClip(page, EDGE_INSET);
    const focused = await page.screenshot({ clip });

    await openLinkPanel(page, true);
    const panelOpenBand = await bandColour();
    const panelOpen = await page.screenshot({ clip });

    // The band dims when the other window loses the focus, which would read as
    // a change in this reader's own paint.
    expect(
      panelOpenBand,
      'the band a co-editor is drawn with changed between the two shots',
    ).toBe(focusedBand);

    const diff = await pixelDiff(page, focused, panelOpen);
    expect(
      diff.worst,
      `a selection a co-editor also holds is painted differently with the panel open; worst at ${diff.at}`,
    ).toBeLessThanOrEqual(NOISE);
  } finally {
    await peer.close();
  }
});
