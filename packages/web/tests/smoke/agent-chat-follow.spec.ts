// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The chat column keeping up with a turn, measured in a browser.
 *
 * Three of the things reported against this panel are about the column
 * moving under the reader, and none of them can be settled anywhere but in a
 * browser: they turn on real layout, on a wheel a real mouse turns, and on
 * pictures arriving after the words that announced them.
 *
 * The cases run in order against one turn, and the order is the one the
 * reader's own would be in: the pictures land first and are measured while
 * they are still landing, then the reader leaves the end, then they come
 * back. Reversed, the last case would be asserting what the one before it
 * had just waited for.
 *
 * The turn is real, so the model decides what it writes and the search
 * service decides what it finds. A run where neither produces enough to fill
 * the column is reported as such rather than passed.
 */
import { expect, test, type Page } from 'playwright/test';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

let page: Page;

/** How far the column is from its end, in pixels. */
async function distanceFromEnd(p: Page): Promise<number> {
  return p.evaluate(() => {
    const viewport = document.querySelector(
      '[data-testid="message-list"] [data-radix-scroll-area-viewport]',
    );
    if (!viewport) return Number.NaN;
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
  });
}

/**
 * Sign in and open the account's first project.
 * @param p - The page to drive.
 * @returns Nothing.
 * @throws {Error} When sign-in never reaches a project.
 */
async function openProject(p: Page): Promise<void> {
  await p.goto('/login');
  await p.locator('#login-email').fill(email as string);
  await p.locator('#login-password').fill(password as string);
  await p.locator('form button[type="submit"]').click();
  await p.waitForURL(/\/(studio|project)/, { timeout: 20_000 });
  await p.goto('/studio');
  const first = p.locator('a[href^="/project/"]').first();
  await expect(first).toBeVisible({ timeout: 20_000 });
  await first.click();
  await p.waitForURL(/\/project\//, { timeout: 20_000 });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await openProject(page);
});

test.afterAll(async () => {
  await page.close();
});

test('pictures arriving after the words still leave the end of the turn in view', async () => {
  // A real turn, so the wait is on a model and on a search service rather
  // than on this machine.
  test.setTimeout(240_000);
  const composer = page.getByTestId('chat-composer-textarea');
  await expect(composer).toBeVisible({ timeout: 20_000 });

  // Its own conversation, so the column starts empty and what it does is
  // this turn's doing.
  await page.getByTestId('new-conversation').click();
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });

  await composer.fill(
    'Find me a few cyberpunk reference images -- neon, rainy night, street. ' +
      'Then describe in several paragraphs what makes that look work.',
  );
  await composer.press('Enter');

  // The squares are drawn before their pictures have arrived, and every one
  // that lands makes the column taller. This waits for the row itself, so
  // what follows is measured while they are still filling in -- a column
  // that stopped following at the last word leaves the reader looking at the
  // middle of the turn, with the copy button for it off the bottom.
  const row = page.getByTestId('asset-row');
  await expect(row.first()).toBeVisible({ timeout: 180_000 });
  expect(await distanceFromEnd(page)).toBeLessThan(80);

  await page.waitForFunction(
    () => {
      const images = Array.from(
        document.querySelectorAll('[data-testid="asset-thumb"] img'),
      ) as HTMLImageElement[];
      return images.length > 0 && images.every((img) => img.complete);
    },
    undefined,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(500);
  expect(await distanceFromEnd(page)).toBeLessThan(80);
});

test('a reader who scrolls up is left where they put themselves', async () => {
  test.setTimeout(120_000);
  // Enough of a reply to scroll through: the column has to be taller than
  // the room it has before leaving its end means anything.
  await page.waitForFunction(
    () => {
      const viewport = document.querySelector(
        '[data-testid="message-list"] [data-radix-scroll-area-viewport]',
      );
      return !!viewport && viewport.scrollHeight > viewport.clientHeight + 400;
    },
    undefined,
    { timeout: 60_000 },
  );

  // The wheel, over the column. Anything that fights the reader for the
  // scroller shows up as the distance closing again over the seconds that
  // follow.
  const list = page.getByTestId('message-list');
  await list.hover();
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(300);
  expect(await distanceFromEnd(page)).toBeGreaterThan(100);

  await page.waitForTimeout(3_000);
  expect(await distanceFromEnd(page)).toBeGreaterThan(100);

  // And the way back is offered while they are up there.
  await expect(page.getByTestId('back-to-latest')).toBeVisible({ timeout: 10_000 });
});

test('the way back takes the column to the newest message and steps aside', async () => {
  test.setTimeout(60_000);
  const back = page.getByTestId('back-to-latest');
  await expect(back).toBeVisible({ timeout: 20_000 });
  await back.click();

  // Gone the moment it is pressed: the reader is on their way to the end, and
  // an offer to go there is no longer an offer.
  await expect(back).toBeHidden({ timeout: 20_000 });

  // Arriving is the other half, and it takes longer than the press. The
  // journey is a glide, and the turn it is chasing may still be writing --
  // so what this waits for is the column settling at the end, whenever the
  // end stops moving.
  await page.waitForFunction(
    () => {
      const viewport = document.querySelector(
        '[data-testid="message-list"] [data-radix-scroll-area-viewport]',
      );
      if (!viewport) return false;
      return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
    },
    undefined,
    { timeout: 30_000 },
  );
});

test('a reader at the end keeps it when their composer takes the room', async () => {
  // The half a browser says nothing about: losing room moves the end away
  // without moving the column, so scrollTop stays legal, nothing is clamped
  // and no scroll event is raised. Measured on the running app before this
  // was handled: a reader parked at the end who types eight lines grows the
  // composer by 137px and is left 137px above the end of the reply, with no
  // arrow -- the end of that turn, and its copy button, under the composer.
  test.setTimeout(60_000);
  expect(await distanceFromEnd(page)).toBeLessThan(80);

  const composer = page.getByTestId('chat-composer-textarea');
  await composer.click();
  for (let line = 0; line < 8; line += 1) {
    await composer.type(`line ${String(line)}`);
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
  }
  await page.waitForTimeout(1_000);

  expect(await distanceFromEnd(page)).toBeLessThan(80);
  await expect(page.getByTestId('back-to-latest')).toBeHidden();
});
