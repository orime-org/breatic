// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Told to remember something, the Agent saves it in the same turn, and a new
 * conversation of the Project knows it from its memory; told to forget it,
 * the Agent removes it in the same turn (#1363).
 *
 * The integration tests settle what each memory tool writes and what the
 * next prompt carries. What they cannot settle is that a real model reaches
 * for those tools when asked in plain words, and answers in a new
 * conversation from what it saved rather than by reading the old one. The
 * word is made up for each run, so the memory and the other conversation are
 * the only places a reply can have it from, and the turn's stream says which
 * tools it called.
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
 * @returns The reply's text and the names of the tools the turn called.
 */
async function ask(page: Page, words: string): Promise<{ reply: string; tools: string[] }> {
  const before = await page.getByTestId('message-bubble').count();
  const turn = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/chat/message', { timeout: 200_000 });
  const composer = page.getByTestId('chat-composer-box');
  await composer.fill(words);
  await composer.press('Enter');
  await expect(page.getByTestId('message-bubble')).toHaveCount(before + 2, { timeout: 200_000 });
  await expect(page.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 200_000 });
  const stream = await (await turn).text();
  const tools = [...stream.matchAll(/"toolName":"([a-z_]+)"/g)].map((m) => m[1]!);
  const reply = await page.getByTestId('message-bubble').last().innerText();
  test.info().annotations.push({ type: 'turn', description: `${words} => [${tools.join(', ')}] ${reply}` });
  return { reply, tools };
}

test('remembers a word for the Project in one turn, recalls it in a new conversation and forgets it @needs-model', async ({ page }) => {
  test.setTimeout(600_000); // three real-model turns of up to 200 s each
  const word = `vornel${crypto.randomInt(1000, 9999).toString()}`;
  await openSmokeProject(page);

  await startNewConversation(page);
  const saved = await ask(page, `记住：这个 Project 的暗号是 ${word}。简短确认即可。`);
  expect(saved.tools, 'the remember turn').toContain('save_memory');

  await startNewConversation(page);
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
  const recalled = await ask(page, '这个 Project 的暗号是什么？只回答暗号本身。');
  expect(recalled.reply, `the reply: ${recalled.reply}`).toContain(word);
  expect(
    recalled.tools.filter((tool) => tool === 'search_conversations' || tool === 'read_conversation'),
    'the recall comes from memory, not from the record of the other conversation',
  ).toEqual([]);

  const forgotten = await ask(page, '忘掉这个暗号。简短确认即可。');
  expect(forgotten.tools, 'the forget turn').toContain('delete_memory');
});
