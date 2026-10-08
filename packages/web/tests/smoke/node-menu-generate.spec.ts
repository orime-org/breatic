// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { expect, test, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

let page: Page;
const spaces: string[] = [];

/**
 * Create a node of one kind at the middle of the canvas and open its menu.
 * @param kind - The node kind the pane menu offers, as its test id suffix.
 * @returns Nothing; the node's menu is open when it resolves.
 */
async function openMenuOnNewNode(kind: 'image' | 'text'): Promise<void> {
  const pane = visibleSpace(page).locator('.react-flow__pane');
  const box = await pane.boundingBox();
  if (box === null) throw new Error('the canvas pane has no box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.getByTestId(`create-node-${kind}`).click();
  const node = visibleSpace(page).locator(`.react-flow__node-${kind}`).first();
  await expect(node).toBeVisible({ timeout: 20_000 });
  await node.click({ button: 'right' });
  await expect(page.getByTestId('node-menu-upload')).toBeVisible();
}

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({
    storageState: STATE_FILE.A,
    viewport: { width: 1500, height: 900 },
  });
  await openSmokeProject(page);
  spaces.push(await createSpace(page, 'canvas', `menu-${String(Date.now())}`));
});

test.afterEach(async () => {
  // An open menu takes every pointer event on the page, the Space drawer included.
  await page.keyboard.press('Escape');
  for (const id of spaces.splice(0)) await deleteSpace(page, id);
  await page.close();
});

test('a text node menu has no generate row', async () => {
  await openMenuOnNewNode('text');
  await expect(page.getByTestId('node-menu-generate')).toHaveCount(0);
});

test('an image node menu offers generate, enabled', async () => {
  await openMenuOnNewNode('image');
  const generate = page.getByTestId('node-menu-generate');
  await expect(generate).toBeVisible();
  await expect(generate).not.toHaveAttribute('data-disabled');
});
