// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Asked about something said in another conversation, the agent finds it
 * (inner#1469).
 *
 * The integration tests settle what each read returns and to whom. What they
 * cannot settle is that a real model, with nothing of the earlier
 * conversation in its context, reaches for the record tools and reads the
 * answer out of them. The word asked for is made up for each run, so the
 * only place a reply can have it from is the other conversation.
 */
import crypto from 'node:crypto';
import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { startNewConversation } from '../helpers/conversation';
import { openSmokeProject } from '../helpers/project';

/**
 * Send one message in the open conversation and wait for the whole reply.
 * @param page - The signed-in page.
 * @param words - What the user types.
 * @returns The reply's text.
 */
async function ask(page: Page, words: string): Promise<string> {
  const before = await page.getByTestId('message-bubble').count();
  const composer = page.getByTestId('chat-composer-box');
  await composer.fill(words);
  await composer.press('Enter');
  await expect(page.getByTestId('message-bubble')).toHaveCount(before + 2, { timeout: 200_000 });
  await expect(page.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 200_000 });
  const reply = await page.getByTestId('message-bubble').last().innerText();
  test.info().annotations.push({ type: 'reply', description: `${words} => ${reply}` });
  return reply;
}

test('finds a word the user said in another conversation of this project @needs-model', async ({ page }) => {
  test.setTimeout(400_000);
  const word = `qulrex${crypto.randomInt(1000, 9999).toString()}`;
  await openSmokeProject(page);

  await startNewConversation(page);
  await ask(page, `记住这个暗号：${word}。只回复「好的」。`);

  await startNewConversation(page);
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
  const reply = await ask(page, '我在这个项目的另一条会话里告诉过你一个暗号，是什么？只回答暗号本身。');

  expect(reply, `the reply: ${reply}`).toContain(word);
});
