// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Messages sent while the Agent answers (inner#1717), on a real model: they
 * wait above the box, the run reads them in at its next step, and nothing
 * the user sent is lost however the page comes and goes.
 *
 * The run is a long piece of prose, one step: a message sent while it is
 * written is read once that step ends, in the same reply. A model decides for
 * itself what it writes, so these cases look at where messages land and
 * whether the run went on, never at what the model said.
 */
import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { startNewConversation } from '../helpers/conversation';
import { openSmokeProject } from '../helpers/project';

/** A request whose answer takes long enough to send something meanwhile. */
const STORY = 'Write a 600-word short story about a lighthouse keeper. Reply in prose only, make nothing.';

/** How long a whole run on the model may take. */
const RUN_MS = 180_000;

/**
 * Type a message into the box and send it.
 * @param page - The page.
 * @param words - What to send.
 */
async function send(page: Page, words: string): Promise<void> {
  const box = page.getByTestId('chat-composer-box');
  await box.fill(words);
  await box.press('Enter');
}

/**
 * Wait until the reply on screen has started writing prose. The model may
 * think for a minute or more first.
 * @param page - The page.
 */
async function replyWriting(page: Page): Promise<void> {
  await expect(page.getByTestId('chat-composer-abort')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await page.locator('[data-testid="message-bubble"][data-role="assistant"] [data-testid="message-bubble-content"]').last().innerText().catch(() => '')).length, { timeout: RUN_MS })
    .toBeGreaterThan(20);
}

/**
 * Wait until no run is being read on the page.
 * @param page - The page.
 */
async function runOver(page: Page): Promise<void> {
  await expect(page.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: RUN_MS });
}

/**
 * The bubbles on screen, in order: who said it and the start of what they said.
 * @param page - The page.
 * @returns One line per bubble.
 */
async function bubbles(page: Page): Promise<string[]> {
  return page.getByTestId('message-bubble').evaluateAll((els) =>
    els.map((el) => `${el.getAttribute('data-role') ?? ''}:${(el.textContent ?? '').trim().slice(0, 24)}`),
  );
}

/**
 * Where the first user bubble saying these words is, and where the first reply is.
 * @param page - The page.
 * @param words - What the user sent.
 * @returns Their positions; -1 when absent.
 */
async function placeOf(page: Page, words: string): Promise<{ user: number; firstReply: number }> {
  const list = await bubbles(page);
  return {
    user: list.findIndex((b) => b.startsWith('user:') && b.includes(words.slice(0, 16))),
    firstReply: list.findIndex((b) => b.startsWith('assistant:')),
  };
}

/**
 * The conversation on screen, read off the list, which is then closed.
 * @param page - The page.
 * @returns Its id.
 */
async function currentConversation(page: Page): Promise<string> {
  await page.getByTestId('open-conversation-history').click();
  const current = page.getByTestId('conversation-history-list').locator('[data-testid^="conversation-open-"][aria-current]');
  await expect(current).toHaveCount(1, { timeout: 15_000 });
  const id = ((await current.getAttribute('data-testid')) ?? '').replace('conversation-open-', '');
  await page.keyboard.press('Escape');
  return id;
}

/**
 * Open a conversation from the list.
 * @param page - The page, on the project.
 * @param id - The conversation.
 */
async function openConversation(page: Page, id: string): Promise<void> {
  await page.getByTestId('open-conversation-history').click();
  await page.getByTestId(`conversation-open-${id}`).click();
}

/**
 * The waiting area's messages, by what they say.
 * @param page - The page.
 * @returns Each waiting message's words.
 */
function waiting(page: Page): ReturnType<Page['getByTestId']> {
  return page.getByTestId('chat-waiting-item');
}

test('a message sent while the reply runs waits above the box, then is read in the same reply (SM-01) @needs-model', async ({ page }) => {
  test.setTimeout(RUN_MS + 60_000);
  await openSmokeProject(page);
  await startNewConversation(page);
  const id = await currentConversation(page);
  await send(page, STORY);
  await replyWriting(page);

  const second = 'Now give the keeper a blue coat.';
  await send(page, second);
  await expect(waiting(page)).toHaveCount(1, { timeout: 15_000 });
  await expect(waiting(page).first()).toContainText(second);
  // Stop and send stand side by side: the run goes on.
  await expect(page.getByTestId('chat-composer-abort')).toBeVisible();

  await expect(waiting(page)).toHaveCount(0, { timeout: RUN_MS });
  await runOver(page);
  const at = await placeOf(page, second);
  expect(at.user).toBeGreaterThan(at.firstReply);
  expect(at.firstReply).toBeGreaterThan(-1);
  await expect(page.getByTestId('message-bubble-interrupted')).toHaveCount(0);
  // Read in the same reply, not answered by a run of its own: the store holds
  // it as a part of the reply, and never as a user row.
  const stored = await page.request.get(`/api/v1/chat/conversations/${id}`);
  expect(stored.ok()).toBe(true);
  const rows = ((await stored.json()) as { data: { messages: Array<{ role: string; parts: Array<{ type: string; text?: string; data?: { words?: string } }> }> } }).data.messages;
  expect(rows.filter((r) => r.role === 'user' && r.parts.some((p) => p.text === second))).toEqual([]);
  expect(rows.some((r) => r.role === 'assistant' && r.parts.some((p) => p.type === 'data-user-message' && p.data?.words === second))).toBe(true);
});

test('a reload while the reply runs attaches to it again, the message it read staying where it was (SM-02) @needs-model', async ({ page }) => {
  test.setTimeout(RUN_MS + 90_000);
  await openSmokeProject(page);
  await startNewConversation(page);
  await send(page, STORY);
  await replyWriting(page);
  const second = 'Make the lighthouse red and white.';
  await send(page, second);
  await expect(waiting(page)).toHaveCount(1, { timeout: 15_000 });

  await page.reload();
  // The run kept going on the server: the page reads it again, or it is over.
  await expect(page.getByTestId('message-bubble').first()).toBeVisible({ timeout: 30_000 });
  await runOver(page);
  await expect(waiting(page)).toHaveCount(0, { timeout: 15_000 });
  const before = await bubbles(page);
  const at = await placeOf(page, second);
  expect(at.user).toBeGreaterThan(at.firstReply);
  await expect(page.getByTestId('message-bubble-interrupted')).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('message-bubble')).toHaveCount(before.length, { timeout: 30_000 });
  expect(await bubbles(page)).toEqual(before);
});

test('two pages on one conversation show the same reply and the message one of them sent, in the same place (SM-03) @needs-model', async ({ browser }) => {
  test.setTimeout(RUN_MS + 90_000);
  const a = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const b = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await openSmokeProject(a);
    await startNewConversation(a);
    const id = await currentConversation(a);
    // Open on the other page first: a run on a fast model can be over before
    // a page opened afterwards gets there.
    await openSmokeProject(b);
    await openConversation(b, id);
    await send(a, STORY);
    await replyWriting(a);
    // The other page finds the run at its next sync and attaches to it.
    await replyWriting(b);
    const second = 'Add a storm at the end.';
    await send(b, second);
    await expect(waiting(b)).toHaveCount(1, { timeout: 15_000 });
    // The other page learns of it at its next sync.
    await expect(waiting(a)).toHaveCount(1, { timeout: 15_000 });

    await runOver(a);
    await runOver(b);
    await expect(waiting(a)).toHaveCount(0, { timeout: 15_000 });
    await expect(waiting(b)).toHaveCount(0, { timeout: 15_000 });
    const onA = await placeOf(a, second);
    expect(onA.user).toBeGreaterThan(onA.firstReply);
    expect(await placeOf(b, second)).toEqual(onA);
  } finally {
    await b.close();
    await a.close();
  }
});

test('a stop with two messages waiting stops the reply, and a new run answers them in order (SM-04) @needs-model', async ({ page }) => {
  test.setTimeout(2 * RUN_MS);
  await openSmokeProject(page);
  await startNewConversation(page);
  await send(page, STORY);
  await replyWriting(page);
  const two = 'Say one word: two.';
  const three = 'Say one word: three.';
  await send(page, two);
  await expect(waiting(page)).toHaveCount(1, { timeout: 15_000 });
  await send(page, three);
  await expect(waiting(page)).toHaveCount(2, { timeout: 15_000 });

  await page.getByTestId('chat-composer-abort').click();
  await expect(page.getByTestId('message-bubble-interrupted')).toHaveCount(1, { timeout: 30_000 });
  // What waited is the next run's: it opens with the first, in order.
  await expect(waiting(page)).toHaveCount(0, { timeout: 30_000 });
  await runOver(page);
  const atTwo = await placeOf(page, two);
  const atThree = await placeOf(page, three);
  expect(atTwo.user).toBeGreaterThan(atTwo.firstReply);
  expect(atThree.user).toBeGreaterThan(atTwo.user);
  const list = await bubbles(page);
  expect(list.at(-1)?.startsWith('assistant:')).toBe(true);
  await expect(page.getByTestId('message-bubble-interrupted')).toHaveCount(1);
});

test('switching away mid-reply leaves the run going and marked, and coming back shows it all (SM-05) @needs-model', async ({ page }) => {
  test.setTimeout(RUN_MS + 60_000);
  await openSmokeProject(page);
  await startNewConversation(page);
  const id = await currentConversation(page);
  await send(page, STORY);
  await replyWriting(page);
  const sofar = (await page.locator('[data-testid="message-bubble"][data-role="assistant"]').last().innerText()).length;

  await startNewConversation(page);
  await page.getByTestId('open-conversation-history').click();
  await expect(page.getByTestId(`conversation-running-${id}`)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`conversation-open-${id}`).click();

  await expect
    .poll(async () => (await page.locator('[data-testid="message-bubble"][data-role="assistant"]').last().innerText().catch(() => '')).length, { timeout: 60_000 })
    .toBeGreaterThan(sofar);
  await runOver(page);
  await expect(page.getByTestId('message-bubble-interrupted')).toHaveCount(0);
  await page.getByTestId('open-conversation-history').click();
  await expect(page.getByTestId(`conversation-running-${id}`)).toHaveCount(0, { timeout: 15_000 });
});

test('closing the page mid-reply does not stop it, and opening it again shows the reply (SM-06) @needs-model', async ({ browser }) => {
  test.setTimeout(RUN_MS + 60_000);
  const first = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let id = '';
  try {
    await openSmokeProject(first);
    await startNewConversation(first);
    id = await currentConversation(first);
    await send(first, STORY);
    await replyWriting(first);
  } finally {
    await first.close();
  }

  const again = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await openSmokeProject(again);
    await openConversation(again, id);
    await expect(again.locator('[data-testid="message-bubble"][data-role="assistant"]')).toHaveCount(1, { timeout: 30_000 });
    await runOver(again);
    await expect(again.getByTestId('message-bubble-interrupted')).toHaveCount(0);
  } finally {
    await again.close();
  }
});
