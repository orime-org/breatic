// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Agent's 3D generation proposal lands in the 3D Space in front (inner#1691
 * design 6.2): its card's button opens that Space's generation dialog filled,
 * and with no 3D Space in front it says to open one first.
 *
 * The chat answer is served here, so no model is involved and nothing is
 * submitted: what is under test is the path from the card to the dialog.
 */

import { expect, type Locator, type Page, type Route } from 'playwright/test';
import type { SceneGenerationProposal } from '@breatic/shared';
import { test } from '../helpers/slot';
import { startNewConversation } from '../helpers/conversation';
import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

const PROPOSAL: SceneGenerationProposal = {
  proposalId: crypto.randomUUID(),
  mode: 't23d',
  model: 'tripo-h3.1-t23d',
  prompt: 'A small wooden treasure chest',
  params: { texture: false, pbr: false, geometry_quality: 'standard', negative_prompt: 'cracks' },
  images: [],
  credits: 12,
  rationale: 'A prop for the opening scene.',
  placed: true,
};

const created: string[] = [];

test.afterEach(async ({ page }) => {
  for (const id of created.splice(0)) await deleteSpace(page, id);
});

/**
 * Answer the next chat message with one finished `propose_scene_generation` call.
 * @param page - The Project page.
 */
async function answerWithProposal(page: Page): Promise<void> {
  await page.route('**/chat/message', async (route: Route) => {
    const chunks = [
      { type: 'data-heartbeat', transient: true, data: {} },
      { type: 'data-conversation-titled', data: { title: '3D proposal' } },
      { type: 'start', messageId: 'm-reply' },
      { type: 'start-step' },
      { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'propose_scene_generation', input: {} },
      { type: 'tool-output-available', toolCallId: 'call-1', output: PROPOSAL },
      { type: 'finish-step' },
      { type: 'finish' },
    ];
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''),
    });
  });
}

/**
 * Ask in chat and wait for the proposal card.
 * @param page - The Project page.
 * @returns The card.
 */
async function askForTheCard(page: Page): Promise<Locator> {
  await answerWithProposal(page);
  await startNewConversation(page);
  const composer = page.getByTestId('chat-composer-box');
  await composer.fill('Make me a treasure chest model.');
  await composer.press('Enter');
  const card = page.getByTestId('scene-proposal-card').last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText('A small wooden treasure chest');
  await expect(card).toContainText('About 12 credits');
  return card;
}

test('the card opens the 3D Space in front on a generation dialog filled from the proposal', async ({ page }) => {
  await openSmokeProject(page);
  created.push(await createSpace(page, '3d', `scene-proposal-${crypto.randomUUID()}`));
  await expect(visibleSpace(page).getByTestId('three-d-viewport')).toBeVisible();
  const card = await askForTheCard(page);
  await card.getByTestId('scene-proposal-open').click();
  const dialog = page.getByRole('dialog', { name: 'AI generation', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Filled in from the Agent’s proposal. Check it, then generate.');
  await expect(dialog.getByTestId('scene-generate-mode')).toHaveText('Text to 3D');
  await expect(dialog.getByLabel('Prompt', { exact: true })).toHaveValue('A small wooden treasure chest');
  await expect(dialog.getByLabel('Negative prompt', { exact: true })).toHaveValue('cracks');
  await expect(dialog.getByRole('switch', { name: 'Texture', exact: true })).toHaveAttribute('aria-checked', 'false');
  await expect(dialog.getByRole('switch', { name: 'PBR', exact: true })).toHaveAttribute('aria-checked', 'false');
  await expect(dialog.getByRole('button', { name: 'Generate', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
});

test('with a Canvas in front the card says to open a 3D Space first and opens no dialog', async ({ page }) => {
  await openSmokeProject(page);
  // A 3D Space open behind the Canvas: only the one in front takes proposals.
  created.push(await createSpace(page, '3d', `scene-proposal-behind-${crypto.randomUUID()}`));
  await expect(visibleSpace(page).getByTestId('three-d-viewport')).toBeVisible();
  created.push(await createSpace(page, 'canvas', `scene-proposal-canvas-${crypto.randomUUID()}`));
  await expect(visibleSpace(page).getByTestId('three-d-viewport')).toHaveCount(0);
  const card = await askForTheCard(page);
  await card.getByTestId('scene-proposal-open').click();
  await expect(page.getByText('Open a 3D Space first.', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'AI generation', exact: true })).toHaveCount(0);
});
