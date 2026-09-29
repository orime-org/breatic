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

import { openGenerate, seedNode } from '../helpers/audio-panel';

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

  // Muse Image Edit: the ratio an edit starts on is the first one it offers.
  await page.getByTestId('generate-mode-trigger').click();
  await page.getByTestId('generate-mode-i2i').click();
  await page.getByTestId('generate-model-trigger').click();
  await page.getByTestId('generate-model-option-muse-image-edit').click();
  await pill.click();
  await expect(page.locator('[data-testid^="generate-ratio-option-"][aria-current="true"]')).toHaveCount(1);
  await expect(pill).not.toHaveText(/^\s*(Params|参数)\s*$/);
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
