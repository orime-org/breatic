// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A proposal that carries the reader's material (inner#1315).
 *
 * What the reader handed the agent -- a file attached in the chat, or a
 * picture the agent found and saved -- lands on the canvas inside the nodes,
 * and the generation it is meant for has it in its slots, or wired into its
 * reference pool and @'d in its prompt for the reader. One press, and the
 * next thing is Generate.
 *
 * The turns are real, so the model decides what to propose. A run where it
 * answers otherwise is reported as such rather than passed.
 */
import { join } from 'node:path';

import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { openSmokeProject } from '../helpers/project';
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

/**
 * Catch the run the panel sends, without spending a real generation on it.
 * @param p - The signed-in page.
 * @returns Reads the request body once it is sent.
 */
async function catchSubmit(p: Page): Promise<() => Record<string, unknown> | undefined> {
  let body: Record<string, unknown> | undefined;
  await p.route('**/canvas/tasks', async (route) => {
    body = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { id: crypto.randomUUID(), status: 'queued' } }),
    });
  });
  return () => body;
}

/**
 * Scroll the canvas the way a reader does when a placed panel lands under the
 * canvas controls and the minimap (inner#854), so its Generate is in reach.
 * @param p - The signed-in page.
 */
async function reachPanelCorner(p: Page): Promise<void> {
  await p.mouse.move(1000, 200);
  await p.mouse.wheel(500, 400);
}

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({
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
  test.setTimeout(480_000);
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

  // And Generate sends both files with nothing left to pick.
  const held = (await space.getByTestId('image-node-img').first().getAttribute('src')) ?? '';
  const sent = await catchSubmit(page);
  await reachPanelCorner(page);
  await expect(page.getByTestId('generate-video-execute')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('generate-video-execute').click();
  await expect.poll(sent, { timeout: 20_000 }).toBeDefined();
  const params = JSON.stringify((sent() as { params: Record<string, unknown> }).params);
  expect(params).toContain(held.replace(/\.preview\.webp$/, ''));
  expect(params).toMatch(/\.mp3"/);
});

test('fills a music-to-video model from an attached clip, and Generate sends it @needs-model', async () => {
  test.setTimeout(480_000);
  const fixtures = join(__dirname, '../fixtures');
  await expect(page.getByTestId('chat-composer-attach')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('chat-composer-file-input').setInputFiles([join(fixtures, 'media-history.mp4')]);
  await expect(page.getByTestId('chat-composer-chips')).toContainText('media-history.mp4', { timeout: 30_000 });

  await ask(
    page,
    'Make background music for this clip that follows its cuts, using Sonilo Video to Music on the canvas with this clip as its source video. Do not ask me anything, just propose it.',
  );

  const used = await toolsUsed(page);
  expect(used, `the turn proposed a flow. Tools used: ${used.join(', ')}`).toContain('propose_canvas_action');
  const card = page.getByTestId('proposal-card').last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByTestId('proposal-use').click();

  const sent = await catchSubmit(page);
  await reachPanelCorner(page);
  await expect(page.getByTestId('generate-audio-execute')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('generate-audio-execute').click();
  await expect.poll(sent, { timeout: 20_000 }).toBeDefined();
  const body = sent() as { model?: string; params: Record<string, unknown> };
  expect(body.model).toBe('sonilo-video-to-music');
  // The clip the node holds fills the source video slot.
  expect(String(body.params.video)).toMatch(/^https:\/\/.+\.mp4$/);
});

test('saves a found picture and wires it into an image-to-image pool @needs-model', async () => {
  test.setTimeout(480_000);
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
  // And it is @'d in the prompt, the way the reader would have @'d it.
  await expect(page.getByTestId('generate-prompt-editor').locator('[data-reference-mention]')).toHaveCount(1, {
    timeout: 20_000,
  });
});

test('@s an attached portrait in an image-to-image prompt, and Generate sends it @needs-model', async () => {
  test.setTimeout(480_000);
  const fixtures = join(__dirname, '../fixtures');
  await expect(page.getByTestId('chat-composer-attach')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('chat-composer-file-input').setInputFiles([join(fixtures, 'portrait.png')]);
  await expect(page.getByTestId('chat-composer-chips')).toContainText('portrait.png', { timeout: 30_000 });

  await ask(
    page,
    'Turn this portrait into a watercolour painting with exactly one image-to-image generation node on the canvas that uses it as the reference. Do not ask me anything, just propose it.',
  );

  const used = await toolsUsed(page);
  expect(used, `the turn proposed a flow. Tools used: ${used.join(', ')}`).toContain('propose_canvas_action');
  const card = page.getByTestId('proposal-card').last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByTestId('proposal-use').click();

  const prompt = page.getByTestId('generate-prompt-editor');
  await expect(prompt.locator('[data-reference-mention]')).toHaveCount(1, { timeout: 20_000 });
  const held = (await visibleSpace(page).getByTestId('image-node-img').first().getAttribute('src')) ?? '';

  const sent = await catchSubmit(page);
  await reachPanelCorner(page);
  await expect(page.getByTestId('generate-execute')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('generate-execute').click();
  await expect.poll(sent, { timeout: 20_000 }).toBeDefined();
  const params = (sent() as { params: Record<string, unknown> }).params;
  // The picture the node holds goes out as the reference, with nothing to do
  // first. The node shows its preview, the original key with `.preview.webp`.
  const images = params.images as string[];
  expect(images).toHaveLength(1);
  expect([images[0], `${String(images[0])}.preview.webp`]).toContain(held);
  expect(String(params.prompt)).not.toBe('');
});

test('@s the lyrics it wrote in a song model\'s lyrics box @needs-model', async () => {
  test.setTimeout(480_000);
  await ask(
    page,
    'Write four short lines of lyrics about the sea, and set up a song generation on the canvas that sings exactly those lyrics. Do not ask me anything, just propose it.',
  );

  const used = await toolsUsed(page);
  expect(used, `the turn proposed a flow. Tools used: ${used.join(', ')}`).toContain('propose_canvas_action');
  const card = page.getByTestId('proposal-card').last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByTestId('proposal-use').click();

  await expect(page.getByTestId('generate-lyrics-editor').locator('[data-reference-mention]')).toHaveCount(1, {
    timeout: 20_000,
  });
});
