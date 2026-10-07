// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The template button in a generate panel's corner (inner#977): the image
 * panel lists its templates, picking one sets the panel up and reminds the
 * reader to edit the marked parts, and a panel with no templates says so.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

test.use({ viewport: { width: 1440, height: 1080 } });

let page: Page;
let projectId = '';
let spaceId = '';

/**
 * Write one empty node into the open Space's document and open its panel.
 * @param kind - The node type to write.
 * @returns Nothing.
 */
async function openPanelOnNewNode(kind: 'image' | 'video'): Promise<void> {
  const nodeId = crypto.randomUUID();
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  await page.evaluate(
    async ([pid, sid, id, type, at]: [string, string, string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ at)) as {
        addNode: (p: string, s: string, n: unknown) => void;
      };
      canvas.addNode(pid, sid, {
        id,
        type,
        position: { x: 0, y: 0 },
        data: { name: `${type}-template`, createdAt: Date.now(), createdBy: 'template-e2e', locked: false, state: 'idle', attachments: [] },
      });
    },
    [projectId, spaceId, nodeId, kind, canvasAt] as [string, string, string, string, string],
  );
  const node = visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(node).toBeVisible({ timeout: 15_000 });
  await node.click({ button: 'right' });
  await page.getByTestId('node-menu-generate').click();
}

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ storageState: STATE_FILE.A });
  await openSmokeProject(page);
  projectId = (/([0-9a-f-]{36})$/.exec(page.url()) ?? [])[1] ?? '';
  if (!projectId) throw new Error(`no project id in ${page.url()}`);
  spaceId = await createSpace(page, 'canvas', `template-e2e-${Date.now()}`);
});

test.afterEach(async () => {
  await deleteSpace(page, spaceId);
  await page.close();
});

test('picking a template sets the image panel up and reminds the reader', async () => {
  await openPanelOnNewNode('image');
  const trigger = page.getByTestId('generate-template-trigger');
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  // Right before the close button, in the panel's corner.
  expect(await trigger.evaluate((el) => el.nextElementSibling?.getAttribute('data-testid'))).toBe('generate-exit');

  await trigger.click();
  await expect(page.getByTestId('generate-template-costume-sheet')).toBeVisible();
  await page.getByTestId('generate-template-storyboard-grid-25').click();

  await expect(page.getByTestId('generate-mode-trigger')).toHaveText('Image to Image');
  await expect(page.getByTestId('generate-model-trigger')).toContainText('Nano Banana Pro');
  await expect(page.getByTestId('generate-prompt-editor')).toContainText('[✏️ the story]');
  await expect(page.getByText('Edit the marked parts of the prompt')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('image-template-applied.png') });
});

test('a panel with no templates says so', async () => {
  await openPanelOnNewNode('video');
  await page.getByTestId('generate-template-trigger').click();
  await expect(page.getByTestId('generate-template-empty')).toHaveText('No templates');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('generate-template-empty')).toBeHidden();
});
