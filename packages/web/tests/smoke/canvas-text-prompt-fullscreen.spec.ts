// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Full screen for a text node and for a generation prompt (inner#2115), driven
 * with the mouse in a real browser: the button above a text node's corner and
 * the one in the panel's first row open a large layer where the user types;
 * the `@` list inside it takes a mouse pick and its first Escape; Escape then
 * closes the layer and the words are in the node or the prompt.
 */

import { randomUUID } from 'node:crypto';

import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { addTextNode, textOf } from '../helpers/request-bodies';
import { createSpace, deleteSpace, visibleSpace, VISIBLE_SPACE } from '../helpers/space';

test.use({ viewport: { width: 1600, height: 1000 } });
test.setTimeout(90_000);

const madeSpaces: string[] = [];

test.afterEach(async ({ page }) => {
  while (madeSpaces.length > 0) await deleteSpace(page, madeSpaces.pop() as string);
});

/**
 * Write an image node into the open Space at a point of the window.
 * @param p - A page with the Space open.
 * @param at - Where it goes.
 * @param at.projectId - The Project.
 * @param at.spaceId - The Space.
 * @param x - Window x of its top-left corner.
 * @param y - Window y of its top-left corner.
 * @param content - Its picture, if it has one.
 * @returns The node's id.
 */
async function seedImageNode(
  p: Page,
  at: { projectId: string; spaceId: string },
  x: number,
  y: number,
  content?: string,
): Promise<string> {
  const nodeId = randomUUID();
  const url = await liveModuleUrl(p, CANVAS_SPACE);
  await p.evaluate(
    async ([pid, sid, id, left, top, moduleUrl, asset, shown]: [string, string, string, number, number, string, string, string]) => {
      const vp = document.querySelector(`${shown} .react-flow__viewport`);
      if (!(vp instanceof HTMLElement)) throw new Error('canvas not mounted');
      const m = new DOMMatrixReadOnly(getComputedStyle(vp).transform);
      const canvas = (await import(/* @vite-ignore */ moduleUrl)) as { addNode: (p: string, s: string, n: unknown) => void };
      canvas.addNode(pid, sid, {
        id,
        type: 'image',
        position: { x: (left - m.e) / m.a, y: (top - m.f) / m.d },
        data: {
          name: 'Dock',
          createdAt: Date.now(),
          createdBy: 'fullscreen-e2e',
          locked: false,
          state: 'idle',
          attachments: [],
          ...(asset ? { content: asset, status: 'ready' } : {}),
        },
      });
    },
    [at.projectId, at.spaceId, nodeId, x, y, url, content ?? '', VISIBLE_SPACE] as [string, string, string, number, number, string, string, string],
  );
  return nodeId;
}

test('a text node opens full screen from its corner, takes typing, and Escape brings it back', async ({ page }) => {
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, 'canvas', `fullscreen-text-${Date.now()}`);
  madeSpaces.push(spaceId);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const nodeId = randomUUID();
  await addTextNode(page, { projectId, spaceId, nodeId }, 'Scene one. The dock at night.');
  const node = visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`);

  await node.hover();
  const button = node.getByTestId('text-fullscreen-button');
  await expect(button).toBeVisible();
  await button.click();

  const layer = page.getByTestId('text-fullscreen');
  await expect(layer).toBeVisible();
  const editor = layer.locator('[contenteditable="true"]');
  await expect(editor).toBeFocused();
  await page.keyboard.type(' Rain.');
  await expect.poll(() => textOf(page, { projectId, spaceId, nodeId })).toBe('Scene one. The dock at night. Rain.');

  await page.keyboard.press('Escape');
  await expect(layer).toHaveCount(0);
  await expect(node.getByTestId('text-node-body')).toHaveText('Scene one. The dock at night. Rain.');
  await expect(node).toBeFocused();
});

test('the prompt opens full screen from the panel, the @ list works there, and Escape peels one layer at a time', async ({ page }) => {
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, 'canvas', `fullscreen-prompt-${Date.now()}`);
  madeSpaces.push(spaceId);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const at = { projectId, spaceId };
  // A text source: a text chip is offered in every mode, the default
  // text-to-image one included, whose pool takes no pictures.
  const source = randomUUID();
  await addTextNode(page, { projectId, spaceId, nodeId: source }, 'harbour lights');
  const target = await seedImageNode(page, at, 900, 200);
  const url = await liveModuleUrl(page, CANVAS_SPACE);
  await page.evaluate(
    async ([pid, sid, from, to, moduleUrl]: [string, string, string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ moduleUrl)) as { addEdge: (p: string, s: string, e: unknown) => boolean };
      if (!canvas.addEdge(pid, sid, { id: `${from}->${to}`, source: from, target: to })) throw new Error('edge refused');
    },
    [projectId, spaceId, source, target, url] as [string, string, string, string, string],
  );
  const node = visibleSpace(page).locator(`.react-flow__node[data-id="${target}"]`);
  await expect(node).toBeVisible({ timeout: 15_000 });
  await node.click({ button: 'right' });
  await page.getByTestId('node-menu-generate').click();
  await expect(page.getByTestId('generate-execute')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('prompt-fullscreen-button').click();
  const layer = page.getByTestId('prompt-fullscreen');
  await expect(layer).toBeVisible();
  await expect(page.getByTestId('prompt-fullscreen-placeholder')).toBeVisible();
  await expect(layer.getByRole('heading', { name: 'Dock' })).toBeVisible();

  await page.keyboard.type('A rainy dock, ');
  await page.keyboard.type('@');
  const firstOption = page.locator('[data-testid^="reference-mention-option-"]').first();
  await expect(firstOption).toBeVisible();
  // The first Escape closes the list and keeps full screen open.
  await page.keyboard.press('Escape');
  await expect(firstOption).toBeHidden();
  await expect(layer).toBeVisible();

  // A mouse pick in the list lands a chip in the full-screen prompt.
  await page.keyboard.press('Backspace');
  await page.keyboard.type('@');
  await expect(firstOption).toBeVisible();
  await firstOption.click();
  await expect(layer.locator('.reference-mention')).toHaveCount(1);
  await expect(layer).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(layer).toHaveCount(0);
  const panelPrompt = page.getByTestId('generate-prompt-editor');
  await expect(panelPrompt.locator('.reference-mention')).toHaveCount(1);
  await expect(panelPrompt).toContainText('A rainy dock,');
});
