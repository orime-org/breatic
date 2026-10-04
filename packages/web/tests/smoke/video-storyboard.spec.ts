// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One prompt per mode, and the multi-shot mode: shots typed into real
 * collaborative editors, stepped with real buttons and sent in the request
 * this client builds -- in Kling's own field, or written into the prompt for a
 * model with no field for them -- and the model names each mode's picker shows.
 *
 * The intercepting cases stub the submit; the `@needs-model` cases let a run
 * through and wait for the video, since whether the vendor takes the shots is
 * the one thing a stubbed response cannot say.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { createSpace, deleteSpace } from '../helpers/space';

// The panel hangs below its node and grows with every shot; at 720 the last
// shot's box falls past the window bottom.
test.use({ viewport: { width: 1440, height: 1200 } });

const KLING = 'kling-v3.0-4k-text-to-video';
const WAN = 'wan-3.0-text-to-video';

let page: Page;
let projectId = '';
let spaceId = '';

/**
 * Write an empty video node into the open Space, near the top of the pane.
 * @param p - A page with the Space open.
 * @returns The node's id.
 */
async function seedVideoNode(p: Page): Promise<string> {
  await expect(p.locator('.react-flow')).toBeVisible({ timeout: 20_000 });
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
  const node = p.locator(`.react-flow__node[data-id="${nodeId}"]`);
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
async function switchMode(p: Page, mode: 't2v' | 'i2v' | 'multi-shot'): Promise<void> {
  await p.getByTestId('generate-video-mode-trigger').click();
  await p.getByTestId(`generate-video-mode-${mode}`).click();
}

/**
 * Switch to the multi-shot mode, pick a model and write its two shots.
 * @param p - A page with the panel open.
 * @param model - The model to pick.
 */
async function writeTwoShots(p: Page, model: string): Promise<void> {
  await switchMode(p, 'multi-shot');
  await p.getByTestId('generate-model-trigger').click();
  await p.getByTestId(`generate-model-option-${model}`).click();
  await p.getByTestId('generate-storyboard-shot-1-editor').click();
  await p.keyboard.type('a red paper boat floats on a still pond, close-up');
  await p.getByTestId('generate-storyboard-shot-2-editor').click();
  await p.keyboard.type('the camera pulls back to show the whole pond at dusk');
}

/**
 * Answer the next task submit with a stub and hand back its body.
 * @param p - A page with the panel open.
 * @returns Reads the body once the submit went out.
 */
async function captureSubmit(p: Page): Promise<() => Record<string, unknown> | undefined> {
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

  await writeTwoShots(page, KLING);
  await expect(page.getByTestId('generate-prompt-editor')).toHaveCount(0);
  // Five seconds split two and three; a second moved from shot 2 to shot 1.
  await expect(page.getByTestId('generate-storyboard-shot-1-seconds')).toHaveText(/2/);
  await expect(page.getByTestId('generate-storyboard-shot-2-seconds')).toHaveText(/3/);
  await page.getByTestId('generate-storyboard-shot-1-more').click();
  await expect(page.getByTestId('generate-storyboard-shot-1-seconds')).toHaveText(/3/);
  await expect(page.getByTestId('generate-storyboard-shot-2-seconds')).toHaveText(/2/);

  const body = await captureSubmit(page);
  await page.getByTestId('generate-video-execute').click();
  await expect.poll(body, { timeout: 20_000 }).toBeDefined();

  const params = (body() as { params: Record<string, unknown> }).params;
  expect(params.shot_type).toBe('customize');
  expect(params.multi_prompt).toEqual([
    { prompt: 'a red paper boat floats on a still pond, close-up', duration: 3 },
    { prompt: 'the camera pulls back to show the whole pond at dusk', duration: 2 },
  ]);
  expect(params).not.toHaveProperty('prompt');
  expect(params).not.toHaveProperty('auto_shots');
});

test('writes the shots into the prompt for a model with no field for them', async () => {
  const nodeId = await seedVideoNode(page);
  await openGenerate(page, nodeId);
  await writeTwoShots(page, WAN);
  const body = await captureSubmit(page);
  await page.getByTestId('generate-video-execute').click();
  await expect.poll(body, { timeout: 20_000 }).toBeDefined();

  const params = (body() as { params: Record<string, unknown> }).params;
  expect(params.prompt).toBe(
    'Shot 1 [0-2s]: a red paper boat floats on a still pond, close-up\n' +
      'Shot 2 [2-5s]: the camera pulls back to show the whole pond at dusk',
  );
  expect(params).not.toHaveProperty('shots');
});

test('puts add-shot in the middle under the shots, its reason to its left when it cannot act', async () => {
  const nodeId = await seedVideoNode(page);
  await openGenerate(page, nodeId);
  await writeTwoShots(page, KLING);
  const add = page.getByTestId('generate-storyboard-add');
  const list = page.getByTestId('generate-storyboard-shots');
  const [addBox, listBox] = [await add.boundingBox(), await list.boundingBox()];
  if (!addBox || !listBox) throw new Error('add row not laid out');
  expect(addBox.y).toBeGreaterThan(listBox.y + listBox.height - 1);
  expect(Math.abs(addBox.x + addBox.width / 2 - (listBox.x + listBox.width / 2))).toBeLessThan(2);
  expect(addBox.width).toBeLessThan(listBox.width / 2);

  // Three seconds for three shots: no second left to give a fourth.
  await page.getByTestId('generate-video-params-trigger').click();
  await page.getByTestId('generate-video-duration-option-3').click();
  await page.keyboard.press('Escape');
  await add.click();
  await expect(add).toBeDisabled();
  const reason = page.getByTestId('generate-storyboard-add-blocked');
  const [r, b] = [await reason.boundingBox(), await add.boundingBox()];
  if (!r || !b) throw new Error('reason not laid out');
  expect(r.x + r.width).toBeLessThanOrEqual(b.x);
  expect(Math.abs(r.y + r.height / 2 - (b.y + b.height / 2))).toBeLessThan(2);
});

test('offers auto multi-shot on Kling in text to video only, and sends it', async () => {
  const nodeId = await seedVideoNode(page);
  await openGenerate(page, nodeId);
  await page.getByTestId('generate-model-trigger').click();
  await page.getByTestId(`generate-model-option-${KLING}`).click();
  await page.getByTestId('generate-prompt-editor').click();
  await page.keyboard.type('a boat, then the whole pond');
  await page.getByTestId('generate-video-params-trigger').click();
  await page.getByTestId('generate-param-auto_shots-toggle').click();
  await page.keyboard.press('Escape');

  const body = await captureSubmit(page);
  await page.getByTestId('generate-video-execute').click();
  await expect.poll(body, { timeout: 20_000 }).toBeDefined();
  expect((body() as { params: Record<string, unknown> }).params).toMatchObject({ auto_shots: true });

  // A submit closes the panel; open it again for the other mode.
  await openGenerate(page, nodeId);
  await switchMode(page, 'multi-shot');
  await page.getByTestId('generate-video-params-trigger').click();
  await expect(page.getByTestId('generate-param-auto_shots-toggle')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('names a model by its vendor, joining a variant on only where namesakes meet', async () => {
  const nodeId = await seedVideoNode(page);
  await openGenerate(page, nodeId);
  await switchMode(page, 'i2v');
  await page.getByTestId('generate-model-trigger').click();
  await expect(page.getByTestId('generate-model-option-gemini-omni-1.1-flash-image-to-video')).toContainText(
    /^Gemini Omni 1\.1 Flash(?! Image)/,
  );
  await page.keyboard.press('Escape');
  await switchMode(page, 'multi-shot');
  await page.getByTestId('generate-model-trigger').click();
  await expect(page.getByTestId('generate-model-option-gemini-omni-1.1-flash-text-to-video')).toContainText(
    'Gemini Omni 1.1 Flash Text-to-Video',
  );
  await expect(page.getByTestId('generate-model-option-gemini-omni-1.1-flash-reference-to-video')).toContainText(
    'Gemini Omni 1.1 Flash Reference',
  );
  await page.getByTestId('generate-model-option-gemini-omni-1.1-flash-reference-to-video').click();
  // The button cuts the vendor's name short and keeps the variant whole.
  const variant = page.getByTestId('generate-model-trigger-variant');
  await expect(variant).toHaveText('Reference');
  const [v, b] = [await variant.boundingBox(), await page.getByTestId('generate-model-trigger').boundingBox()];
  if (!v || !b) throw new Error('model button not laid out');
  expect(v.x + v.width).toBeLessThanOrEqual(b.x + b.width);
  expect(await variant.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

for (const [label, model] of [['Kling', KLING], ['Wan', WAN]] as const) {
  test(`${label} makes a video from the shots @needs-model`, async () => {
    test.setTimeout(15 * 60_000);
    const nodeId = await seedVideoNode(page);
    await openGenerate(page, nodeId);
    await writeTwoShots(page, model);

    const accepted = page.waitForResponse(
      (res) => res.url().includes('/canvas/tasks') && res.request().method() === 'POST',
    );
    await page.getByTestId('generate-video-execute').click();
    expect((await accepted).ok()).toBe(true);

    // The node holds a video once the run lands.
    const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
    await expect(node.locator('video')).toHaveCount(1, { timeout: 14 * 60_000 });
  });
}

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
