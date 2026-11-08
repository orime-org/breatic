// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The model picker in the chat composer (#1363): a pick is kept by the
 * conversation it was made in, a new conversation starts on the last pick,
 * and the next message goes out with the model on screen.
 *
 * The unit tests settle what the picker draws from what it is given. What
 * they cannot settle is that a pick reaches the server and comes back on a
 * reload, and that the conversation the server opens next starts on it. The
 * turn itself is served here, so what is read is the request the panel sent.
 * The last pick is kept on the account, so the case puts it back.
 */
import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { dataOf } from '../helpers/api';
import { startNewConversation } from '../helpers/conversation';
import { openSmokeProject, smokeProjectId } from '../helpers/project';

/** What `GET /chat/models` answers. */
interface Models {
  models: Array<{ id: string; name: string }>;
  lastUsed: string;
}

/**
 * Pick a model in the composer's picker.
 * @param page - The project page.
 * @param id - The model to pick.
 */
async function pick(page: Page, id: string): Promise<void> {
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && /\/chat\/conversations\/[^/]+\/model$/.test(new URL(r.url()).pathname),
  );
  await page.getByTestId('chat-model-picker').click();
  await page.getByTestId(`chat-model-option-${id}`).click();
  expect((await saved).ok()).toBe(true);
}

test('a pick is kept by its conversation, starts the next one and goes out with the message', async ({ page }) => {
  const listed = await dataOf<Models>(await page.request.get('/api/v1/chat/models'), 'chat models');
  const original = listed.lastUsed;
  const other = listed.models.find((m) => m.id !== original);
  expect(other, 'the deployment lists more than one model').toBeDefined();
  const target = other!;

  try {
    await openSmokeProject(page);
    await startNewConversation(page);
    const picker = page.getByTestId('chat-model-picker');
    await expect(picker).toBeEnabled({ timeout: 20_000 });

    await pick(page, target.id);
    await expect(picker).toHaveText(target.name);

    await page.reload();
    await expect(page.getByTestId('chat-model-picker')).toHaveText(target.name, { timeout: 30_000 });

    await startNewConversation(page);
    await expect(page.getByTestId('chat-model-picker')).toHaveText(target.name);

    const sent: Array<Record<string, unknown>> = [];
    await page.route('**/chat/message', async (route) => {
      sent.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: 'data: {"type":"start"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n',
      });
    });
    const composer = page.getByTestId('chat-composer-box');
    await composer.fill('hello');
    await composer.press('Enter');
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ model: target.id });
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    const created = await page.request.post('/api/v1/chat/conversations', {
      data: { project_id: smokeProjectId() },
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    });
    const conversation = await dataOf<{ id: string }>(created, 'conversation to put the pick back in');
    const restored = await page.request.put(`/api/v1/chat/conversations/${conversation.id}/model`, {
      data: { project_id: smokeProjectId(), model: original },
    });
    expect(restored.ok(), 'the account is back on its last pick').toBe(true);
  }
});
