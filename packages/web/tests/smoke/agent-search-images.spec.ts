// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Pictures the agent found, measured in a browser.
 *
 * One tool does the searching and the showing: what it answers with is what
 * the panel draws, so nothing is copied between the two. What a browser
 * settles that no unit test can is whether the squares are drawn at all --
 * the address has to survive the protocol, reach `to-chat-message`, and be
 * fetched by a real `img`.
 *
 * Which address is fetched is the other half. A result carries the service's
 * proxied thumbnail and the original the publishing site hosts, and every
 * square and the open view are drawn from the first. A build that reached for
 * the original instead still shows pictures, so only the requests the browser
 * actually made say which one it used.
 *
 * The turn is real, so the model decides whether to search. The prompt asks
 * for reference pictures, which is the case the tool exists for; a run where
 * it answers in prose instead is reported as such rather than passed.
 */
import { expect, test, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';

let page: Page;

/** Every image address the browser asked for, in order. */
const imageRequests: string[] = [];

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({
    storageState: STATE_FILE.A,
    viewport: { width: 1400, height: 900 },
  });
  page.on('request', (req) => {
    if (req.resourceType() === 'image') imageRequests.push(req.url());
  });
  await openSmokeProject(page);
});

/**
 * Run a turn that asks for reference pictures, and wait for the squares.
 *
 * Each case opens its own page, so neither inherits the other's squares. The
 * conversation is its own too: opening a Project hands back the one this
 * account used last, which would be whatever another case was doing.
 * @param target - The page to run the turn in.
 * @throws {Error} When no row of pictures appears, which is what a run where
 *   the model answered in prose instead of searching looks like.
 */
async function aTurnThatFoundPictures(target: Page): Promise<void> {
  const composer = target.getByTestId('chat-composer-textarea');
  await expect(composer).toBeVisible({ timeout: 20_000 });

  await target.getByTestId('new-conversation').click();
  await expect(target.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });

  imageRequests.length = 0;
  await composer.fill('Find me a few cyberpunk reference images -- neon, rainy night, street.');
  await composer.press('Enter');

  await expect(target.getByTestId('asset-row')).toBeVisible({ timeout: 150_000 });
}

test.afterEach(async () => {
  await page.close();
});

test('a turn that found pictures draws them, from the proxied thumbnail @needs-model @needs-search @needs-internet', async () => {
  // A real turn, so the wait is on a model and on the search service rather
  // than on this machine.
  test.setTimeout(180_000);
  await aTurnThatFoundPictures(page);

  const squares = page.getByTestId('asset-thumb');
  const drawn = await squares.count();
  expect(drawn).toBeGreaterThan(0);

  // Every square holds a picture that loaded. `naturalWidth` is zero for an
  // address that answered with anything other than an image, which is what a
  // page address put in an `img` looks like -- and zero as well for one that
  // has not finished arriving, which is why this waits rather than reads.
  await page.waitForFunction(
    () => {
      const drawnImages = Array.from(
        document.querySelectorAll('[data-testid="asset-thumb"] img'),
      ) as HTMLImageElement[];
      return drawnImages.length > 0 && drawnImages.every((img) => img.naturalWidth > 0);
    },
    undefined,
    { timeout: 30_000 },
  );

  const widths = await squares
    .locator('img')
    .evaluateAll((nodes) => nodes.map((n) => (n as HTMLImageElement).naturalWidth));
  expect(widths.length).toBe(drawn);
  for (const width of widths) expect(width).toBeGreaterThan(0);

  // The service proxies its thumbnails on a host of its own, and resizes them
  // to 500 wide. Both are what a build drawing from the original would miss.
  const drawnSrcs = await squares
    .locator('img')
    .evaluateAll((nodes) => nodes.map((n) => (n as HTMLImageElement).src));
  for (const src of drawnSrcs) expect(src).toContain('imgs.search.brave.com');

  const fetched = imageRequests.filter((url) => !url.startsWith('data:'));
  expect(fetched.some((url) => url.includes('imgs.search.brave.com'))).toBe(true);
});

test('opening one shows it large, from that same address @needs-model @needs-search @needs-internet', async () => {
  test.setTimeout(240_000);
  await aTurnThatFoundPictures(page);

  const first = page.getByTestId('asset-thumb').first();
  const thumbSrc = await first.locator('img').evaluate((n) => (n as HTMLImageElement).src);

  await first.click();

  const box = page.getByTestId('asset-box');
  await expect(box).toBeVisible({ timeout: 20_000 });

  const stage = box.locator('img').first();
  const stageSrc = await stage.evaluate((n) => (n as HTMLImageElement).src);
  expect(stageSrc).toContain('imgs.search.brave.com');

  // The strip along the bottom holds every one of them, including the one on
  // the stage, so the reader can move between them without shutting the box.
  const strip = page.getByTestId('asset-box-thumb');
  expect(await strip.count()).toBeGreaterThan(0);
  expect(thumbSrc).toContain('imgs.search.brave.com');

  await page.keyboard.press('Escape');
  await expect(box).toBeHidden({ timeout: 20_000 });
});
