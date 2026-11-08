// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The document AI output dialog in a real browser (inner#1860, design §5.3):
 * what only a browser shows. The panel stays hidden until it is positioned,
 * and a browser ignores focus on a hidden element; it takes the keyboard as it
 * shows and gives it back to the body as it closes; it hangs under the last
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
  // The user goes back to the body while the dialog stays open.
  await page.locator(BODY).click();
  await expect(page.locator(BODY)).toBeFocused();

  await page.keyboard.press('Escape');

  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(page.locator(BODY)).toBeFocused();
});

test('the dialog takes the keyboard, Tab reaches its buttons, and Escape hands it back to the body', async ({ page }) => {
  const release = await holdTextTool(page);
  await openFreshDocument(page);
  await page.keyboard.type('alpha bravo');
  await selectParagraph(page, 0);

  await pressAi(page, 'refine');
  await expect(page.locator(DIALOG)).toBeFocused();
  release('Alpha, bravo.');
  await expect(page.getByTestId('doc-ai-replace')).toBeVisible({ timeout: 10_000 });

  const reached: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press('Tab');
    reached.push(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? ''));
  }
  expect(reached).toEqual(expect.arrayContaining(['doc-ai-retry', 'doc-ai-insert', 'doc-ai-replace']));

  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(page.locator(BODY)).toBeFocused();
});

/**
 * Answers every text tool request with the given response and keeps the bodies sent.
 * @param page - The page.
 * @param answer - The status and body to answer with.
 * @param answer.status - The HTTP status.
 * @param answer.body - The response body.
 * @param answer.sse - Whether the body is a server-sent event stream.
 * @returns The request bodies, as they are sent.
 */
async function answerTextTool(page: Page, answer: { status: number; body: string; sse: boolean }): Promise<Record<string, unknown>[]> {
  const sent: Record<string, unknown>[] = [];
  await page.route('**/mini-tools/text', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      status: answer.status,
      headers: { 'content-type': answer.sse ? 'text/event-stream' : 'application/json' },
      body: answer.body,
    });
  });
  return sent;
}

/**
 * An SSE body: the words as one delta, then done unless the stream breaks off.
 * @param words - The words.
 * @param ends - Whether done follows.
 * @returns The body.
 */
function streamOf(words: string, ends = true): string {
  return `event: text_delta\ndata: ${JSON.stringify({ text: words })}\n\n${ends ? 'event: done\ndata: {"type":"done"}\n\n' : ''}`;
}

const UNDO = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';

test('refine, replace, and undo brings the original back', async ({ page }) => {
  await answerTextTool(page, { status: 200, body: streamOf('Alpha, bravo.'), sse: true });
  await openFreshDocument(page);
  await page.keyboard.type('alpha bravo');
  await selectParagraph(page, 0);

  await pressAi(page, 'refine');
  await page.getByTestId('doc-ai-replace').click();

  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(page.locator(`${BODY} p`).first()).toHaveText('Alpha, bravo.');
  await expect(page.locator(BODY)).toBeFocused();
  await page.keyboard.press(UNDO);
  await expect(page.locator(`${BODY} p`).first()).toHaveText('alpha bravo');
});

test('a selection across two lines widens to both, and replace pastes the answer over them', async ({ page }) => {
  const sent = await answerTextTool(page, { status: 200, body: streamOf('One.\n\nTwo.'), sse: true });
  await openFreshDocument(page);
  await page.keyboard.type('first line');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second line');
  await page.keyboard.press('Enter');
  await page.keyboard.type('third line');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');

  await pressAi(page, 'refine');
  expect(sent[0]).toMatchObject({ selection: 'first line\n\nsecond line' });
  await expect(page.locator(`${BODY} [data-show-selection]`)).toHaveText(['first line', 'second line']);
  await page.getByTestId('doc-ai-replace').click();

  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(page.locator(`${BODY} p`)).toHaveText(['One.', 'Two.', 'third line']);
  await page.keyboard.press(UNDO);
  await expect(page.locator(`${BODY} p`)).toHaveText(['first line', 'second line', 'third line']);
});

test('translate into Japanese names the language in the title and the request', async ({ page }) => {
  const sent = await answerTextTool(page, { status: 200, body: streamOf('アルファ、ブラボー。'), sse: true });
  await openFreshDocument(page);
  await page.keyboard.type('alpha bravo');
  await selectParagraph(page, 0);

  const menu = await hoverOpenSlot(page, 'doc-bubble-ai');
  await menu.getByTestId('doc-bubble-ai-item-translate').hover();
  await page.getByTestId('doc-bubble-ai-translate-item-ja').click();

  await expect(page.getByTestId('doc-ai-title')).toContainText('日本語');
  await expect(page.getByTestId('doc-ai-preview')).toContainText('アルファ', { timeout: 10_000 });
  expect(sent[0]).toMatchObject({ tool: 'translate', language: 'ja', selection: 'alpha bravo' });
});

test('a custom instruction goes out with Enter', async ({ page }) => {
  const sent = await answerTextTool(page, { status: 200, body: streamOf('A haiku.'), sse: true });
  await openFreshDocument(page);
  await page.keyboard.type('alpha bravo');
  await selectParagraph(page, 0);

  await pressAi(page, 'custom');
  await page.keyboard.type('Make it a haiku');
  await page.keyboard.press('Enter');

  await expect(page.getByTestId('doc-ai-preview')).toContainText('A haiku.', { timeout: 10_000 });
  expect(sent[0]).toMatchObject({ tool: 'custom', instructions: 'Make it a haiku' });
  await expect(page.getByTestId('doc-ai-instruction')).toContainText('Make it a haiku');
});

test('a custom instruction goes out with the start button, which waits for words', async ({ page }) => {
  const sent = await answerTextTool(page, { status: 200, body: streamOf('A haiku.'), sse: true });
  await openFreshDocument(page);
  await page.keyboard.type('alpha bravo');
  await selectParagraph(page, 0);

  await pressAi(page, 'custom');
  const start = page.getByTestId('doc-ai-start');
  await expect(start).toBeDisabled();
  await page.keyboard.type('Make it a haiku');
  await expect(start).toBeEnabled();
  await start.click();

  await expect(page.getByTestId('doc-ai-preview')).toContainText('A haiku.', { timeout: 10_000 });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ tool: 'custom', instructions: 'Make it a haiku' });
  await expect(page.getByTestId('doc-ai-instruction')).toContainText('Make it a haiku');
});

test('a refusal (402) says so and leaves close and retry', async ({ page }) => {
  await answerTextTool(page, {
    status: 402,
    body: JSON.stringify({ error: { code: 402, message: 'Not enough credits for this.' } }),
    sse: false,
  });
  await openFreshDocument(page);
  await page.keyboard.type('alpha bravo');
  await selectParagraph(page, 0);

  await pressAi(page, 'refine');

  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toContainText('Not enough credits for this.', { timeout: 10_000 });
  await expect(page.getByTestId('doc-ai-retry')).toBeVisible();
  await expect(page.getByTestId('doc-ai-replace')).toHaveCount(0);
});

test('a stream that breaks off says so and leaves close and retry', async ({ page }) => {
  await answerTextTool(page, { status: 200, body: streamOf('Alpha', false), sse: true });
  await openFreshDocument(page);
  await page.keyboard.type('alpha bravo');
  await selectParagraph(page, 0);

  await pressAi(page, 'refine');

  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('doc-ai-retry')).toBeVisible();
  await expect(page.getByTestId('doc-ai-replace')).toHaveCount(0);
});

/** A shot list of eight columns, wider than the dialog, as the storyboard tool answers. */
const SHOT_LIST = [
  '| Shot | Size | Angle | Movement | On screen | Dialogue and sound | Seconds | Notes |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  '| 1 | Wide | Eye level | Static | A girl rides through the foggy street | A bicycle bell | 4 | Dawn light |',
  '| 2 | Close-up | Low | Push in | The baker hands her a warm loaf | "Thank you!" | 3 | Steam rising |',
  '| 3 | Long | High | Crane up | She rides on toward the lighthouse | Waves | 5 | The lamp comes on |',
].join('\n');

test('draft a shot list: the preview scrolls the table sideways in its own frame, insert adds it, undo takes it away', async ({ page }) => {
  const sent = await answerTextTool(page, { status: 200, body: streamOf(`The morning ride.\n\n${SHOT_LIST}`), sse: true });
  await openFreshDocument(page);
  await page.keyboard.type('A girl rides through the fog to the sea.');
  await selectParagraph(page, 0);

  await pressAi(page, 'storyboard');

  await expect(page.getByTestId('doc-ai-title')).toHaveText(/./);
  await expect(page.getByTestId('doc-ai-insert')).toBeVisible({ timeout: 10_000 });
  // The selection goes out as Markdown, its full stop escaped.
  expect(sent[0]?.['tool']).toBe('storyboard');
  expect(String(sent[0]?.['selection'])).toContain('A girl rides through the fog to the sea');
  const preview = page.getByTestId('doc-ai-preview');
  const frame = preview.locator('.doc-table [data-radix-scroll-area-viewport]');
  await expect(frame).toHaveCount(1);
  await expect(preview.locator('table tr').first().locator('td, th')).toHaveCount(8);
  const sizes = await page.evaluate(() => {
    const host = document.querySelector('[data-testid="doc-ai-preview"]')!;
    const outer = host.closest<HTMLElement>('[data-radix-scroll-area-viewport]')!;
    const inner = host.querySelector<HTMLElement>('.doc-table [data-radix-scroll-area-viewport]')!;
    const words = [...host.querySelectorAll<HTMLElement>('p')].find((p) => p.textContent === 'The morning ride.')!;
    inner.scrollLeft = inner.scrollWidth;
    const last = host.querySelector('table tr')!.lastElementChild!.getBoundingClientRect();
    return {
      outerWidth: outer.clientWidth,
      outerScrolls: outer.scrollWidth > outer.clientWidth,
      innerScrolls: inner.scrollWidth > inner.clientWidth,
      wordsWidth: words.getBoundingClientRect().width,
      lastInside: last.right <= inner.getBoundingClientRect().right + 1,
    };
  });
  expect(sizes.innerScrolls).toBe(true);
  expect(sizes.outerScrolls).toBe(false);
  expect(sizes.wordsWidth).toBeLessThanOrEqual(sizes.outerWidth);
  expect(sizes.lastInside).toBe(true);

  await page.getByTestId('doc-ai-insert').click();

  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(page.locator(`${BODY} p`).first()).toHaveText('A girl rides through the fog to the sea.');
  await expect(page.locator(`${BODY} table`)).toHaveCount(1);
  await expect(page.locator(`${BODY} table tr`)).toHaveCount(4);
  await expect(page.locator(`${BODY} table tr`).first().locator('td, th')).toHaveCount(8);
  await page.keyboard.press(UNDO);
  await expect(page.locator(`${BODY} table`)).toHaveCount(0);
  await expect(page.locator(`${BODY} p`).first()).toHaveText('A girl rides through the fog to the sea.');
});

test('draft a shot list, replace puts the table where the description was', async ({ page }) => {
  await answerTextTool(page, { status: 200, body: streamOf(SHOT_LIST), sse: true });
  await openFreshDocument(page);
  await page.keyboard.type('A girl rides through the fog to the sea.');
  await selectParagraph(page, 0);

  await pressAi(page, 'storyboard');
  await page.getByTestId('doc-ai-replace').click();

  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(page.locator(`${BODY} table tr`)).toHaveCount(4);
  await expect(page.locator(BODY)).not.toContainText('A girl rides through the fog to the sea.');
  await page.keyboard.press(UNDO);
  await expect(page.locator(`${BODY} table`)).toHaveCount(0);
  await expect(page.locator(`${BODY} p`).first()).toHaveText('A girl rides through the fog to the sea.');
});

test('against the real model: a shot list from a Chinese description has eight columns headed in Chinese @needs-model', async ({ page }) => {
  await openFreshDocument(page);
  await page.keyboard.insertText('清晨，女孩骑车穿过起雾的小镇，在面包店接过一个刚出炉的面包，然后骑向海边的灯塔。');
  await selectParagraph(page, 0);

  await pressAi(page, 'storyboard');
  await expect(page.getByTestId('doc-ai-insert')).toBeVisible({ timeout: 90_000 });

  const preview = page.getByTestId('doc-ai-preview');
  await expect(preview.locator('table')).toHaveCount(1);
  const header = preview.locator('table tr').first().locator('td, th');
  await expect(header).toHaveCount(8);
  expect(await header.first().innerText()).toMatch(/[一-鿿]/);
  expect(await preview.locator('table tr').count()).toBeGreaterThan(1);
});

test('against the real model: a shot list from an English description has eight columns headed in English @needs-model', async ({ page }) => {
  await openFreshDocument(page);
  await page.keyboard.insertText('At dusk a fisherman rows back to the harbour, ties up his boat, and carries a basket of fish up the hill to his daughter.');
  await selectParagraph(page, 0);

  await pressAi(page, 'storyboard');
  await expect(page.getByTestId('doc-ai-insert')).toBeVisible({ timeout: 90_000 });

  const preview = page.getByTestId('doc-ai-preview');
  await expect(preview.locator('table')).toHaveCount(1);
  const header = preview.locator('table tr').first().locator('td, th');
  await expect(header).toHaveCount(8);
  const names = await header.allInnerTexts();
  expect(names.join(' ')).toMatch(/[A-Za-z]/);
  expect(names.join(' ')).not.toMatch(/[一-鿿]/);
  expect(await preview.locator('table tr').count()).toBeGreaterThan(1);
});

test('against the real model: refine, replace, and undo brings the original back @needs-model', async ({ page }) => {
  await openFreshDocument(page);
  await page.keyboard.type('the cat sat on the mat and it was very very happy there');
  await selectParagraph(page, 0);

  await pressAi(page, 'refine');
  await expect(page.getByTestId('doc-ai-replace')).toBeVisible({ timeout: 60_000 });
  const result = (await page.getByTestId('doc-ai-preview').innerText()).trim();
  expect(result.length).toBeGreaterThan(0);
  await page.getByTestId('doc-ai-replace').click();

  await expect(page.locator(`${BODY} p`).first()).not.toHaveText('the cat sat on the mat and it was very very happy there');
  await page.keyboard.press(UNDO);
  await expect(page.locator(`${BODY} p`).first()).toHaveText('the cat sat on the mat and it was very very happy there');
});
