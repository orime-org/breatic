// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Commenting, end to end (task #18).
 *
 * The half jsdom cannot reach. Every rectangle it reports is zero, so the box
 * that floats beside the words has no size or place there; the body's own
 * selection is painted by the browser and by nobody in a test environment; and
 * which handler a press reaches depends on a real click travelling the plugin
 * chain.
 *
 * Wants dev running:
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import {
  openFreshDocument,
  selectFirstParagraph,
  selectParagraph,
} from '../helpers/bubble-bar';

// `bubble-bar` registers the afterEach that removes what `openFreshDocument`
// made, and it removes it off the fixture's page — so this file uses that one.
test.use({ viewport: { width: 1680, height: 950 } });

const EDITOR = '[data-testid="document-space"] .ProseMirror';

/** A line long enough that quoting it would run off the screen. */
const LONG_LINE =
  'The membership decides how much room you get and how many people can ' +
  'work alongside you, while the credits decide how much you can make with ' +
  'it, and the two are bought separately for that reason.';

/**
 * Opens a fresh Document Space holding one long line, with it all selected.
 * @param p - The page.
 */
async function openWithALongSelection(p: Page): Promise<void> {
  await openFreshDocument(p);
  await p.keyboard.type(LONG_LINE);
  await selectFirstParagraph(p);
}

/**
 * Comments on one paragraph, through the bubble bar.
 * @param p - The page.
 * @param index - Which paragraph, counting from zero.
 * @param body - What the comment says.
 */
async function commentOnParagraph(
  p: Page,
  index: number,
  body: string,
): Promise<void> {
  await selectParagraph(p, index);
  await p.getByTestId('doc-bubble-tool-comment').click();
  await p.getByTestId('doc-comment-input').fill(body);
  await p.getByTestId('doc-comment-post').click();
  await expect(p.getByTestId('doc-comment-composer')).toHaveCount(0);
}

/** How many bubble bars are on screen. */
async function barCount(p: Page): Promise<number> {
  return p.getByTestId('doc-selection-bubble-bar').count();
}

test.describe('the box a comment is written in', () => {
  test('stays its own width however much text is selected', async ({ page }) => {
    await openWithALongSelection(page);

    await page.getByTestId('doc-bubble-tool-comment').click();

    const box = page.getByTestId('doc-comment-composer');
    await expect(box).toBeVisible();
    const shape = await box.boundingBox();
    expect(shape).not.toBeNull();
    expect(shape!.width).toBeLessThan(400);
    expect(shape!.x).toBeGreaterThanOrEqual(0);
    expect(shape!.x + shape!.width).toBeLessThanOrEqual(1680);
  });

  test('leaves the words it is about drawn in the body', async ({ page }) => {
    await openWithALongSelection(page);

    await page.getByTestId('doc-bubble-tool-comment').click();
    await expect(page.getByTestId('doc-comment-composer')).toBeVisible();

    const painted = await page.evaluate(
      (selector) =>
        document.querySelectorAll(
          `${selector} [data-show-selection="true"]`,
        ).length,
      EDITOR,
    );
    expect(painted).toBeGreaterThan(0);
  });
});

test.describe('what the bubble bar does once an overlay closes', () => {
  test('stays away once the comment box is left by Escape', async ({ page }) => {
    await openWithALongSelection(page);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await expect(page.getByTestId('doc-comment-composer')).toBeVisible();

    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    expect(await barCount(page)).toBe(0);
  });

  test('stays away once a comment has been posted', async ({ page }) => {
    // The round the reader started by selecting those words ends when they
    // post. Measured on the link panel, which ends one the same way: nothing
    // stands back up after Escape or after an address is confirmed.
    await openWithALongSelection(page);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await expect(page.getByTestId('doc-comment-composer')).toBeVisible();

    await page.getByTestId('doc-comment-input').fill('a thought');
    await page.getByTestId('doc-comment-post').click();
    await page.waitForTimeout(500);

    expect(await barCount(page)).toBe(0);
  });
});

test.describe('the panel, read across from the body', () => {
  test('opens itself and marks the card a press in the body names', async ({
    page,
  }) => {
    await openWithALongSelection(page);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await page.getByTestId('doc-comment-input').fill('about this line');
    await page.getByTestId('doc-comment-post').click();
    await expect(page.getByTestId('doc-comment-rail')).toHaveCount(0);

    await page.locator(`${EDITOR} .bn-thread-mark`).first().click();

    await expect(page.getByTestId('doc-comment-rail')).toBeVisible();
    await expect(
      page.locator('[data-testid="doc-comment-card"][data-selected="true"]'),
    ).toHaveCount(1);
  });

  test('sits each card level with the words it is about', async ({ page }) => {
    await openFreshDocument(page);
    await page.keyboard.type(LONG_LINE);
    await page.keyboard.press('Enter');
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.type(`filler line ${i}`);
      await page.keyboard.press('Enter');
    }
    await page.keyboard.type(LONG_LINE);

    // Neither is at the very top of the body: a card up there is held off
    // the panel's header, which the case below is about.
    await commentOnParagraph(page, 1, 'the first one');
    await commentOnParagraph(page, 13, 'the last one');
    await page.getByTestId('doc-doc-menu-trigger').click();
    await page.getByTestId('doc-doc-menu-comments').click();
    await expect(page.getByTestId('doc-comment-rail')).toBeVisible();
    await page.waitForTimeout(400);

    const marks = page.locator(`${EDITOR} .bn-thread-mark`);
    const cards = page.getByTestId('doc-comment-card');
    const firstMark = await marks.first().boundingBox();
    const lastMark = await marks.last().boundingBox();
    const firstCard = await cards.first().boundingBox();
    const lastCard = await cards.last().boundingBox();

    // Top edges level. Nothing crowds these two — they are pages apart — so
    // each keeps its anchor, and the only slack is the card's own border.
    expect(Math.abs(firstCard!.y - firstMark!.y)).toBeLessThan(4);
    expect(Math.abs(lastCard!.y - lastMark!.y)).toBeLessThan(4);
    // And far enough apart that the gap between them is the uncommented text.
    expect(lastCard!.y - firstCard!.y).toBeGreaterThan(200);
  });

  test('holds a card off the panel header rather than over it', async ({
    page,
  }) => {
    // The first line of the body sits above the header's lower edge, so the
    // card for a comment on it would cover the filter and the close button
    // (user 2026-09-22).
    await openFreshDocument(page);
    await page.keyboard.type(LONG_LINE);
    await commentOnParagraph(page, 0, 'right at the top');
    await page.getByTestId('doc-doc-menu-trigger').click();
    await page.getByTestId('doc-doc-menu-comments').click();
    await expect(page.getByTestId('doc-comment-rail')).toBeVisible();
    await page.waitForTimeout(400);

    const header = await page
      .getByTestId('doc-comment-rail-header')
      .boundingBox();
    const card = await page.getByTestId('doc-comment-card').boundingBox();

    const clearance = card!.y - (header!.y + header!.height);
    expect(clearance).toBeGreaterThanOrEqual(3.5);
    expect(clearance).toBeLessThan(6);
  });

  test('carries the cards along when the body scrolls', async ({ page }) => {
    await openFreshDocument(page);
    await page.keyboard.type(LONG_LINE);
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('Enter');
      await page.keyboard.type(`filler line ${i}`);
    }
    await commentOnParagraph(page, 0, 'up at the top');
    await page.getByTestId('doc-doc-menu-trigger').click();
    await page.getByTestId('doc-doc-menu-comments').click();
    await expect(page.getByTestId('doc-comment-rail')).toBeVisible();
    await page.waitForTimeout(400);
    const before = await page.getByTestId('doc-comment-card').boundingBox();

    await page.mouse.move(400, 500);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(400);

    const after = await page.getByTestId('doc-comment-card').boundingBox();
    expect(before!.y - after!.y).toBeGreaterThan(100);
  });

  test('deepens the words while the pointer rests on their card', async ({
    page,
  }) => {
    await openWithALongSelection(page);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await page.getByTestId('doc-comment-input').fill('about this line');
    await page.getByTestId('doc-comment-post').click();
    await page.getByTestId('doc-doc-menu-trigger').click();
    await page.getByTestId('doc-doc-menu-comments').click();
    await expect(page.getByTestId('doc-comment-rail')).toBeVisible();
    // Off every card first: the menu row the panel was opened from leaves the
    // pointer where a card then appears, and a card under the pointer is
    // exactly what this draws.
    await page.mouse.move(60, 60);
    const deepened = page.locator(`${EDITOR} .bn-thread-mark-selected`);
    await expect(deepened).toHaveCount(0);

    await page.getByTestId('doc-comment-card').hover();

    await expect(deepened.first()).toBeVisible();
  });
});
