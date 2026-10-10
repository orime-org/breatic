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
 *   content-container mark, and the node id when it is a canvas node wrapper.
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

/**
 * Opens the history and picks a row that is not the conversation on screen,
 * making one when the project holds only that conversation. A rename that
 * reopened its own row would switch to it, and only a row other than the
 * current one shows that on screen.
 * @returns The row's id and the open button of the conversation on screen.
 */
async function openHistoryAtAnotherRow(): Promise<{ rowId: string; currentBefore: string | null }> {
  const list = page.getByTestId('conversation-history-list');
  const others = list.locator('[data-testid^="conversation-open-"]:not([aria-current])');
  await page.getByTestId('open-conversation-history').click();
  await expect(list.locator('[data-testid^="conversation-open-"]').first()).toBeAttached({ timeout: 15_000 });
  if ((await others.count()) === 0) {
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('conversation-history-sheet')).toHaveCount(0);
    await page.getByTestId('new-conversation').click();
    await page.getByTestId('open-conversation-history').click();
    await expect(others.first()).toBeAttached({ timeout: 15_000 });
  }
  const rowId = ((await others.first().getAttribute('data-testid')) ?? '').replace('conversation-open-', '');
  const currentBefore = await list.locator('[aria-current="true"]').getAttribute('data-testid');
  return { rowId, currentBefore };
}

/**
 * Opens a row's rename box the keyboard way: the row's menu button, Enter for
 * the menu, Enter on Rename.
 * @param rowId - The row.
 */
async function renameRowFromKeyboard(rowId: string): Promise<void> {
  await page.getByTestId(`conversation-menu-${rowId}`).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(`conversation-rename-${rowId}`)).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('conversation-rename-input')).toBeFocused();
}

test('a history row rename gives the row menu the keyboard and keeps the conversation', async () => {
  const { rowId, currentBefore } = await openHistoryAtAnotherRow();
  const list = page.getByTestId('conversation-history-list');

  for (const key of ['Enter', 'Escape']) {
    await renameRowFromKeyboard(rowId);
    await page.keyboard.press(key);
    await expect(page.getByTestId('conversation-rename-input')).toHaveCount(0);
    await expect(page.getByTestId(`conversation-menu-${rowId}`)).toBeFocused();
    await expect(page.getByTestId('conversation-history-sheet')).toBeVisible();
    expect(await list.locator('[aria-current="true"]').getAttribute('data-testid')).toBe(currentBefore);
  }
});

/**
 * Holds Enter down: the press, the auto-repeats the system sends while the key
 * is held, then its release.
 * @param repeats - How many repeats to send.
 */
async function holdEnter(repeats: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...enter });
  for (let i = 0; i < repeats; i += 1) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: true, text: '\r', ...enter });
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
  await cdp.detach();
}

test('holding the Enter that ends a rename does not act on where the keyboard went', async () => {
  // The title opens for editing on Enter.
  const title = page.getByTestId('top-bar').getByTestId('title-display');
  await title.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('top-bar').getByTestId('title-input')).toBeFocused();
  await holdEnter(3);
  await expect(page.getByTestId('top-bar').getByTestId('title-input')).toHaveCount(0);
  await expect(title).toBeFocused();

  // The row menu button opens its menu on Enter.
  const { rowId } = await openHistoryAtAnotherRow();
  await renameRowFromKeyboard(rowId);
  await holdEnter(3);
  await expect(page.getByTestId('conversation-rename-input')).toHaveCount(0);
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByTestId(`conversation-menu-${rowId}`)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('conversation-history-sheet')).toHaveCount(0);

  // A text node opens its body on Enter.
  const id = await createSpace(page, 'canvas', `rename-held-${String(Date.now())}`);
  spaces.push(id);
  await page.getByTestId(`space-tab-name-${id}`).click();
  const pane = visibleSpace(page).locator('.react-flow__pane');
  await expect(pane).toBeVisible({ timeout: 20_000 });
  const box = await pane.boundingBox();
  if (box === null) throw new Error('the canvas pane has no box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.getByTestId('create-node-text').click();
  const node = visibleSpace(page).locator('.react-flow__node-text').first();
  await expect(node).toBeVisible({ timeout: 20_000 });
  await node.getByTestId('node-header-name').dblclick();
  await expect(node.getByTestId('node-header-input')).toBeFocused();
  await holdEnter(3);
  await expect(node.locator('[contenteditable="true"]')).toHaveCount(0);
  expect(await focused()).toMatchObject({ nodeId: await node.getAttribute('data-id') });
});
