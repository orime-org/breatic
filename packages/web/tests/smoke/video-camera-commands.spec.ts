// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Camera commands on MiniMax H3: the picker sits in the settings
 * row, keeps opposite directions and Static shot apart, previews each command
 * in a pane at the top, and writes the picks as one bracket at the
 * caret the reader left -- in the prompt, or in the shot box in the multi-shot
 * mode -- which the submit carries.
 *
 * The submit is stubbed: whether H3 acts on the commands was measured on real
 * runs when the commands were added, and is not what this checks.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { createSpace, deleteSpace, visibleSpace, VISIBLE_SPACE } from '../helpers/space';

test.use({ viewport: { width: 1440, height: 1200 } });

const H3 = 'minimax-h3-text-to-video';
const OTHER = 'kling-v3.0-4k-text-to-video';

let page: Page;
let projectId = '';
let spaceId = '';

/**
 * The test id of one command's option.
 * @param name - The command.
 * @returns Its test id.
 */
const option = (name: string): string =>
  `generate-video-camera-option-${name.toLowerCase().replace(/ /g, '-')}`;

/**
 * Write an empty video node into the open Space, near the top of the pane.
 * @param p - A page with the Space open.
 * @returns The node's id.
 */
async function seedVideoNode(p: Page): Promise<string> {
  await expect(visibleSpace(p).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const nodeId = crypto.randomUUID();
  const canvasAt = await liveModuleUrl(p, CANVAS_SPACE);
  const origin = await p.evaluate((space) => {
    const vp = document.querySelector(`${space} .react-flow__viewport`);
    if (!(vp instanceof HTMLElement)) throw new Error('canvas not mounted');
    const m = new DOMMatrixReadOnly(getComputedStyle(vp).transform);
    return { tx: m.e, ty: m.f, scale: m.a };
  }, VISIBLE_SPACE);
  await p.evaluate(
    async ([pid, sid, id, x, y, at]: [string, string, string, number, number, string]) => {
      const canvas = (await import(/* @vite-ignore */ at)) as {
        addNode: (p: string, s: string, n: unknown) => void;
      };
      canvas.addNode(pid, sid, {
        id,
        type: 'video',
        position: { x, y },
        data: { name: 'camera-e2e', createdAt: Date.now(), createdBy: 'camera-e2e', locked: false, attachments: [] },
      });
    },
    [projectId, spaceId, nodeId, Math.round((200 - origin.tx) / origin.scale), Math.round((500 - origin.ty) / origin.scale), canvasAt] as [
      string, string, string, number, number, string,
    ],
  );
  return nodeId;
}

/**
 * Open the Generate panel the way a person does, then put it on a mode and model.
 * @param p - A page with the Space open.
 * @param nodeId - The node.
 * @param mode - The mode's test id suffix.
 * @param model - The model to pick.
 */
async function openOn(p: Page, nodeId: string, mode: 't2v' | 'multi-shot', model: string): Promise<void> {
  const node = visibleSpace(p).locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(node).toBeVisible({ timeout: 15_000 });
  await node.click({ button: 'right' });
  await p.getByTestId('node-menu-generate').click();
  await expect(p.getByTestId('generate-video-execute')).toBeVisible({ timeout: 15_000 });
  await pickModeAndModel(p, mode, model);
}

/**
 * Put the open panel on a mode and model.
 * @param p - A page with the panel open.
 * @param mode - The mode's test id suffix.
 * @param model - The model to pick.
 */
async function pickModeAndModel(p: Page, mode: 't2v' | 'multi-shot', model: string): Promise<void> {
  await p.getByTestId('generate-video-mode-trigger').click();
  await p.getByTestId(`generate-video-mode-${mode}`).click();
  await p.getByTestId('generate-model-trigger').click();
  await p.getByTestId(`generate-model-option-${model}`).click();
}

/**
 * Open the picker, pick the commands in order, and insert them.
 * @param p - A page with the panel open.
 * @param names - The commands.
 */
async function insert(p: Page, ...names: string[]): Promise<void> {
  await p.getByTestId('generate-video-camera-trigger').click();
  for (const name of names) await p.getByTestId(option(name)).click();
  await p.getByTestId('generate-video-camera-insert').click();
  await expect(p.getByTestId('generate-video-camera-insert')).toHaveCount(0);
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
  spaceId = await createSpace(page, 'canvas', `camera-e2e-${Date.now()}`);
});

test.afterEach(async () => {
  if (spaceId) await deleteSpace(page, spaceId);
  await page.close();
});

test('picks camera commands and writes them at the caret, then sends them', async () => {
  const nodeId = await seedVideoNode(page);
  await openOn(page, nodeId, 't2v', H3);

  // The pill sits in the settings row, right after the settings pill.
  const params = await page.getByTestId('generate-video-params-trigger').boundingBox();
  const camera = await page.getByTestId('generate-video-camera-trigger').boundingBox();
  if (!params || !camera) throw new Error('settings row not drawn');
  expect(Math.abs(camera.y + camera.height / 2 - (params.y + params.height / 2))).toBeLessThan(2);
  expect(camera.x).toBeGreaterThan(params.x + params.width - 1);

  // Fifteen commands; at three, only the ones that would replace a pick stay live.
  await page.getByTestId('generate-video-camera-trigger').click();
  await expect(page.locator('[data-testid^="generate-video-camera-option-"]')).toHaveCount(15);
  for (const name of ['Truck left', 'Push in', 'Zoom out']) await page.getByTestId(option(name)).click();
  await expect(page.getByTestId(option('Pan left'))).toBeDisabled();
  await page.getByTestId(option('Truck right')).click();
  await expect(page.getByTestId(option('Truck left'))).not.toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('generate-video-camera-order-truck-right')).toBeVisible();
  await expect(page.getByTestId('generate-video-camera-order-truck-right')).toHaveText('3');
  await expect(page.getByTestId('generate-video-camera-order-pan-left')).toBeHidden();

  await expect(page.getByTestId('generate-video-camera-count')).toHaveText('3/3 · [Push in,Zoom out,Truck right]');

  // A disabled command previews too, in the pane above every row, which covers none of them.
  const pane = page.getByTestId('generate-video-camera-preview');
  await page.getByTestId(option('Shake')).locator('..').hover();
  await expect(pane.locator('video')).toHaveAttribute('src', /camera-previews\/minimax-h3\/shake-640\.mp4$/);
  const paneBox = await pane.boundingBox();
  const firstRow = await page.getByTestId(option('Truck left')).boundingBox();
  if (!paneBox || !firstRow) throw new Error('picker not drawn');
  expect(paneBox.y + paneBox.height).toBeLessThanOrEqual(firstRow.y);
  await expect(page.getByTestId('hover-preview-content')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // The widest row, numbers showing, stays inside the popover, and a pick never resizes it.
  await page.getByTestId('generate-video-camera-trigger').click();
  const popover = page.locator('[data-radix-popper-content-wrapper] > *').filter({ has: pane });
  // Layout width: the open animation scales the box, which a rect would include.
  const widthBefore = await popover.evaluate((box) => (box as HTMLElement).offsetWidth);
  for (const name of ['Shake', 'Tracking shot']) await page.getByTestId(option(name)).click();
  const fit = await popover.evaluate((box) => {
    const inner = box.getBoundingClientRect().right - parseFloat(getComputedStyle(box).paddingRight);
    const parts = [...box.querySelectorAll('[data-testid^="generate-video-camera-option-"], p')] as HTMLElement[];
    return {
      width: (box as HTMLElement).offsetWidth,
      out: parts.filter((e) => e.getBoundingClientRect().right > inner + 0.5).map((e) => e.textContent),
      wrapped: parts.filter((e) => e.tagName === 'P' && e.getBoundingClientRect().height > parseFloat(getComputedStyle(e).lineHeight) + 1).map((e) => e.textContent),
    };
  });
  expect(fit.out).toEqual([]);
  expect(fit.wrapped).toEqual([]);
  expect(fit.width).toBe(widthBefore);

  // Moving through the options with Tab previews each one the focus lands on.
  await page.getByTestId(option('Shake')).focus();
  await page.keyboard.press('Tab');
  await expect(pane.locator('video')).toHaveAttribute('src', /tracking-shot-640\.mp4$/);
  await page.keyboard.press('Escape');

  // Every open starts on the hint: from the keyboard, by mouse after an Escape,
  // and after a hover that landed while the popover was fading out.
  const trigger = page.getByTestId('generate-video-camera-trigger');
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(pane).toBeVisible();
  await expect(pane.locator('video')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await trigger.click();
  await expect(pane).toBeVisible();
  await expect(pane.locator('video')).toHaveCount(0);
  const shakeBox = await page.getByTestId(option('Shake')).boundingBox();
  if (!shakeBox) throw new Error('picker not drawn');
  await page.keyboard.press('Escape');
  await page.mouse.move(shakeBox.x + 5, shakeBox.y + 5);
  await page.mouse.move(shakeBox.x + 10, shakeBox.y + 6);
  await expect(pane).toHaveCount(0);
  await trigger.click();
  await expect(pane).toBeVisible();
  await expect(pane.locator('video')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // The caret goes after "a red", then the picker takes focus, then the bracket lands there.
  const editor = page.getByTestId('generate-prompt-editor');
  await editor.click();
  await page.keyboard.type('a red car parked by a wall');
  // Back from the end to just after "a red": arrow keys move the same way on every platform.
  for (let i = 0; i < 'car parked by a wall'.length + 1; i += 1) await page.keyboard.press('ArrowLeft');
  await insert(page, 'Push in', 'Zoom out');
  await expect(editor).toHaveText('a red [Push in,Zoom out] car parked by a wall');

  const body = await captureSubmit(page);
  await page.getByTestId('generate-video-execute').click();
  await expect.poll(() => (body()?.params as { prompt?: string } | undefined)?.prompt).toBe(
    'a red [Push in,Zoom out] car parked by a wall',
  );
});

test('writes into the shot box last clicked into, and the shot line carries it', async () => {
  const nodeId = await seedVideoNode(page);
  await openOn(page, nodeId, 'multi-shot', H3);
  await page.getByTestId('generate-storyboard-shot-1-editor').click();
  await page.keyboard.type('a paper boat');
  await page.getByTestId('generate-storyboard-shot-2-editor').click();
  await page.keyboard.type('the pond at dusk');
  await insert(page, 'Tilt up');
  await expect(page.getByTestId('generate-storyboard-shot-2-editor')).toHaveText('the pond at dusk [Tilt up]');
  await expect(page.getByTestId('generate-storyboard-shot-1-editor')).toHaveText('a paper boat');

  const body = await captureSubmit(page);
  await page.getByTestId('generate-video-execute').click();
  await expect.poll(() => (body()?.params as { prompt?: string } | undefined)?.prompt).toMatch(
    /Shot 2 \[[^\]]+\]: the pond at dusk \[Tilt up\]$/,
  );
});

test('draws no camera pill for a model that reads no commands', async () => {
  const nodeId = await seedVideoNode(page);
  await openOn(page, nodeId, 't2v', H3);
  await expect(page.getByTestId('generate-video-camera-trigger')).toBeVisible();
  await page.getByTestId('generate-model-trigger').click();
  await page.getByTestId(`generate-model-option-${OTHER}`).click();
  await expect(page.getByTestId('generate-video-camera-trigger')).toHaveCount(0);
});
