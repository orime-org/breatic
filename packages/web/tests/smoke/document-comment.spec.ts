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
