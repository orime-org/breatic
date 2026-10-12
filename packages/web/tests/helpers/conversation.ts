// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Starting a new Agent conversation the way a reader does, and waiting until
 * it is open.
 *
 * Pressing the header's new-conversation button posts the new conversation
 * and makes the composer read-only until the answer lands
 * (`conversationRuntime.startNew`). What is typed or pasted into it in that
 * time is dropped (inner#1477), and under load the post is slow enough for a
 * case to write into it then: Playwright's `fill` waits for the box to be
 * editable, while a dispatched paste, an editor transaction or a key press
 * does not.
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
