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
import { expect, test, type Page } from 'playwright/test';

import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { STATE_FILE, openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace } from '../helpers/space';

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
  const composer = page.getByTestId('chat-composer-textarea');
  await page.getByTestId('new-conversation').click();
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
  await composer.fill('Find me a few cyberpunk reference images -- neon, rainy night, street.');
  await composer.press('Enter');
  await expect(page.getByTestId('asset-row')).toBeVisible({ timeout: 150_000 });

  // The corner button appears on hover and says copied once pressed.
  const square = page.getByTestId('asset-thumb').first();
  await square.hover();
  const copy = page.getByTestId('asset-copy').first();
  await expect(copy).toHaveCSS('opacity', '1');
  await copy.click();
  await expect(page.getByTestId('copy-answer')).toBeVisible();

  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text.startsWith('__breatic_canvas_nodes__:')).toBe(true);
  const [copied] = JSON.parse(text.slice('__breatic_canvas_nodes__:'.length)) as {
    name?: string;
    content: string;
    external: boolean;
  }[];
  expect(copied?.external).toBe(true);
  expect(copied?.content.startsWith('https://')).toBe(true);

  // Pasted straight away: the keyboard is still on the copy button.
  const before = (await documentNodes(page)).length;
  await page.keyboard.press('ControlOrMeta+V');

  await expect.poll(async () => (await documentNodes(page)).length, { timeout: 15_000 }).toBe(before + 1);
  const pasted = (await documentNodes(page)).at(-1) as DocNode;
  expect(pasted.type).toBe('image');
  expect(pasted.name).toBe(copied?.name ?? pasted.name);
  // The node never holds the outside address; the server writes the stored one.
  expect(pasted.content).not.toBe(copied?.content);

  await expect
    .poll(async () => (await documentNodes(page)).find((n) => n.id === pasted.id)?.content ?? null, {
      timeout: 120_000,
    })
    .not.toBeNull();
  const stored = (await documentNodes(page)).find((n) => n.id === pasted.id)?.content as string;
  expect(stored).not.toBe(copied?.content);
  expect(new URL(stored).host).not.toBe(new URL(copied?.content ?? stored).host);

  // The open box carries the labelled button for the same picture.
  await square.click();
  const boxCopy = page.getByTestId('asset-box-copy');
  await expect(boxCopy).toContainText('Copy');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('asset-box')).toHaveCount(0);
});
