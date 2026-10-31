// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A turn that goes over the model's context window (inner#1567).
 *
 * Two endings a real model cannot be made to produce on demand: the server
 * folds memory partway through a reply and carries on, or it cannot make the
 * request fit and ends the turn as too long. The turn request is answered
 * here with a stream that opens the way the server's does (heartbeat, title,
 * `start` with an id; `routes/chat.ts`, `main-agent.ts`). The too-long ending
 * is a `data-failed` frame carrying `reason: "too_long"` followed by an
 * ordinary `finish`, with no error frame.
 */
import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { startNewConversation } from '../helpers/conversation';

import { openSmokeProject } from '../helpers/project';

test.use({ viewport: { width: 1500, height: 900 } });

/** How the server opens every turn. */
const OPENING = [
  { type: 'data-heartbeat', transient: true, data: {} },
  { type: 'data-conversation-titled', data: { title: 'overflow' } },
  { type: 'start', messageId: 'm-reply' },
];

/** The English line for a turn ended as too long (`chat.error.turnTooLong`). */
const TOO_LONG = 'This turn had too much to process and could not finish. Try a narrower request.';

/** The English line for an ordinary failed turn (`chat.error.turnFailed`). */
const FAILED = 'This reply could not be finished. Try sending it again.';

/**
 * Answer the next turn with these chunks, after the server's opening.
 * @param page - The signed-in page.
 * @param chunks - What the turn streams.
 */
async function answerWith(page: Page, chunks: object[]): Promise<void> {
  const body = [...OPENING, ...chunks].map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
  await page.route('**/chat/message', (route) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body }),
  );
}

/**
 * Open a fresh conversation and send one message.
 * @param page - The signed-in page.
 */
async function send(page: Page): Promise<void> {
  await openSmokeProject(page);
  await startNewConversation(page);
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
  const composer = page.getByTestId('chat-composer-box');
  await composer.fill('overflow probe');
  await composer.press('Enter');
  await expect(page.getByTestId('message-bubble')).toHaveCount(2, { timeout: 20_000 });
}

/**
 * Wait for the running turn to settle.
 * @param page - The signed-in page.
 */
async function settled(page: Page): Promise<void> {
  await expect(page.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 20_000 });
}

/**
 * Open a fresh conversation, send one message and wait for the turn to settle.
 * @param page - The signed-in page.
 */
async function sendOne(page: Page): Promise<void> {
  await send(page);
  await settled(page);
}

/**
 * Hold every turn's stream right after its fold frame until the case lets it
 * go, so what the panel shows during the fold can be looked at.
 *
 * `route.fulfill` hands the page the whole body at once, and the notice is up
 * only between the fold frame and the next answering one, so with the body
 * unsplit it is never drawn. The routed response is re-streamed in two parts
 * by the page's own `fetch`, which the chat transport calls.
 * @param page - The page, before it loads.
 */
async function holdAfterTheFold(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const held = window as unknown as { releaseFold?: () => void };
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const res = await real(input, init);
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes('/chat/message')) return res;
      const text = await res.text();
      const cut = text.indexOf('\n\n', text.indexOf('data-memory-consolidating')) + 2;
      const released = new Promise<void>((resolve) => {
        held.releaseFold = resolve;
      });
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(text.slice(0, cut)));
          await released;
          controller.enqueue(encoder.encode(text.slice(cut)));
          controller.close();
        },
      });
      return new Response(body, { status: res.status, headers: res.headers });
    };
  });
}

/**
 * A step that writes one paragraph.
 * @param id - The text part's id.
 * @param text - The paragraph.
 * @returns The step's chunks.
 */
function step(id: string, text: string): object[] {
  return [
    { type: 'start-step' },
    { type: 'text-start', id },
    { type: 'text-delta', id, delta: text },
    { type: 'text-end', id },
    { type: 'finish-step' },
  ];
}

test('a reply that folds memory partway carries on in the same reply', async ({ page }) => {
  await holdAfterTheFold(page);
  await answerWith(page, [
    ...step('t1', 'Before the fold.'),
    { type: 'data-memory-consolidating', transient: true, data: {} },
    ...step('t2', 'After the fold.'),
    { type: 'finish' },
  ]);
  await send(page);

  const reply = page.getByTestId('message-bubble').last();
  // Mid-reply: what was written so far, and the notice beside it.
  await expect(reply).toContainText('Before the fold.');
  await expect(page.getByTestId('chat-message-consolidating')).toHaveText('Tidying up this conversation\'s memory…');

  await page.evaluate(() => (window as unknown as { releaseFold?: () => void }).releaseFold?.());
  await settled(page);

  await expect(page.getByTestId('message-bubble')).toHaveCount(2);
  await expect(reply).toContainText('Before the fold.');
  await expect(reply).toContainText('After the fold.');
  await expect(page.getByTestId('chat-message-consolidating')).toHaveCount(0);
  await expect(page.getByTestId('message-bubble-error')).toHaveCount(0);
});

test('a turn too long to fit says so and does not ask to be sent again', async ({ page }) => {
  // The server says how long the turn thought before it ends as too long,
  // the way a turn that finishes does.
  await answerWith(page, [
    { type: 'reasoning-start', id: 'r1' },
    { type: 'reasoning-delta', id: 'r1', delta: 'weighing it up' },
    { type: 'reasoning-end', id: 'r1' },
    { type: 'data-thinking-time', data: { ms: 3_000 } },
    { type: 'data-failed', data: { reason: 'too_long' } },
    { type: 'finish' },
  ]);
  await sendOne(page);

  await expect(page.getByTestId('message-bubble-error')).toHaveText(TOO_LONG);
  await expect(page.getByTestId('thinking-fold')).toContainText('Thought for 3 s');
  // The ordinary failure's only offer to retry is its sentence; TurnEnding
  // draws no button for either ending.
  const reply = page.getByTestId('message-bubble').last();
  await expect(reply).not.toContainText(FAILED);
  await expect(reply).not.toContainText('sending it again');
});

test('a failed turn with no reason keeps the ordinary failure line', async ({ page }) => {
  await answerWith(page, [{ type: 'data-failed', data: {} }, { type: 'finish' }]);
  await sendOne(page);

  await expect(page.getByTestId('message-bubble-error')).toHaveText(FAILED);
});
