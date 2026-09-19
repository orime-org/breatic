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

import { STATE_FILE, openSmokeProject } from '../helpers/project';

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

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({
    storageState: STATE_FILE.A,
    viewport: { width: 1400, height: 900 },
  });
  await openSmokeProject(page);
});

test.afterAll(async () => {
  await page.close();
});

test('the end of a turn is in view the moment it finishes @needs-model @needs-search @needs-internet', async () => {
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

test('a reader at the end keeps it when their composer takes the room @needs-model @needs-search @needs-internet', async () => {
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

test('a reader who takes the column mid-turn keeps it, and hands it back at the end @needs-model', async () => {
  // Its own turn, and one with nothing to search for, so it is still being
  // written when the wheel arrives. A turn that has finished cannot carry
  // anyone off, and a case that wheels on one is asserting nothing.
  test.setTimeout(240_000);
  // Long enough that the turn is still being written when the last assertion
  // here runs: the steps below spend six seconds waiting on purpose, and the
  // two that check the column keeps up need something still arriving.
  await ask(
    page,
    'Write thirty numbered paragraphs about the history of neon signage, each at least four sentences long.',
  );

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
  // A wheel turned here reaches the page over the browser's own channel, and
  // measured on this machine it lands about 100ms later. Waiting for the
  // column to have moved rather than for a stretch of time is what keeps a
  // slow arrival from reading as a column that refused to move.
  await page.waitForFunction(() => {
    const viewport = document.querySelector(
      '[data-testid="message-list"] [data-radix-scroll-area-viewport]',
    );
    if (!viewport) return false;
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 100;
  }, undefined, { timeout: 10_000 });

  // Anything that fights the reader for the scroller shows up as the distance
  // closing again over the seconds that follow, while chunks keep landing.
  await page.waitForTimeout(3_000);
  expect(await distanceFromEnd(page)).toBeGreaterThan(100);

  // And the way back is offered while they are up there.
  await expect(page.getByTestId('back-to-latest')).toBeVisible({ timeout: 10_000 });

  // The other way a reader takes the column: a press on the track, which
  // writes scrollTop once and raises one scroll event. Only a browser has the
  // real rail, the real thumb and the real geometry that decides which of the
  // two a press is.
  await page.getByTestId('back-to-latest').click();
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
  expect(await isWriting(page)).toBe(true);

  const rail = page.locator(
    '[data-testid="message-list"] [data-orientation="vertical"][data-scrollable="true"]',
  );
  await expect(rail).toBeVisible({ timeout: 10_000 });
  const box = await rail.boundingBox();
  if (!box) throw new Error('the column has a rail that occupies no space');
  // Two pixels in from the rail's inner edge. The column's right edge is also
  // where the panel handle that resizes it lives, and the handle takes the
  // outer half of the rail: measured on this machine, of the rail's eight
  // columns only the first four reach it (#253). The top of the track, where
  // the thumb is not while the column sits at its end, so a press there sends
  // the thumb to the pointer.
  await page.mouse.move(box.x + 2, box.y + 8);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForFunction(() => {
    const viewport = document.querySelector(
      '[data-testid="message-list"] [data-radix-scroll-area-viewport]',
    );
    if (!viewport) return false;
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 100;
  }, undefined, { timeout: 10_000 });

  await page.waitForTimeout(3_000);
  expect(await distanceFromEnd(page)).toBeGreaterThan(100);

  // And handing it back, which has to work in the frames a chunk lands in --
  // mid-turn that is every frame. A reader who scrolls down to the end again
  // gets a column that stays there.
  await list.hover();
  for (let push = 0; push < 6; push += 1) await page.mouse.wheel(0, 2_000);
  await page.waitForFunction(() => {
    const viewport = document.querySelector(
      '[data-testid="message-list"] [data-radix-scroll-area-viewport]',
    );
    if (!viewport) return false;
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
  }, undefined, { timeout: 10_000 });

  const grownFrom = await page.evaluate(() => {
    const viewport = document.querySelector(
      '[data-testid="message-list"] [data-radix-scroll-area-viewport]',
    );
    return viewport ? viewport.scrollHeight : 0;
  });
  expect(await isWriting(page)).toBe(true);
  await page.waitForTimeout(3_000);
  // Still at the end after three more seconds of it, and the reply did grow
  // in them -- a column that stopped following would be that much above it.
  expect(await distanceFromEnd(page)).toBeLessThan(80);
  const grownTo = await page.evaluate(() => {
    const viewport = document.querySelector(
      '[data-testid="message-list"] [data-radix-scroll-area-viewport]',
    );
    return viewport ? viewport.scrollHeight : 0;
  });
  expect(grownTo).toBeGreaterThan(grownFrom);

  // A small move is still a move, and the way back is offered for it. Ten
  // pixels is under half a line and well inside the bands other columns treat
  // as near enough to the end to finish the trip on the reader's behalf.
  await page.mouse.wheel(0, -10);
  await expect(page.getByTestId('back-to-latest')).toBeVisible({ timeout: 10_000 });
  expect(await distanceFromEnd(page)).toBeGreaterThan(0);

  // A wheel turned over the scrollbar rather than over the content. Radix
  // listens for it on the document and writes the viewport's scrollTop
  // itself, so it never passes through the column at all -- there is nothing
  // to hear but the scroll event it leaves behind. Measured on the running
  // app before this was read that way: 4 attempts in 20 were written back to
  // the end by the next chunk.
  await page.getByTestId('back-to-latest').click();
  await page.waitForFunction(
    () => {
      const viewport = document.querySelector(
        '[data-testid="message-list"] [data-radix-scroll-area-viewport]',
      );
      if (!viewport) return false;
      return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 2;
    },
    undefined,
    { timeout: 30_000 },
  );
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await expect(page.getByTestId('back-to-latest')).toBeVisible({ timeout: 10_000 });
  const overTheRail = await distanceFromEnd(page);
  expect(overTheRail).toBeGreaterThan(100);

  // Left where the next case needs them: up, with the way back offered.
  await page.mouse.wheel(0, -600);
  await expect(page.getByTestId('back-to-latest')).toBeVisible({ timeout: 10_000 });
});

test('the way back takes the column to the newest message and steps aside @needs-model', async () => {
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
