// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Copying a picture the agent found and pasting it onto the canvas.
 *
 * The copy puts the canvas's own clipboard text on the real clipboard; the
 * paste is a real Cmd/Ctrl+V pressed right after the click, with the keyboard
 * still in the agent column. The node it makes starts empty and ends holding
 * the stored copy's address, which only the server can write -- so this
 * waits on the shared document rather than on anything this browser drew.
 *
 * The turn is real, so the model decides whether to search; a run where it
 * answers in prose instead fails at the row of pictures.
 */
import { expect, test, type Locator, type Page } from 'playwright/test';

import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { STATE_FILE, openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

test.use({ storageState: STATE_FILE.A, viewport: { width: 1400, height: 900 } });

let projectId = '';
let spaceId = '';

/** One node as the shared document has it. */
interface DocNode {
  id: string;
  type: string;
  name: string;
  content: string | null;
}

/**
 * Every node the shared document holds.
 * @param page - The page with the Space open.
 * @returns One entry per node.
 */
async function documentNodes(page: Page): Promise<DocNode[]> {
  const canvasUrl = await liveModuleUrl(page, CANVAS_SPACE);
  return page.evaluate(
    async ([pid, sid, at]: [string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ at)) as {
        readCanvasGraph: (
          p: string,
          s: string,
        ) => { nodes: { id: string; type: string; data?: { name?: string; content?: string } }[] };
      };
      return canvas.readCanvasGraph(pid, sid).nodes.map((n) => ({
        id: n.id,
        type: n.type,
        name: n.data?.name ?? '',
        content: n.data?.content ?? null,
      }));
    },
    [projectId, spaceId, canvasUrl] as [string, string, string],
  );
}

/**
 * Asserts buttons are still hidden once any opacity transition has run out.
 *
 * A transition starts from the old value, so a check made right after the
 * pointer moves reads 0 even for a button on its way to showing.
 * @param page - The page.
 * @param buttons - The buttons; there may be none.
 */
async function stillHidden(page: Page, buttons: Locator[]): Promise<void> {
  await page.waitForTimeout(500);
  for (const button of buttons) await expect(button).toHaveCSS('opacity', '0');
}

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openSmokeProject(page);
  projectId = (/([0-9a-f-]{36})$/.exec(page.url()) ?? [])[1] as string;
  spaceId = await createSpace(page, 'canvas', `copy-picture ${Date.now()}`);
});

test.afterEach(async ({ page }) => {
  await deleteSpace(page, spaceId);
});

test('a copied picture pastes onto the canvas and lands as a stored picture @needs-model @needs-search @needs-internet @needs-storage', async ({ page }) => {
  // A real turn (up to 150s) and a real fetch into storage (up to 120s).
  test.setTimeout(360_000);
  const composer = page.getByTestId('chat-composer-box');
  await page.getByTestId('new-conversation').click();
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
  await composer.fill('Find me a few cyberpunk reference images -- neon, rainy night, street.');
  await composer.press('Enter');
  await expect(page.getByTestId('asset-row')).toBeVisible({ timeout: 150_000 });

  // The corner button appears on the hovered square only, and not while the
  // pointer is on the reply's words.
  const copies = page.getByTestId('asset-copy');
  const reply = page.getByTestId('message-bubble').filter({ has: page.getByTestId('asset-row') });
  await reply.getByTestId('markdown-body').first().hover({ position: { x: 4, y: 4 } });
  await stillHidden(page, await copies.all());
  const square = page.getByTestId('asset-thumb').first();
  await square.hover();
  const copy = copies.first();
  await expect(copy).toHaveCSS('opacity', '1');
  // The row may hold a single picture, so every other button is checked.
  await stillHidden(page, (await copies.all()).slice(1));
  await copy.click();
  await expect(page.getByTestId('copy-answer')).toBeVisible();

  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text.startsWith('__breatic_canvas_nodes__:')).toBe(true);
  const payload = JSON.parse(text.slice('__breatic_canvas_nodes__:'.length)) as {
    version: number;
    nodes: { data: { name?: string; content: string }; external: boolean }[];
  };
  expect(payload.version).toBe(2);
  const [copied] = payload.nodes;
  expect(copied?.external).toBe(true);
  expect(copied?.data.content.startsWith('https://')).toBe(true);

  // Pasted straight away: the keyboard is still on the copy button.
  const before = (await documentNodes(page)).length;
  await page.keyboard.press('ControlOrMeta+V');

  await expect.poll(async () => (await documentNodes(page)).length, { timeout: 15_000 }).toBe(before + 1);
  const pasted = (await documentNodes(page)).at(-1) as DocNode;
  expect(pasted.type).toBe('image');
  expect(pasted.name).toBe(copied?.data.name ?? pasted.name);
  // The node never holds the outside address; the server writes the stored one.
  expect(pasted.content).not.toBe(copied?.data.content);
  // It lands in the view, the way a pasted file does.
  const pane = await visibleSpace(page).locator('.react-flow').boundingBox();
  const placed = await visibleSpace(page).locator(`.react-flow__node[data-id="${pasted.id}"]`).boundingBox();
  if (pane === null || placed === null) throw new Error('the canvas or the node is not on screen');
  expect(placed.x).toBeGreaterThanOrEqual(pane.x);
  expect(placed.y).toBeGreaterThanOrEqual(pane.y);
  expect(placed.x + placed.width).toBeLessThanOrEqual(pane.x + pane.width);
  expect(placed.y + placed.height).toBeLessThanOrEqual(pane.y + pane.height);

  await expect
    .poll(async () => (await documentNodes(page)).find((n) => n.id === pasted.id)?.content ?? null, {
      timeout: 120_000,
    })
    .not.toBeNull();
  const stored = (await documentNodes(page)).find((n) => n.id === pasted.id)?.content as string;
  expect(stored).not.toBe(copied?.data.content);
  expect(new URL(stored).host).not.toBe(new URL(copied?.data.content ?? stored).host);

  // The open box carries the labelled button for the same picture.
  await square.click();
  const boxCopy = page.getByTestId('asset-box-copy');
  await expect(boxCopy).toContainText('Copy');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('asset-box')).toHaveCount(0);

  // A paste made from the agent column hands the keyboard to the canvas, so
  // the undo that follows takes the pasted node back.
  const settled = (await documentNodes(page)).length;
  await square.hover();
  await copy.click();
  await page.keyboard.press('ControlOrMeta+V');
  await expect.poll(async () => (await documentNodes(page)).length, { timeout: 15_000 }).toBe(settled + 1);
  await page.keyboard.press('ControlOrMeta+Z');
  await expect.poll(async () => (await documentNodes(page)).length, { timeout: 15_000 }).toBe(settled);
});
