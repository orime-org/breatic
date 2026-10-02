// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The camera of the image Generate panel, end to end (#2254).
 *
 * The camera is a row of the params popover, built like the audio panel's
 * voice row: it reads what the camera stands on, and opens the camera panel
 * beside the popover. The bottom row has no camera button of its own.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect } from 'playwright/test';

import { openGenerate, seedNode, registerCanvasStage } from '../helpers/audio-panel';

registerCanvasStage();

for (const width of [1280, 1920]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 1000 } });

    test('Nano Banana 2 opens its camera from a row of the params popover', async ({ page }) => {
      const nodeId = crypto.randomUUID();
      await seedNode(nodeId, 'image', undefined, -350);
      await openGenerate(nodeId, 'generate-execute');
      await page.getByTestId('generate-model-trigger').click();
      await page.getByTestId('generate-model-option-nano-banana-2').click();

      // The bottom row has no camera button of its own.
      await expect(page.getByRole('button', { name: 'Camera', exact: true })).toHaveCount(0);

      const pill = page.getByTestId('generate-ratio-trigger');
      await pill.click();
      const row = page.getByTestId('generate-camera-row');
      await expect(row).toContainText('Camera');
      await expect(row).toContainText('Off');
      await expect(page.getByTestId('generate-camera-panel')).toHaveCount(0);

      // The row is the last thing in the popover, and the popover keeps its width.
      const popover = page.locator('[data-radix-popper-content-wrapper] [role="dialog"]').filter({ has: row });
      // The popover opens with a zoom; measure after it settles.
      await popover.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      const pop = (await popover.boundingBox())!;
      const rowBox = (await row.boundingBox())!;
      expect(Math.round(pop.width)).toBe(256);
      expect(pop.y + pop.height - (rowBox.y + rowBox.height)).toBeLessThan(16);
      // It sits in the model's own section, under Image search / Web search, with no line between.
      const rowBlock = row.locator('xpath=..');
      await expect(rowBlock).toHaveCSS('border-top-width', '0px');
      expect(Math.round(rowBox.y - (await rowBlock.boundingBox())!.y)).toBe(0);
      // Its name starts on the same line as the names of the rows above.
      const nameLeft = async (text: string): Promise<number> =>
        Math.round((await popover.getByText(text, { exact: true }).first().boundingBox())!.x);
      expect(await nameLeft('Camera')).toBe(await nameLeft('Image search'));
      // And it reaches across: its chevron ends where the switches above end.
      const chevronRight = (await row.locator('svg').boundingBox())!;
      const switchBox = (await page.getByTestId('generate-param-enable_web_search-toggle').boundingBox())!;
      expect(Math.round(chevronRight.x + chevronRight.width)).toBe(Math.round(switchBox.x + switchBox.width));
      // The value sits against the chevron, the way the switches' state words sit against the switches.
      const valueBox = (await row.getByText('Off', { exact: true }).boundingBox())!;
      expect(Math.round(chevronRight.x - (valueBox.x + valueBox.width))).toBeLessThanOrEqual(10);

      await row.click();
      const panel = page.getByTestId('generate-camera-panel');
      await expect(panel).toBeVisible();
      await expect(row).toHaveAttribute('aria-expanded', 'true');
      // Beside the popover: at 1280 the right has no room for the 520px panel
      // and it opens on the left; at 1920 it opens on the right.
      const viewport = page.viewportSize()!;
      const expected = width === 1920 ? 'right' : 'left';
      await expect(panel).toHaveAttribute('data-side', expected);
      await panel.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
      const panelBox = (await panel.boundingBox())!;
      if (expected === 'right') expect(panelBox.x).toBeGreaterThanOrEqual(pop.x + pop.width);
      else expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(pop.x);
      expect(panelBox.x).toBeGreaterThanOrEqual(0);
      expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewport.width);
      // Four wheels in one line.
      const tops = await Promise.all(
        ['Camera ▼', 'Lens ▼', 'Focal length ▼', 'Aperture ▼'].map(async (label) =>
          Math.round((await panel.getByLabel(label).boundingBox())!.y),
        ),
      );
      expect(new Set(tops).size).toBe(1);

      await page.getByTestId('generate-camera-toggle').click();
      await expect(row).toContainText('Canon EOS R5 · Zeiss Master Prime · 50 mm · f/2.8');
      await expect(pill).toContainText('Camera');

      await panel.getByLabel('Focal length ▼').click();
      await expect(row).toContainText('85 mm');

      await row.click();
      await expect(panel).toHaveCount(0);

      await row.click();
      await expect(panel).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(row).toHaveCount(0);
      await pill.click();
      await expect(page.getByTestId('generate-camera-row')).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByTestId('generate-camera-panel')).toHaveCount(0);
    });
  });
}

test('a model without a camera has no camera row', async ({ page }) => {
  const nodeId = crypto.randomUUID();
  await seedNode(nodeId, 'image', undefined, -350);
  await openGenerate(nodeId, 'generate-execute');
  await page.getByTestId('generate-model-trigger').click();
  await page.getByTestId('generate-model-option-gpt-image-2.5-sunburst-text-to-image').click();
  await page.getByTestId('generate-ratio-trigger').click();
  await expect(page.getByTestId('generate-ratio-option-1:1')).toBeVisible();
  await expect(page.getByTestId('generate-camera-row')).toHaveCount(0);
});
