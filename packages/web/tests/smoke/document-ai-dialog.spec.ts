// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The document AI output dialog in a real browser (inner#1860, design §5.3):
 * what only a browser shows. The panel stays hidden until it is positioned,
 * and a browser ignores focus on a hidden element; it hangs under the last
 * line of the selection whichever end was dragged from; it waits with the
 * Agent's dot; Escape typed in the body reaches it past BlockNote's own.
 *
 * The text tool request is intercepted and held, then answered with SSE
 * frames: the model is not what is tested here.
 *
 * Wants dev running:
 *   pnpm --filter @breatic/web test:smoke
 */
import { expect, type Page, type Route } from 'playwright/test';

import { hoverOpenSlot, openFreshDocument, selectParagraph, test } from '../helpers/bubble-bar';
import { pressAndSettle } from '../helpers/editor-keys';
import { DOCUMENT_EDITOR as EDITOR } from '../helpers/space';

const DIALOG = '[data-testid="doc-ai-dialog"]';
const DOT = `${DIALOG} [data-testid="chat-waiting-dot"]`;
/** The body itself: the preview draws copies of its ancestors inside the dialog. */
const BODY = `${EDITOR}:not(${DIALOG} *)`;
const LONG =
  'The orange cat leaps from the alley into the rain. The camera follows it across puddles lit by neon, '
  + 'past the shuttered stalls and the bus stop where nobody waits, and stops at the crossing when the light turns red. '
  + 'Somewhere behind it a tram bell rings twice and the rain grows heavier over the bridge.';

/**
 * Holds every text tool request until released, then answers it.
 * @param page - The page.
 * @returns Releases the held requests with the given words.
 */
async function holdTextTool(page: Page): Promise<(words: string) => void> {
  const held: Route[] = [];
  let answer: string | null = null;
  const reply = (route: Route, words: string): Promise<void> => route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: `event: text_delta\ndata: ${JSON.stringify({ text: words })}\n\nevent: done\ndata: {"type":"done"}\n\n`,
  });
  await page.route('**/mini-tools/text', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    if (answer !== null) return reply(route, answer);
    held.push(route);
    return undefined;
  });
  return (words) => {
    answer = words;
    for (const route of held.splice(0)) void reply(route, words);
  };
}

/**
 * Opens the AI menu over the selection and presses one of its rows.
 * @param page - The page.
 * @param row - The row: refine, custom, …
 */
async function pressAi(page: Page, row: string): Promise<void> {
  const menu = await hoverOpenSlot(page, 'doc-bubble-ai');
  await menu.getByTestId(`doc-bubble-ai-item-${row}`).click();
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 10_000 });
  // The menu plays its closing animation for a moment after the press, and
  // until it is gone Radix takes Escape for it, as for any closing menu.
  await expect(page.getByTestId('doc-bubble-ai-menu')).toHaveCount(0, { timeout: 5_000 });
}

test('waits with the Agent dot, then shows the words without it', async ({ page }) => {
  const release = await holdTextTool(page);
  await openFreshDocument(page);
  await page.keyboard.type('alpha bravo');
  await selectParagraph(page, 0);

  await pressAi(page, 'refine');

  await expect(page.locator(DOT)).toBeVisible();
  release('Alpha, bravo.');
  await expect(page.getByTestId('doc-ai-preview')).toContainText('Alpha, bravo.', { timeout: 10_000 });
  await expect(page.locator(DOT)).toHaveCount(0);
});

test('hangs under the last line of a selection made from the bottom up, inside the viewport', async ({ page }) => {
  const release = await holdTextTool(page);
  await openFreshDocument(page);
  await page.keyboard.type(LONG);
  // The caret ends the paragraph; two lines up puts the head above the end.
  await pressAndSettle(page, 'Shift+ArrowUp');
  await pressAndSettle(page, 'Shift+ArrowUp');
  const selection = await page.evaluate(() => {
    const s = window.getSelection()!;
    const range = s.getRangeAt(0);
    const rects = [...range.getClientRects()];
    return {
      backward: s.anchorNode === range.endContainer && s.anchorOffset === range.endOffset,
      bottom: Math.max(...rects.map((r) => r.bottom)),
      lines: new Set(rects.map((r) => Math.round(r.top))).size,
    };
  });
  expect(selection.backward).toBe(true);
  expect(selection.lines).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible({ timeout: 5_000 });

  await pressAi(page, 'refine');
  release('Rewritten.');
  await expect(page.getByTestId('doc-ai-replace')).toBeVisible({ timeout: 10_000 });

  const dialog = (await page.locator(DIALOG).boundingBox())!;
  const viewport = (await page.locator(BODY).evaluate((el) => {
    const scroller = el.closest('[data-radix-scroll-area-viewport]') as HTMLElement;
    const box = scroller.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom };
  }));
  expect(dialog.y).toBeGreaterThanOrEqual(selection.bottom);
  expect(dialog.y).toBeGreaterThanOrEqual(viewport.top);
  expect(dialog.y + dialog.height).toBeLessThanOrEqual(viewport.bottom + 1);
});

test('the custom box takes the keyboard as it shows', async ({ page }) => {
  await holdTextTool(page);
  await openFreshDocument(page);
  await page.keyboard.type('alpha bravo');
  await selectParagraph(page, 0);

  await pressAi(page, 'custom');

  await expect(page.getByTestId('doc-ai-instructions')).toBeFocused();
  await page.keyboard.type('Make it a haiku');
  await expect(page.getByTestId('doc-ai-instructions')).toHaveValue('Make it a haiku');
});

test('one Escape in the body closes the dialog and the body keeps the keyboard', async ({ page }) => {
  await holdTextTool(page);
  await openFreshDocument(page);
  await page.keyboard.type('alpha bravo');
  await selectParagraph(page, 0);

  await pressAi(page, 'refine');
  await expect(page.locator(BODY)).toBeFocused();

  await page.keyboard.press('Escape');

  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(page.locator(BODY)).toBeFocused();
});
