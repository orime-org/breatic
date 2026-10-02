// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A turn that failed, said nothing, or had a step fail leaves a line that stays (#324).
 *
 * A real model cannot be made to end any of these ways on demand, so the turn
 * request is answered here with a stream written to open the way the server's
 * does: the heartbeat, the conversation's title, then `start` with an id
 * (`routes/chat.ts`, `main-agent.ts`). What each case checks is that the line
 * is on screen once the turn has settled and is still there after the
 * four-second notice has gone. That the same lines come back when the
 * conversation is reopened is checked against a real store in the server's
 * `turn-message-shape.integration.test.ts`.
 */
import { expect, test, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';

test.use({ storageState: STATE_FILE.A, viewport: { width: 1500, height: 900 } });

/** How the server opens every turn. */
const OPENING = [
  { type: 'data-heartbeat', transient: true, data: {} },
  { type: 'data-conversation-titled', data: { title: 'outcome' } },
  { type: 'start', messageId: 'm-reply' },
];

/** How long the notice stays up (`notice-timing.ts`), plus room to settle. */
const PAST_THE_NOTICE_MS = 4_500;

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
 * Open a fresh conversation, send one message and wait for the turn to settle.
 * @param page - The signed-in page.
 */
async function sendOne(page: Page): Promise<void> {
  await openSmokeProject(page);
  await page.getByTestId('new-conversation').click();
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
  const composer = page.getByTestId('chat-composer-textarea');
  await composer.fill('outcome probe');
  await composer.press('Enter');
  await expect(page.getByTestId('message-bubble')).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 20_000 });
}

test('a turn that fails before its first word keeps its failure line', async ({ page }) => {
  await answerWith(page, [{ type: 'error', errorText: 'The turn could not be run.' }]);
  await sendOne(page);

  await page.waitForTimeout(PAST_THE_NOTICE_MS);
  await expect(page.getByTestId('chat-notice')).toHaveCount(0);
  await expect(page.getByTestId('message-bubble-error')).toHaveText(
    'This reply could not be finished. Try sending it again.',
  );
});

test('a turn that produced nothing says so', async ({ page }) => {
  await answerWith(page, [{ type: 'start-step' }, { type: 'finish-step' }, { type: 'finish' }]);
  await sendOne(page);

  await page.waitForTimeout(PAST_THE_NOTICE_MS);
  await expect(page.getByTestId('message-bubble-empty')).toHaveText('No reply this turn');
});

test('tool steps that failed the same way while the turn carried on share one line', async ({
  page,
}) => {
  await answerWith(page, [
    { type: 'start-step' },
    { type: 'tool-input-available', toolCallId: 'c1', toolName: 'web_search', input: { query: 'cats' } },
    { type: 'tool-output-error', toolCallId: 'c1', errorText: 'chat.tool.failure.upstream' },
    { type: 'tool-input-available', toolCallId: 'c2', toolName: 'web_search', input: { query: 'dogs' } },
    { type: 'tool-output-error', toolCallId: 'c2', errorText: 'chat.tool.failure.unreachable' },
    { type: 'finish-step' },
    { type: 'start-step' },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: 'Carrying on without it.' },
    { type: 'text-end', id: 't' },
    { type: 'finish-step' },
    { type: 'finish' },
  ]);
  await sendOne(page);

  await page.waitForTimeout(PAST_THE_NOTICE_MS);
  await expect(page.getByTestId('message-bubble-tool-failed')).toHaveText(['Execution error ×2']);
  await expect(page.getByTestId('message-bubble-content').last()).toHaveText(
    'Carrying on without it.',
  );
  await expect(page.getByTestId('message-bubble-error')).toHaveCount(0);
});

test('calls turned away to steer the model draw no line, and only one question is asked', async ({
  page,
}) => {
  // In the order the server sends them (#996): the first question answered and
  // written into the reply, a second question turned away, input the SDK
  // refused -- first as an input error, then as the output error that
  // follows it -- and a second media call turned away while one was running.
  await answerWith(page, [
    { type: 'start-step' },
    { type: 'tool-input-available', toolCallId: 'q1', toolName: 'ask_user', input: { question: 'Which style?' } },
    { type: 'tool-output-available', toolCallId: 'q1', output: { question: 'Which style?' } },
    { type: 'text-start', id: 'ask-q1' },
    { type: 'text-delta', id: 'ask-q1', delta: '\n\nWhich style?\n\n' },
    { type: 'text-end', id: 'ask-q1' },
    { type: 'tool-input-available', toolCallId: 'q2', toolName: 'ask_user', input: { question: 'How long?' } },
    { type: 'tool-output-error', toolCallId: 'q2', errorText: 'turned_away' },
    {
      type: 'tool-input-error',
      toolCallId: 'bad',
      toolName: 'web_search',
      input: { query: 5 },
      errorText: 'chat.tool.failure.generic',
    },
    { type: 'tool-output-error', toolCallId: 'bad', errorText: 'turned_away' },
    { type: 'tool-input-available', toolCallId: 'm2', toolName: 'understand_media', input: { url: 'https://example.com/b.mp4' } },
    { type: 'tool-output-error', toolCallId: 'm2', errorText: 'turned_away' },
    { type: 'finish-step' },
    { type: 'data-blocked', data: {} },
    { type: 'finish' },
  ]);
  await sendOne(page);

  await page.waitForTimeout(PAST_THE_NOTICE_MS);
  await expect(page.getByTestId('message-bubble-tool-failed')).toHaveCount(0);
  await expect(page.getByTestId('message-bubble-content').last()).toHaveText('Which style?');
});
