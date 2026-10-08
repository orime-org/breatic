// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A proposal that carries the reader's material (inner#1315).
 *
 * What the reader handed the agent -- a file attached in the chat, or a
 * picture the agent found and saved -- lands on the canvas inside the nodes,
 * and the generation it is meant for has it in its slots or wired into its
 * reference pool. One press, and the next thing is Generate.
 *
 * The turns are real, so the model decides what to propose. A run where it
 * answers otherwise is reported as such rather than passed.
 */
import { join } from 'node:path';

import { expect, test, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

let page: Page;
let spaceId = '';

/**
 * Which tools the newest stored conversation used.
 * @param p - The signed-in page.
 * @returns Each tool name, in the order the turn used them.
 */
async function toolsUsed(p: Page): Promise<string[]> {
  return p.evaluate(async () => {
    const list = await (
      await fetch('/api/v1/chat/conversations?limit=1', { credentials: 'include' })
    ).json();
    const id = list?.data?.conversations?.[0]?.id as string;
    const read = await (
      await fetch(`/api/v1/chat/conversations/${id}`, { credentials: 'include' })
    ).json();
    const messages = (read?.data?.messages ?? []) as { parts?: { type?: string }[] }[];
    return messages
      .flatMap((m) => m.parts ?? [])
      .map((part) => part.type ?? '')
      .filter((type) => type.startsWith('tool-'))
      .map((type) => type.slice('tool-'.length));
  });
}

/**
 * Send one message and wait for the turn to finish.
 * @param p - The signed-in page.
 * @param words - What the reader asks.
 */
async function ask(p: Page, words: string): Promise<void> {
  const composer = p.getByTestId('chat-composer-box');
  await composer.fill(words);
  // Attachments still uploading hold the send back; a press before then is
  // ignored, so wait for the button the reader would see light up.
  const send = p.getByTestId('chat-composer-send');
  await expect(send).toBeEnabled({ timeout: 60_000 });
  await send.click();
  await expect(p.getByTestId('message-bubble')).toHaveCount(2, { timeout: 280_000 });
  await expect(p.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 280_000 });
}

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({
    storageState: STATE_FILE.A,
    viewport: { width: 1500, height: 900 },
  });
  await openSmokeProject(page);
  spaceId = await createSpace(page, 'canvas', `material-${String(Date.now())}`);
  await expect(page.getByTestId('chat-composer-box')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('new-conversation').click();
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
});

test.afterEach(async () => {
  if (spaceId !== '') await deleteSpace(page, spaceId);
  await page.close();
});

test('lands an attached portrait and voice in a talking head, both slots filled @needs-model', async () => {
  test.setTimeout(300_000);
  const fixtures = join(__dirname, '../fixtures');
  // Files chosen before the composer can take them are dropped without a
  // word; a reader cannot press the button until then either.
  await expect(page.getByTestId('chat-composer-attach')).toBeEnabled({ timeout: 20_000 });
  await page
    .getByTestId('chat-composer-file-input')
    .setInputFiles([join(fixtures, 'portrait.png'), join(fixtures, 'voice.mp3')]);
  const chips = page.getByTestId('chat-composer-chips');
  await expect(chips).toContainText('portrait.png', { timeout: 30_000 });
  await expect(chips).toContainText('voice.mp3', { timeout: 30_000 });

  await ask(
    page,
    'The picture is my portrait and the audio is my voice. Set up a talking head video on the canvas that uses both of them -- do not ask me anything, just propose it.',
  );

  const used = await toolsUsed(page);
  expect(used, `the turn proposed a flow. Tools used: ${used.join(', ')}`).toContain(
    'propose_canvas_action',
  );
  const card = page.getByTestId('proposal-card').last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByTestId('proposal-use').click();

  // The portrait and the voice land in their own nodes, holding the files.
  const space = visibleSpace(page);
  await expect(space.getByTestId('image-node-img')).toHaveCount(1, { timeout: 20_000 });
  // No wire: a slot takes a snapshot of its material, the way a pick does.
  await expect(space.locator('.react-flow__edge')).toHaveCount(0);

  // The talking head is selected with its panel open and both slots filled.
  await expect(page.getByTestId('generate-video-character-image-thumbnail')).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId('generate-video-driving-audio-clear')).toHaveCount(1);
});

test('saves a found picture and wires it into an image-to-image pool @needs-model', async () => {
  test.setTimeout(300_000);
  await ask(
    page,
    'Find me a photo of a ceramic teapot, save it, and set up an image-to-image generation on the canvas that puts that teapot on a plain white background with the photo as its reference. Do not ask me anything, just propose it.',
  );

  const used = await toolsUsed(page);
  expect(used, `the turn saved a picture. Tools used: ${used.join(', ')}`).toContain('save_image');
  expect(used, `the turn proposed a flow. Tools used: ${used.join(', ')}`).toContain(
    'propose_canvas_action',
  );
  const card = page.getByTestId('proposal-card').last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByTestId('proposal-use').click();

  // The saved picture is on the canvas, served from our storage, wired in.
  const space = visibleSpace(page);
  const picture = space.getByTestId('image-node-img');
  await expect(picture).toHaveCount(1, { timeout: 20_000 });
  const src = (await picture.getAttribute('src')) ?? '';
  expect(src, 'the picture is a file we hold, not the address it was found at').not.toBe('');
  await expect(space.locator('.react-flow__edge')).toHaveCount(1, { timeout: 20_000 });
});
