// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A questionnaire the agent puts to the reader, in a browser (inner#1542).
 *
 * Two cases answer the turn requests here with streams written the way the
 * server writes them, so they reach the card without a model: the card
 * numbers its questions, sends every answer with one press through the
 * conversation's own stream, and draws what the turn says next below its
 * summary; a message written instead closes it as replied to. One case runs a
 * real turn: the model asks, the card is still waiting after a reload, and
 * answering it resumes the turn. That the answer is taken once, kept beside
 * the call and replayed is checked against a real store in the server's
 * `questionnaire-pause-resume.integration.test.ts`.
 */
import { expect, type Page, type Route } from 'playwright/test';
import { test } from '../helpers/slot';
import { startNewConversation } from '../helpers/conversation';
import { openSmokeProject } from '../helpers/project';

let page: Page;

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await openSmokeProject(page);
  await startNewConversation(page);
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
});

test.afterEach(async () => {
  await page.close();
});

/** The questionnaire the served turn puts. */
const QUESTIONS = {
  questions: [
    { header: 'Ratio', question: 'Which ratio?', multiSelect: false, options: [{ label: '16:9' }, { label: '9:16' }] },
    { header: 'Mood', question: 'Any mood in mind?', multiSelect: false, options: [] },
  ],
};

/**
 * A stream the way the server writes one.
 * @param chunks - What follows the opening.
 * @returns The response body.
 */
function stream(chunks: object[]): string {
  const opening = [
    { type: 'data-heartbeat', transient: true, data: {} },
    { type: 'data-conversation-titled', data: { title: 'questionnaire' } },
  ];
  return [...opening, ...chunks].map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
}

/** A turn that stops at the card. */
const ASKS = stream([
  { type: 'start', messageId: 'm-reply' },
  { type: 'start-step' },
  { type: 'text-start', id: 't0' },
  { type: 'text-delta', id: 't0', delta: 'Two things first.' },
  { type: 'text-end', id: 't0' },
  { type: 'tool-input-available', toolCallId: 'ask-1', toolName: 'ask_user', input: QUESTIONS },
  { type: 'finish-step' },
  { type: 'data-ask-awaiting', data: { toolCallId: 'ask-1' } },
  { type: 'finish' },
]);

/**
 * Serve the turn requests in order, and keep what each one sent.
 * @param answers - The body for each request, in order.
 * @returns What each request carried.
 */
async function serve(answers: string[]): Promise<Array<Record<string, unknown>>> {
  const sent: Array<Record<string, unknown>> = [];
  await page.route('**/chat/message', async (route: Route) => {
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    const body = answers[sent.length - 1] ?? stream([{ type: 'finish' }]);
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body });
  });
  return sent;
}

/** Say something and wait for the card. */
async function askAndWaitForTheCard(): Promise<void> {
  const composer = page.getByTestId('chat-composer-box');
  await composer.fill('make me a poster');
  await composer.press('Enter');
  await expect(page.getByTestId('questionnaire-submit')).toBeVisible({ timeout: 20_000 });
}

test('the card numbers its questions and sends every answer with one press, the turn going on below it', async () => {
  const sent = await serve([
    ASKS,
    stream([
      { type: 'tool-output-available', toolCallId: 'ask-1', output: { answers: [{ index: 0, selected: ['9:16'] }, { index: 1, selected: [], other: 'Calm' }] } },
      // The server names the resumed reply afresh, as it does every reply.
      { type: 'start', messageId: 'm-reply-resumed' },
      { type: 'start-step' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Here is the plan.' },
      { type: 'text-end', id: 't1' },
      { type: 'finish-step' },
      { type: 'finish' },
    ]),
  ]);
  await askAndWaitForTheCard();

  await expect(page.getByTestId('questionnaire-question-label')).toHaveText(['1. Ratio', '2. Mood']);
  const [ratio, mood] = await page.getByTestId('questionnaire-question').all();
  await ratio!.getByRole('radio').nth(1).click();
  await mood!.getByRole('textbox').fill('Calm');
  await page.getByTestId('questionnaire-submit').click();

  await expect(page.getByTestId('questionnaire-summary-row')).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByText('Here is the plan.')).toBeVisible();
  // The answered card is drawn once.
  await expect(page.getByTestId('questionnaire-card')).toHaveCount(1);
  expect(sent[1]).toMatchObject({
    message: '',
    answer: { toolCallId: 'ask-1', answers: [{ index: 0, selected: ['9:16'] }, { index: 1, selected: [], other: 'Calm' }] },
  });
  // The resumed reply is drawn after the card, not above it.
  const card = await page.getByTestId('questionnaire-card').boundingBox();
  const plan = await page.getByText('Here is the plan.').boundingBox();
  expect(plan!.y).toBeGreaterThan(card!.y + card!.height - 1);
  // Nothing of the reader's was added to the list.
  await expect(page.locator('[data-testid="message-bubble"][data-role="user"]')).toHaveCount(1);
});

test('a message written instead closes the card as replied to', async () => {
  await serve([
    ASKS,
    stream([
      { type: 'data-ask-replied', data: { toolCallId: 'ask-1' } },
      { type: 'start', messageId: 'm-reply-2' },
      { type: 'start-step' },
      { type: 'text-start', id: 't2' },
      { type: 'text-delta', id: 't2', delta: 'Sure.' },
      { type: 'text-end', id: 't2' },
      { type: 'finish-step' },
      { type: 'finish' },
    ]),
  ]);
  await askAndWaitForTheCard();

  const composer = page.getByTestId('chat-composer-box');
  await composer.fill('1. 9:16 2. calm');
  await composer.press('Enter');

  await expect(page.getByTestId('questionnaire-replied-toggle')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('questionnaire-submit')).toHaveCount(0);
  // The turn the message started is one reply, not an empty one ahead of it.
  await expect(page.getByText('Sure.')).toBeVisible();
  await expect(page.getByTestId('message-bubble-empty')).toHaveCount(0);
});

test('a real turn asks with a card that waits through a reload, and answering resumes it @needs-model', async () => {
  const composer = page.getByTestId('chat-composer-box');
  await composer.fill(
    'I want a 30-second product video but have not decided the aspect ratio or the mood. ' +
      'Before you plan anything, ask me both in one questionnaire card, with options for each.',
  );
  await composer.press('Enter');
  await expect(page.getByTestId('questionnaire-submit')).toBeVisible({ timeout: 90_000 });
  const questions = await page.getByTestId('questionnaire-question-label').allInnerTexts();
  expect(questions.length).toBeGreaterThanOrEqual(1);

  await page.reload();
  await expect(page.getByTestId('questionnaire-submit')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('questionnaire-question-label')).toHaveText(questions);

  // Words on the first question's Other line answer it whatever options the
  // model chose to offer.
  await page.getByTestId('questionnaire-question').first().getByRole('textbox').fill('Vertical, 9:16');
  await page.getByTestId('questionnaire-submit').click();

  await expect(page.getByTestId('questionnaire-summary-row').first()).toContainText('Vertical, 9:16', {
    timeout: 30_000,
  });
  // While the model has said nothing yet, the wait is drawn below the
  // answered card, where what it says will arrive.
  const dot = await page.getByTestId('chat-waiting-dot').boundingBox();
  const answered = await page.getByTestId('questionnaire-card').first().boundingBox();
  expect(dot!.y).toBeGreaterThan(answered!.y + answered!.height - 1);
  await expect(page.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 120_000 });
  // The answered card is drawn once. The model may ask again in a card of its
  // own, so it is the answer that is counted, not the cards.
  await expect(page.getByTestId('questionnaire-summary-row').filter({ hasText: 'Vertical, 9:16' })).toHaveCount(1);
  // The resumed reply is drawn as a message of its own below the card.
  await expect
    .poll(() => page.locator('[data-testid="message-bubble"][data-role="assistant"]').count())
    .toBeGreaterThanOrEqual(2);
});
