// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The params pill of the image and video Generate panels, end to end (#2156).
 *
 * Every param a panel draws stands on a value the catalog declares, the pill
 * says what each one stands on, the params are named in the reader's language
 * and an option's text is never cut (user 2026-09-29).
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Locator } from 'playwright/test';

import { openGenerate, seedNode, registerCanvasStage } from '../helpers/audio-panel';

registerCanvasStage();

/**
 * Whether a button's text fits inside it.
 * @param button - The button.
 * @returns True when nothing is cut.
 */
async function fits(button: Locator): Promise<boolean> {
  return button.evaluate((el) => el.scrollWidth <= el.clientWidth);
}

test('an image model shows every param it stands on, named from the locales', async ({ page }) => {
  const nodeId = crypto.randomUUID();
  await seedNode(nodeId, 'image', undefined, -350);
  await openGenerate(nodeId, 'generate-execute');

  // GPT Image: quality has a declared default the pill has to say.
  await page.getByTestId('generate-model-trigger').click();
  await page.getByTestId('generate-model-option-gpt-image-2.5-sunburst-text-to-image').click();
  const pill = page.getByTestId('generate-ratio-trigger');
  await expect(pill).toContainText('1:1');
  await pill.click();
  const chosenQuality = page.locator('[data-testid^="generate-param-quality-option-"][aria-current="true"]');
  await expect(chosenQuality).toHaveCount(1);
  await expect(pill).toContainText((await chosenQuality.innerText()).trim());
  // The name comes from the locales, not the yaml.
  await expect(page.getByText('Quality', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  // Muse Image Edit: an edit starts on Auto, the shape of the image it edits.
  await page.getByTestId('generate-mode-trigger').click();
  await page.getByTestId('generate-mode-i2i').click();
  await page.getByTestId('generate-model-trigger').click();
  await page.getByTestId('generate-model-option-muse-image-edit').click();
  await expect(pill).toContainText('Auto');
  await pill.click();
  await expect(page.getByTestId('generate-ratio-option-auto')).toHaveAttribute('aria-current', 'true');
});

test('a video model names its own params and cuts none of their options', async ({ page }) => {
  const nodeId = crypto.randomUUID();
  await seedNode(nodeId, 'video', undefined, -350);
  await openGenerate(nodeId, 'generate-video-execute');

  await page.getByTestId('generate-video-mode-trigger').click();
  await page.getByTestId('generate-video-mode-talking-head').click();
  await page.getByTestId('generate-model-trigger').click();
  await page.getByTestId('generate-model-option-sync-react-1').click();

  const pill = page.getByTestId('generate-video-params-trigger');
  // The emotion Sync React 1 declares as its default, as the option reads.
  await expect(pill).toContainText('Neutral');
  await pill.click();
  const options = page.locator('[data-testid^="generate-param-emotion-option-"]');
  await expect(options.first()).toBeVisible();
  for (const option of await options.all()) {
    expect(await fits(option), await option.innerText()).toBe(true);
  }
  await expect(page.getByText('Emotion', { exact: true })).toBeVisible();
});

test('a param is named in the reader\'s language, its options stay as the vendor spells them', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('breatic.locale', 'zh-CN'));
  await page.reload();
  const nodeId = crypto.randomUUID();
  await seedNode(nodeId, 'video', undefined, -350);
  await openGenerate(nodeId, 'generate-video-execute');

  await page.getByTestId('generate-video-mode-trigger').click();
  await page.getByTestId('generate-video-mode-talking-head').click();
  await page.getByTestId('generate-model-trigger').click();
  await page.getByTestId('generate-model-option-sync-react-1').click();
  await page.getByTestId('generate-video-params-trigger').click();
  await expect(page.getByText('情绪', { exact: true })).toBeVisible();
  await expect(page.getByTestId('generate-param-emotion-option-happy')).toHaveText('Happy');
  await page.evaluate(() => localStorage.removeItem('breatic.locale'));
});

test('the image panel draws Style only for a model that takes one, and no unbuilt buttons', async ({ page }) => {
  // User 2026-09-29: presets, translate and web search were placeholders; a
  // model that cannot take a style image shows no Style slot at all.
  const nodeId = crypto.randomUUID();
  await seedNode(nodeId, 'image', undefined, -350);
  await openGenerate(nodeId, 'generate-execute');
  for (const gone of ['generate-presets', 'generate-translate', 'generate-online']) {
    await expect(page.getByTestId(gone)).toHaveCount(0);
  }
  await page.getByTestId('generate-model-trigger').click();
  await page.getByTestId('generate-model-option-gpt-image-2.5-sunburst-text-to-image').click();
  await expect(page.getByTestId('generate-tool-style')).toHaveCount(0);
  await page.getByTestId('generate-model-trigger').click();
  await page.getByTestId('generate-model-option-midjourney').click();
  await expect(page.getByTestId('generate-tool-style')).toBeVisible();
});

test('a video model that generates audio says so on its pill', async ({ page }) => {
  const nodeId = crypto.randomUUID();
  await seedNode(nodeId, 'video', undefined, -350);
  await openGenerate(nodeId, 'generate-video-execute');
  await page.getByTestId('generate-model-trigger').click();
  await page.getByTestId('generate-model-option-wan-3.0-text-to-video').click();
  const pill = page.getByTestId('generate-video-params-trigger');
  await pill.click();
  await expect(page.locator('#generate-video-audio-toggle')).toHaveAttribute('data-state', 'checked');
  await expect(pill).toContainText('Generate audio');
  await page.locator('#generate-video-audio-toggle').click();
  await expect(pill).not.toContainText('Generate audio');
});
