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

test('a tool step that failed while the turn carried on gets a line of its own', async ({
  page,
}) => {
  await answerWith(page, [
    { type: 'start-step' },
    { type: 'tool-input-available', toolCallId: 'c1', toolName: 'web_search', input: { query: 'cats' } },
    { type: 'tool-output-error', toolCallId: 'c1', errorText: 'chat.tool.failure.upstream' },
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
  await expect(page.getByTestId('message-bubble-tool-failed')).toHaveText('Execution error');
  await expect(page.getByTestId('message-bubble-content').last()).toHaveText(
    'Carrying on without it.',
  );
  await expect(page.getByTestId('message-bubble-error')).toHaveCount(0);
});
