// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The chat column keeping up with a turn, measured in a browser.
 *
 * Three of the things reported against this panel are about the column
 * moving under the reader, and none of them can be settled anywhere but in a
 * browser: they turn on real layout, on a wheel a real mouse turns, and on a
 * turn that is still being written.
 *
 * Two turns, because the two halves need opposite conditions. What a turn
 * found is drawn only once it has stopped writing (`MessageBubble` gates the
 * asset row on `running`), so the case about the end staying in view has to
 * watch a turn end -- while the case about a reader scrolling up has to
 * happen while one is still going, or there is nothing to be carried off by.
 *
 * The turns are real, so the model decides what it writes and the search
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
 * Whether a turn is still being written.
 *
 * The stop button, which the composer mounts for the length of a turn and
 * nothing else. What a turn found is drawn on the same condition, but only
 * for a turn that found something: a reply with nothing to search for has no
 * row before, during or after, so reading the row would answer "still
 * writing" for the whole life of the page.
 * @param p - The page to read.
 * @returns Whether a turn is running.
 */
async function isWriting(p: Page): Promise<boolean> {
  return p.evaluate(
    () => document.querySelector('[data-testid="chat-composer-abort"]') !== null,
  );
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

/**
 * Start a fresh conversation and send one message.
 * @param p - The page to drive.
 * @param prompt - What to ask for.
 * @returns Nothing.
 */
async function ask(p: Page, prompt: string): Promise<void> {
  const composer = p.getByTestId('chat-composer-textarea');
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await p.getByTestId('new-conversation').click();
  await expect(p.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
  await composer.fill(prompt);
  await composer.press('Enter');
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await openProject(page);
});

test.afterAll(async () => {
  await page.close();
});

test('the end of a turn is in view the moment it finishes', async () => {
  // A real turn, so the wait is on a model and on a search service rather
  // than on this machine.
  test.setTimeout(240_000);
  await ask(
    page,
    'Find me a few cyberpunk reference images -- neon, rainy night, street. ' +
      'Then describe in several paragraphs what makes that look work.',
  );

  // Finishing is the moment the column jumps: the row of squares and the
  // actions under the turn are both drawn only once it has stopped writing,
  // so several hundred pixels appear in one frame. A column that had stopped
  // following leaves the reader looking at the middle of the turn, with the
  // copy button for it off the bottom -- which is the report this fixes.
  await expect(page.getByTestId('asset-row').first()).toBeVisible({ timeout: 180_000 });
  expect(await distanceFromEnd(page)).toBeLessThan(80);
});

test('a reader at the end keeps it when their composer takes the room', async () => {
  // Losing room moves the end away without moving the column: scrollTop stays
  // legal, nothing is clamped, no scroll event is raised, and the content box
  // did not change either. Measured on the running app before this was
  // handled: eight lines grew the composer by 137px and left the reader 137px
  // above the end of the reply, with no way back offered.
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
  await composer.fill('');
});

test('the library can find the scroller the wheel landed on', async () => {
  // It looks for one by walking up from the wheel's target until
  // `getComputedStyle(el).overflow` is "scroll" or "auto". Radix writes the
  // two axes separately and inline, and a shorthand whose axes differ
  // serialises as "hidden scroll" -- which that walk passes straight over,
  // taking the wheel handler with it. The case below is the behaviour; this
  // is the mechanism, and it is the half that can be measured every run
  // rather than on the fraction of wheels that land badly.
  test.setTimeout(30_000);
  const reading = await page.evaluate(() => {
    const viewport = document.querySelector(
      '[data-testid="message-list"] [data-radix-scroll-area-viewport]',
    );
    if (!viewport) return null;
    let element: Element | null = viewport;
    let steps = 0;
    while (element && !['scroll', 'auto'].includes(getComputedStyle(element).overflow)) {
      element = element.parentElement;
      steps += 1;
    }
    return {
      overflow: getComputedStyle(viewport).overflow,
      foundTheViewport: element === viewport,
      steps,
      // Nothing sideways to scroll, so nothing appears for the reader.
      overflows: viewport.scrollWidth > viewport.clientWidth,
      rail: document.querySelector(
        '[data-testid="message-list"] [data-orientation="horizontal"]',
      ) !== null,
    };
  });

  expect(reading).not.toBeNull();
  expect(reading?.overflow).toBe('scroll');
  expect(reading?.foundTheViewport).toBe(true);
  expect(reading?.steps).toBe(0);
  expect(reading?.overflows).toBe(false);
  expect(reading?.rail).toBe(false);
});

test('a reader who scrolls up mid-turn is left where they put themselves', async () => {
  // Its own turn, and one with nothing to search for, so it is still being
  // written when the wheel arrives. A turn that has finished cannot carry
  // anyone off, and a case that wheels on one is asserting nothing.
  test.setTimeout(240_000);
  await ask(page, 'Write twelve numbered paragraphs about the history of neon signage.');

  // Enough of a reply to scroll through, and still arriving.
  await page.waitForFunction(
    () => {
      const viewport = document.querySelector(
        '[data-testid="message-list"] [data-radix-scroll-area-viewport]',
      );
      return !!viewport && viewport.scrollHeight > viewport.clientHeight + 600;
    },
    undefined,
    { timeout: 180_000 },
  );
  expect(await isWriting(page)).toBe(true);

  const list = page.getByTestId('message-list');
  await list.hover();
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(300);
  expect(await distanceFromEnd(page)).toBeGreaterThan(100);

  // Anything that fights the reader for the scroller shows up as the distance
  // closing again over the seconds that follow, while chunks keep landing.
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

  // A journey rather than a jump. Reading the column straight after the press
  // finds it still on its way; a column told to arrive at once is already
  // there by now.
  expect(await distanceFromEnd(page)).toBeGreaterThan(80);

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
