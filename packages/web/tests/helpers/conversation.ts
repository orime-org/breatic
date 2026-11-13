// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Starting a new Agent conversation the way a user does, and waiting until
 * it is open.
 *
 * Pressing the header's new-conversation button posts the new conversation
 * and makes the composer read-only until the answer lands
 * (`conversationRuntime.startNew`). A paste made in that time is lost: the
 * read-only box keeps a plain-text paste out (`use-composer-editor.tsx`), and
 * pasted canvas content goes to the tray of the conversation being left
 * (inner#1477). Under load the post is slow enough for a case to paste then:
 * Playwright's `fill` waits for the box to be editable, while a dispatched
 * paste or an editor transaction does not.
 */
import { expect, type Page } from 'playwright/test';

/**
 * Press the new-conversation button and wait until the new conversation is
 * open and the composer takes input.
 * @param page - A page with the Agent column showing.
 */
export async function startNewConversation(page: Page): Promise<void> {
  const created = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/chat/conversations',
  );
  await page.getByTestId('new-conversation').click();
  await created;
  await expect(page.getByTestId('chat-composer-box')).toHaveAttribute('contenteditable', 'true', {
    timeout: 20_000,
  });
}

/**
 * Send a message from the composer and wait until the turn it starts has
 * ended on screen.
 * @param page - A page with the Agent column showing.
 * @param text - What the user writes.
 * @param bubbles - How many message bubbles the conversation shows once the reply has begun.
 */
export async function say(page: Page, text: string, bubbles: number): Promise<void> {
  await page.getByTestId('chat-composer-box').fill(text);
  // Attachments still uploading hold the send back; a press before then is
  // ignored, so wait for the button the user would see light up.
  const send = page.getByTestId('chat-composer-send');
  await expect(send).toBeEnabled({ timeout: 60_000 });
  await send.click();
  await expect(page.getByTestId('message-bubble')).toHaveCount(bubbles, { timeout: 200_000 });
  await expect(page.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 600_000 });
}

/**
 * When the turn asked the user instead of proposing, answer in the chat the
 * way a user does, which closes its questionnaire as replied to, and wait
 * for the turn that answer starts.
 * @param page - A page with the Agent column showing.
 * @param reply - What the user answers.
 */
export async function answerIfAsked(page: Page, reply: string): Promise<void> {
  if ((await page.getByTestId('proposal-card').count()) > 0) return;
  await say(page, reply, (await page.getByTestId('message-bubble').count()) + 2);
}
