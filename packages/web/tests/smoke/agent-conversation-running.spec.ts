// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * #1394: the conversation list marks the conversations whose Agent turn is
 * still running, and the mark goes when the turn ends.
 *
 * The first case holds this page's own turn at the network, so the mark comes
 * from the page alone. The second runs a real turn on one page and reads the
 * list on another page of the same user, so the mark comes from the server.
 */
import { expect, type Page, type Route } from 'playwright/test';
import { test } from '../helpers/slot';
import { startNewConversation } from '../helpers/conversation';
import { openSmokeProject } from '../helpers/project';

/**
 * A finished turn the way the server writes one.
 * @returns The response body.
 */
function finishedTurn(): string {
  return [
    { type: 'data-heartbeat', transient: true, data: {} },
    { type: 'start', messageId: 'm-running-mark' },
    { type: 'start-step' },
    { type: 'text-start', id: 't0' },
    { type: 'text-delta', id: 't0', delta: 'Done.' },
    { type: 'text-end', id: 't0' },
    { type: 'finish-step' },
    { type: 'finish' },
  ]
    .map((c) => `data: ${JSON.stringify(c)}\n\n`)
    .join('');
}

/**
 * Open the conversation list and read which row is the conversation on screen.
 * @param page - The page.
 * @returns That conversation's id.
 */
async function openListAndReadCurrent(page: Page): Promise<string> {
  await page.getByTestId('open-conversation-history').click();
  const current = page.getByTestId('conversation-history-list').locator('[data-testid^="conversation-open-"][aria-current]');
  await expect(current).toHaveCount(1, { timeout: 15_000 });
  return ((await current.getAttribute('data-testid')) ?? '').replace('conversation-open-', '');
}

test('a turn running on this page spins its row in the list and stops when the turn ends', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await openSmokeProject(page);
    await startNewConversation(page);

    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/chat/message', async (route: Route) => {
      await held;
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: finishedTurn() });
    });

    const composer = page.getByTestId('chat-composer-box');
    await composer.fill('hello');
    await composer.press('Enter');

    const id = await openListAndReadCurrent(page);
    await expect(page.getByTestId(`conversation-running-${id}`)).toBeVisible();

    release?.();
    await expect(page.getByTestId(`conversation-running-${id}`)).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.close();
  }
});

test('a turn running on another page of the same user spins its row here and stops when it is stopped there @needs-model', async ({ browser }) => {
  test.setTimeout(180_000);
  const there = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const here = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await openSmokeProject(there);
    await startNewConversation(there);
    const id = await openListAndReadCurrent(there);
    await there.keyboard.press('Escape');

    const composer = there.getByTestId('chat-composer-box');
    await composer.fill('Write a 600-word short story about a lighthouse keeper. Reply in prose only, make nothing.');
    await composer.press('Enter');
    await expect(there.getByTestId('chat-composer-abort')).toBeVisible({ timeout: 20_000 });

    await openSmokeProject(here);
    await here.getByTestId('open-conversation-history').click();
    await expect(here.getByTestId(`conversation-running-${id}`)).toBeVisible({ timeout: 20_000 });

    await there.getByTestId('chat-composer-abort').click();
    await expect(there.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 20_000 });
    // The other page learns of the end on its next poll.
    await expect(here.getByTestId(`conversation-running-${id}`)).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await here.close();
    await there.close();
  }
});
