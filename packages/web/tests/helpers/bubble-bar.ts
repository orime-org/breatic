// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A Document Space with a body to select in, and the readings taken off the
 * bubble bar that comes up over a selection.
 *
 * A spec importing this evaluates it in its own scope, so the hooks below
 * build that file's Spaces and remove them again, and neither file can reach
 * the other's (measured, playwright 1.62.1, 2026-09-19).
 *
 * Every case opens its own Space: each wants a body it wrote itself, and the
 * cases used to share one page across the file, where a red one left the next
 * reading a document it had not built.
 */
import { expect, test, type Locator, type Page } from 'playwright/test';

import { openSmokeProject } from './project';
import { createSpace, deleteSpace } from './space';

// Wide, because the column's own width decides which side the bar comes up on
// and how far it may reach.
test.use({ viewport: { width: 1680, height: 950 } });

/** The Spaces this case made, removed when it ends. */
const createdSpaceIds: string[] = [];

test.afterEach(async ({ page }) => {
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
});

/**
 * The top of the body's visible area, measured on the spot.
 *
 * This used to be the constant 120, which is what it measured at the time. A
 * number written down here stops describing the box under test the moment the
 * chrome above it changes height, and removing the document space's top strip
 * is already on the queue (#129).
 * @param p - The page.
 * @returns How far the body's visible area sits below the top of the window.
 */
export async function bodyViewportTop(p: Page): Promise<number> {
  return p.evaluate(() =>
    Math.round(
      document
        .querySelector('.doc-body-scroller [data-radix-scroll-area-viewport]')!
        .getBoundingClientRect().top,
    ));
}

/** The gap between the bar and the line it anchors to, the same number the implementation calls `GAP_FROM_SELECTION_PX`. */
export const GAP_FROM_SELECTION_PX = 8;

/**
 * How long a `Button` takes to change colour under the pointer.
 *
 * Its base class carries `transition-colors` (`components/ui/button.tsx:19`),
 * which Tailwind gives 150ms. Any assertion about the background a pointer
 * produced has to outlast that, or it reads the value from before the
 * transition started.
 */
export const HOVER_TRANSITION_MS = 150;

/**
 * Open a Document Space this call makes, with the caret already in the body.
 * @param page - The page to open it on.
 */
export async function openFreshDocument(page: Page): Promise<void> {
  await openSmokeProject(page);

  createdSpaceIds.push(
    await createSpace(page, 'document', `bubble-${Date.now()}`),
  );

  const editor = page.locator('[data-testid="document-space"] .ProseMirror');
  await expect(editor).toBeVisible({ timeout: 15_000 });
  // The new-Space dialog hands focus back to its trigger asynchronously as it
  // closes. Typing before that lands on the button instead of the body (#123).
  await expect(page.getByTestId('new-space-button')).toBeFocused();
  await editor.click();
  await expect(editor).toBeFocused();
}

/**
 * Select every character of the first paragraph.
 *
 * The press waits for the editor to hold the focus: a click's focus lands
 * asynchronously, a press that arrives first is dropped, and the caret is then
 * still where the typing ended — while Cmd+A takes the paragraph the caret is
 * in. A document of one paragraph cannot tell the two apart; measured on a
 * document of two, the press without the wait took the second.
 */
export async function selectFirstParagraph(page: Page): Promise<void> {
  const editor = page.locator('[data-testid="document-space"] .ProseMirror');
  await editor.locator('p').first().click();
  await expect(editor).toBeFocused();
  await page.waitForTimeout(200);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
}

/**
 * Select paragraph `i` with a triple click.
 *
 * The previous selection is dropped first, and the bar waited out of the DOM,
 * before the click lands. Without that the bar is still on screen from the
 * last call, `toBeVisible` returns at once, and what gets measured is its old
 * position — the plugin debounces selection changes by 250ms, and this
 * measured a gap of 237px where the same scenario on its own measures 8.
 *
 * A key press drops that selection rather than a click: a click followed
 * immediately by a triple click is joined into one longer run of clicks, and
 * what that selects is not a whole paragraph. Measured, the anchor landed on
 * the NEXT paragraph and the bar sat on top of the selected line (444 to 480
 * over 451 to 470).
 * @param page - The page the document is on.
 * @param i - Which paragraph, counting from zero.
 */
export async function selectParagraph(page: Page, i: number): Promise<void> {
  const paragraph = page
    .locator('[data-testid="document-space"] .ProseMirror p')
    .nth(i);
  const bar = page.getByTestId('doc-selection-bubble-bar');

  if (await bar.isVisible()) {
    await page.keyboard.press('ArrowRight');
    await expect(bar).not.toBeAttached({ timeout: 5_000 });
  }
  await paragraph.click({ clickCount: 3 });
  await expect(bar).toBeVisible({ timeout: 5_000 });
}

/**
 * Park the body's scroller at an absolute offset, leaving the plugin a frame
 * to recompute in.
 * @param page - The page the document is on.
 * @param y - Where to park it.
 */
export async function scrollBodyTo(page: Page, y: number): Promise<void> {
  await page.evaluate((top) => {
    document
      .querySelector('.doc-body-scroller [data-radix-scroll-area-viewport]')
      ?.scrollTo(0, top);
  }, y);
  await page.waitForTimeout(400);
}

/**
 * Type a body long enough to scroll.
 * @param page - The page the document is on.
 */
export async function typeLongBody(page: Page): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.type(`line ${i} of a document long enough to scroll`);
    await page.keyboard.press('Enter');
  }
}

/**
 * Where the bar sits relative to the selected line, and whether it was painted.
 * @param page - The page the bar is on.
 * @returns The line's top, which side the bar took, the gap, and whether the
 *   bar answers a hit test on its own top edge.
 */
export async function readGeometry(page: Page): Promise<{
  lineTop: number;
  below: boolean;
  gap: number;
  hitAtOwnTop: boolean;
}> {
  return page.evaluate(() => {
    const bar = document.querySelector(
      '[data-testid="doc-selection-bubble-bar"]',
    ) as HTMLElement;
    const b = bar.getBoundingClientRect();
    const line = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
    const below = !!line && b.top >= line.bottom;
    return {
      lineTop: line ? Math.round(line.top) : 0,
      below,
      gap: line
        ? Math.round(below ? b.top - line.bottom : line.top - b.bottom)
        : -1,
      // Hit tested on the bar's own top edge: answering there is what says
      // that row of pixels was actually painted.
      hitAtOwnTop: !!document
        .elementFromPoint(b.left + b.width / 2, b.top + 2)
        ?.closest('[data-testid="doc-selection-bubble-bar"]'),
    };
  });
}

/**
 * Walk the pointer onto one opener and wait for its menu.
 *
 * Step-wise: `.hover()` teleports, and Radix
 * decides from pointer events, so a jump delivers none and the menu never
 * opens.
 * @param page - The page the bar is on.
 * @param slot - The opener's test id.
 * @returns The menu element's locator.
 */
export async function hoverOpenSlot(page: Page, slot: string): Promise<Locator> {
  const opener = page.getByTestId(slot);
  const box = (await opener.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 12,
  });
  const menu = page.getByTestId(`${slot}-menu`);
  await expect(menu).toBeVisible({ timeout: 5_000 });
  return menu;
}

/**
 * Select the whole document, which takes two presses of `Mod-a`.
 *
 * One is not enough: measured, the first takes the block the caret is in and
 * still reads as a partial selection. The judgement is `AllSelection`, which
 * only holds after the second.
 * @param page - The page the document is on.
 */
export async function selectWholeDocument(page: Page): Promise<void> {
  const mod = process.platform === 'darwin' ? 'Meta+a' : 'Control+a';
  await page.keyboard.press(mod);
  await page.keyboard.press(mod);
  await page.waitForTimeout(400);
}

/**
 * Whether the bar is on screen right now, and where.
 * @param page - The page the bar is on.
 * @returns Whether it shows, and its left and top when it does.
 */
export async function readBar(page: Page): Promise<{
  shown: boolean;
  left: number | null;
  top: number | null;
}> {
  return page.evaluate(() => {
    const el = document.querySelector(
      '[data-testid="doc-selection-bubble-bar"]',
    ) as HTMLElement | null;
    // Not showing takes two shapes and both count: the plugin takes the
    // element out of the document (`element.remove()` inside `hide()`), or the
    // `hide` middleware sets `visibility: hidden`. Asking the DOM alone reads
    // the second one as showing.
    if (!el || !el.isConnected) return { shown: false, left: null, top: null };
    if (getComputedStyle(el).visibility === 'hidden') {
      return { shown: false, left: null, top: null };
    }
    const b = el.getBoundingClientRect();
    return { shown: true, left: Math.round(b.left), top: Math.round(b.top) };
  });
}
