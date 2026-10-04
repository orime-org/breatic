// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One prompt per mode, and a Kling storyboard written shot by shot (#2218).
 *
 * What no jsdom test reaches: a mode a real menu switched to binding the
 * editor to that mode's own words, and a storyboard whose shots were typed
 * into real collaborative editors, stepped with real buttons and sent in the
 * request this client builds.
 *
 * The first case intercepts the submit; the second lets one run through to
 * Kling and waits for the video, since whether the vendor takes the shots is
 * the one thing a stubbed response cannot say.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

// The panel hangs below its node and grows with every shot; at 720 the last
// shot's box falls past the window bottom.
test.use({ viewport: { width: 1440, height: 1200 } });

const KLING = 'kling-v3.0-4k-text-to-video';

let page: Page;
let projectId = '';
let spaceId = '';

/**
 * Write an empty video node into the open Space, near the top of the pane.
 * @param p - A page with the Space open.
 * @returns The node's id.
 */
async function seedVideoNode(p: Page): Promise<string> {
  await expect(visibleSpace(p).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const nodeId = crypto.randomUUID();
  const canvasAt = await liveModuleUrl(p, CANVAS_SPACE);
  const origin = await p.evaluate(() => {
    const vp = document.querySelector('.react-flow__viewport');
    if (!(vp instanceof HTMLElement)) throw new Error('canvas not mounted');
    const m = new DOMMatrixReadOnly(getComputedStyle(vp).transform);
    return { tx: m.e, ty: m.f };
  });
  await p.evaluate(
    async ([pid, sid, id, x, y, at]: [string, string, string, number, number, string]) => {
      const canvas = (await import(/* @vite-ignore */ at)) as {
        addNode: (p: string, s: string, n: unknown) => void;
      };
      canvas.addNode(pid, sid, {
        id,
        type: 'video',
        position: { x, y },
        data: {
          name: 'storyboard-e2e',
          createdAt: Date.now(),
          createdBy: 'storyboard-e2e',
          locked: false,
          attachments: [],
        },
      });
    },
    [projectId, spaceId, nodeId, Math.round(200 - origin.tx), Math.round(40 - origin.ty), canvasAt] as [
      string,
      string,
      string,
      number,
      number,
      string,
    ],
  );
  return nodeId;
}

/**
 * Open the Generate panel the way a person does: right-click, then the item.
 * @param p - A page with the Space open.
 * @param nodeId - The node.
 */
async function openGenerate(p: Page, nodeId: string): Promise<void> {
  const node = visibleSpace(p).locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(node).toBeVisible({ timeout: 15_000 });
  await node.click({ button: 'right' });
  await p.getByTestId('node-menu-generate').click();
  await expect(p.getByTestId('generate-video-execute')).toBeVisible({ timeout: 15_000 });
}

/**
 * Switch the panel's mode through its menu.
 * @param p - A page with the panel open.
 * @param mode - The mode's test id suffix.
 */
async function switchMode(p: Page, mode: 't2v' | 'i2v'): Promise<void> {
  await p.getByTestId('generate-video-mode-trigger').click();
  await p.getByTestId(`generate-video-mode-${mode}`).click();
}

/**
 * Pick Kling and write two shots, the second one second longer.
 * @param p - A page with the panel open on text to video.
 */
async function writeTwoShots(p: Page): Promise<void> {
  await p.getByTestId('generate-model-trigger').click();
  await p.getByTestId(`generate-model-option-${KLING}`).click();
  await p.getByTestId('generate-storyboard-per-shot').click();
  await p.getByTestId('generate-storyboard-shot-1-editor').click();
  await p.keyboard.type('a red paper boat floats on a still pond, close-up');
  await p.getByTestId('generate-storyboard-shot-2-editor').click();
  await p.keyboard.type('the camera pulls back to show the whole pond at dusk');
}

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ storageState: STATE_FILE.A });
  await openSmokeProject(page);
  projectId = (/([0-9a-f-]{36})$/.exec(page.url()) ?? [])[1] ?? '';
  if (!projectId) throw new Error(`no project id in ${page.url()}`);
  spaceId = await createSpace(page, 'canvas', `storyboard-e2e-${Date.now()}`);
});

test.afterEach(async () => {
  if (spaceId) await deleteSpace(page, spaceId);
  await page.close();
});

test('keeps each mode\'s prompt, and sends the shots in place of it', async () => {
  const nodeId = await seedVideoNode(page);
  await openGenerate(page, nodeId);

  // A prompt per mode: switching away and back finds each one's own words.
  const editor = page.getByTestId('generate-prompt-editor');
  await editor.click();
  await page.keyboard.type('words for text to video');
  await switchMode(page, 'i2v');
  await expect(editor).not.toContainText('words for text to video');
  await editor.click();
  await page.keyboard.type('words for image to video');
  await switchMode(page, 't2v');
  await expect(editor).toContainText('words for text to video');
  await expect(editor).not.toContainText('words for image to video');

  await writeTwoShots(page);
  // Five seconds split two and three; a second moved from shot 2 to shot 1.
  await expect(page.getByTestId('generate-storyboard-shot-1-seconds')).toHaveText(/2/);
  await expect(page.getByTestId('generate-storyboard-shot-2-seconds')).toHaveText(/3/);
  await page.getByTestId('generate-storyboard-shot-1-more').click();
  await expect(page.getByTestId('generate-storyboard-shot-1-seconds')).toHaveText(/3/);
  await expect(page.getByTestId('generate-storyboard-shot-2-seconds')).toHaveText(/2/);

  let body: Record<string, unknown> | undefined;
  await page.route('**/canvas/tasks', async (route) => {
    body = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { id: crypto.randomUUID(), status: 'queued' } }),
    });
  });
  await page.getByTestId('generate-video-execute').click();
  await expect.poll(() => body, { timeout: 20_000 }).toBeDefined();

  const params = (body as { params: Record<string, unknown> }).params;
  expect(params.shot_type).toBe('customize');
  expect(params.multi_prompt).toEqual([
    { prompt: 'a red paper boat floats on a still pond, close-up', duration: 3 },
    { prompt: 'the camera pulls back to show the whole pond at dusk', duration: 2 },
  ]);
  expect(params).not.toHaveProperty('prompt');
});

test('Kling makes a video from the shots @needs-model', async () => {
  test.setTimeout(15 * 60_000);
  const nodeId = await seedVideoNode(page);
  await openGenerate(page, nodeId);
  await writeTwoShots(page);

  const accepted = page.waitForResponse(
    (res) => res.url().includes('/canvas/tasks') && res.request().method() === 'POST',
  );
  await page.getByTestId('generate-video-execute').click();
  expect((await accepted).ok()).toBe(true);

  // The node holds a video once the run lands.
  const node = visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(node.locator('video')).toHaveCount(1, { timeout: 14 * 60_000 });
});

test('a mode switch on one client moves the other to that mode\'s own words', async ({ browser }) => {
  const nodeId = await seedVideoNode(page);
  await openGenerate(page, nodeId);
  const editor = page.getByTestId('generate-prompt-editor');
  await editor.click();
  await page.keyboard.type('shared text to video words');

  // A second client on the same Space, its panel open on the same node.
  const peer = await browser.newPage({ storageState: STATE_FILE.A });
  try {
    await peer.goto(`/project/${projectId}`);
    const tab = peer.getByTestId(`space-tab-name-${spaceId}`);
    await expect(tab).toBeVisible({ timeout: 20_000 });
    await tab.click();
    await openGenerate(peer, nodeId);
    const peerEditor = peer.getByTestId('generate-prompt-editor');
    await expect(peerEditor).toContainText('shared text to video words');

    // One switches; both panels show the other mode's own, empty box.
    await switchMode(page, 'i2v');
    await expect(editor).not.toContainText('shared text to video words');
    await expect(peerEditor).not.toContainText('shared text to video words', { timeout: 10_000 });

    // Words typed there reach the other side; switching back finds the first mode's words kept.
    await editor.click();
    await page.keyboard.type('image to video words');
    await expect(peerEditor).toContainText('image to video words', { timeout: 10_000 });
    await switchMode(peer, 't2v');
    await expect(editor).toContainText('shared text to video words', { timeout: 10_000 });
    await expect(peerEditor).toContainText('shared text to video words');
  } finally {
    await peer.close();
  }
});
