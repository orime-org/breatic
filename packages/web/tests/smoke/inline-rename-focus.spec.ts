// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#956: where the keyboard lands when an inline rename box on the project
 * page is ended with Enter or Escape.
 *
 * Every box unmounts while it holds the focus, so without a hand-back the
 * focus falls to the page and the next key reaches nothing. Each case ends the
 * box from the keyboard and reads `document.activeElement`. The Enter key is
 * the one that matters most for the history row: the box used to hand the
 * keystroke on to the row button, which switched the conversation on screen.
 */
import { expect, test, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

let page: Page;
const spaces: string[] = [];

/**
 * Describes the focused element in a few fields a case can compare.
 * @returns The test id, the Space outlet it is in, whether it carries the
 *   content-container mark, and the node id when it is a canvas node shell.
 */
async function focused(): Promise<{
  testId: string | null;
  outlet: string | null;
  focusRoot: boolean;
  nodeId: string | null;
}> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || el === document.body) {
      return { testId: null, outlet: null, focusRoot: false, nodeId: null };
    }
    return {
      testId: el.getAttribute('data-testid'),
      outlet: el.closest('[data-space-outlet]')?.getAttribute('data-space-outlet') ?? null,
      focusRoot: el.hasAttribute('data-space-focus-root'),
      nodeId: el.classList.contains('react-flow__node') ? el.getAttribute('data-id') : null,
    };
  });
}

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({
    storageState: STATE_FILE.A,
    viewport: { width: 1600, height: 950 },
  });
  await openSmokeProject(page);
});

test.afterEach(async () => {
  await page.keyboard.press('Escape');
  for (const id of spaces.splice(0)) await deleteSpace(page, id);
  await page.close();
});

for (const kind of ['canvas', 'document'] as const) {
  test(`a ${kind} Space tab rename gives the Space content the keyboard`, async () => {
    const id = await createSpace(page, kind, `rename-${kind}-${String(Date.now())}`);
    spaces.push(id);
    await page.getByTestId(`space-tab-name-${id}`).click();
    if (kind === 'canvas') {
      await expect(visibleSpace(page).getByTestId('canvas-space')).toBeVisible({ timeout: 20_000 });
    } else {
      await expect(visibleSpace(page).locator('.ProseMirror')).toBeVisible({ timeout: 20_000 });
    }

    for (const key of ['Enter', 'Escape']) {
      await page.getByTestId(`space-tab-name-${id}`).dblclick();
      const field = page.getByTestId(`space-tab-name-input-${id}`);
      await expect(field).toBeFocused();
      await page.keyboard.press(key);
      await expect(field).toHaveCount(0);
      expect(await focused()).toMatchObject({ outlet: id, focusRoot: true });
    }
  });
}

test('a node name and a group name rename give the node the keyboard', async () => {
  const id = await createSpace(page, 'canvas', `rename-node-${String(Date.now())}`);
  spaces.push(id);
  await page.getByTestId(`space-tab-name-${id}`).click();
  const pane = visibleSpace(page).locator('.react-flow__pane');
  await expect(pane).toBeVisible({ timeout: 20_000 });
  const box = await pane.boundingBox();
  if (box === null) throw new Error('the canvas pane has no box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.getByTestId('create-node-image').click();
  const node = visibleSpace(page).locator('.react-flow__node-image').first();
  await expect(node).toBeVisible({ timeout: 20_000 });
  const nodeId = await node.getAttribute('data-id');

  for (const key of ['Enter', 'Escape']) {
    await node.getByTestId('node-header-name').dblclick();
    const field = node.getByTestId('node-header-input');
    await expect(field).toBeFocused();
    await page.keyboard.press(key);
    await expect(field).toHaveCount(0);
    expect(await focused()).toMatchObject({ nodeId });
  }

  // A Group takes at least two loose nodes.
  await page.mouse.click(box.x + box.width / 2 + 360, box.y + box.height / 2, { button: 'right' });
  await page.getByTestId('create-node-image').click();
  const second = visibleSpace(page).locator('.react-flow__node-image').nth(1);
  await expect(second).toBeVisible({ timeout: 20_000 });
  // A drag on the empty canvas selects every node it encloses.
  const a = await node.boundingBox();
  const b = await second.boundingBox();
  if (a === null || b === null) throw new Error('a node has no box');
  await page.mouse.move(a.x - 60, a.y - 60);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width + 60, b.y + b.height + 60, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press('ControlOrMeta+g');
  const group = visibleSpace(page).locator('.react-flow__node-group').first();
  await expect(group).toBeVisible({ timeout: 10_000 });
  const groupId = await group.getAttribute('data-id');
  for (const key of ['Enter', 'Escape']) {
    await group.getByTestId('group-name').dblclick();
    const field = group.getByTestId('group-name-input');
    await expect(field).toBeFocused();
    await page.keyboard.press(key);
    await expect(field).toHaveCount(0);
    expect(await focused()).toMatchObject({ nodeId: groupId });
  }
});

for (const region of ['top-bar', 'agent-column'] as const) {
  test(`the ${region} title rename gives the title the keyboard`, async () => {
    const title = page.getByTestId(region).getByTestId('title-display');
    await expect(title).toBeVisible({ timeout: 20_000 });
    for (const key of ['Enter', 'Escape']) {
      await title.focus();
      await page.keyboard.press('Enter');
      const field = page.getByTestId(region).getByTestId('title-input');
      await expect(field).toBeFocused();
      await page.keyboard.press(key);
      await expect(field).toHaveCount(0);
      await expect(title).toBeFocused();
    }
  });
}

test('a history row rename gives the row menu the keyboard and keeps the conversation', async () => {
  await page.getByTestId('open-conversation-history').click();
  const list = page.getByTestId('conversation-history-list');
  const menu = list.locator('[data-testid^="conversation-menu-"]').first();
  await expect(menu).toBeAttached({ timeout: 15_000 });
  const rowId = ((await menu.getAttribute('data-testid')) ?? '').replace('conversation-menu-', '');
  const current = list.locator('[aria-current="true"]');
  const currentBefore = await current.getAttribute('data-testid');

  for (const key of ['Enter', 'Escape']) {
    // The keyboard path: the row's menu button, Enter for the menu, Enter on
    // Rename, then the key that ends the box.
    await menu.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(`conversation-rename-${rowId}`)).toBeVisible();
    await page.keyboard.press('Enter');
    const field = page.getByTestId('conversation-rename-input');
    await expect(field).toBeFocused();
    await page.keyboard.press(key);
    await expect(field).toHaveCount(0);
    await expect(page.getByTestId(`conversation-menu-${rowId}`)).toBeFocused();
    await expect(page.getByTestId('conversation-history-sheet')).toBeVisible();
    expect(await current.getAttribute('data-testid')).toBe(currentBefore);
  }
});
