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
import { basename, extname } from 'node:path';

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
async function say(page: Page, text: string, bubbles: number): Promise<void> {
  await page.getByTestId('chat-composer-box').fill(text);
  // Attachments still uploading hold the send back; a press before then is
  // ignored, so wait for the button the user would see light up.
  const send = page.getByTestId('chat-composer-send');
  await expect(send).toBeEnabled({ timeout: 60_000 });
  await send.click();
  await expect(page.getByTestId('message-bubble')).toHaveCount(bubbles, { timeout: 200_000 });
  await expect(page.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 600_000 });
}

/** A part of a stored message, as the conversation endpoint returns it. */
export interface StoredPart {
  type?: string;
  text?: string;
  output?: unknown;
  input?: Record<string, unknown>;
  /** A data part's payload; on an attachment part, the attached item. */
  data?: { data_snapshot?: { url?: unknown } };
}

/** A message of the conversation, as the conversation endpoint returns it. */
export interface StoredMessage {
  role?: string;
  parts?: StoredPart[];
}

/**
 * The newest conversation's messages once the reply to its newest message is
 * stored: the turn's end on screen can come before the server writes the
 * reply, which it writes whole, while the user's message is stored as the
 * turn starts.
 * @param page - The signed-in page.
 * @returns The messages, oldest first.
 */
export async function storedMessages(page: Page): Promise<StoredMessage[]> {
  let messages: StoredMessage[] = [];
  await expect
    .poll(async () => {
      messages = await page.evaluate(async () => {
        const list = await (await fetch('/api/v1/chat/conversations?limit=1', { credentials: 'include' })).json();
        const id = list?.data?.conversations?.[0]?.id as string;
        const read = await (await fetch(`/api/v1/chat/conversations/${id}`, { credentials: 'include' })).json();
        return (read?.data?.messages ?? []) as StoredMessage[];
      });
      return messages.at(-1)?.role;
    }, { timeout: 30_000 })
    .toBe('assistant');
  return messages;
}

/**
 * Open a new conversation, attach a file when one is given, send the message
 * and wait for the turn; when a reply is given and the agent asks first,
 * answer it the way a user does.
 * @param page - A page with the Agent column showing.
 * @param message - What the user writes.
 * @param options - The file to attach, by path, and the answer to give if asked.
 */
export async function askInNewConversation(page: Page, message: string, options: { file?: string; reply?: string } = {}): Promise<void> {
  await expect(page.getByTestId('chat-composer-box')).toBeVisible({ timeout: 20_000 });
  await startNewConversation(page);
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
  if (options.file !== undefined) {
    // Files chosen before the composer can take them are dropped without a word.
    await expect(page.getByTestId('chat-composer-attach')).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId('chat-composer-file-input').setInputFiles(options.file);
    await expect(page.getByTestId('chat-composer-chips')).toContainText(basename(options.file, extname(options.file)), { timeout: 30_000 });
  }
  await say(page, message, 2);
  // Answering in the chat closes a waiting questionnaire as replied to; a turn
  // that proposed or failed stays as it ended, for the case to judge.
  if (options.reply !== undefined && (await page.getByTestId('questionnaire-submit').count()) > 0) {
    await say(page, options.reply, (await page.getByTestId('message-bubble').count()) + 2);
  }
}
