// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Switching Space tabs hides the Space it leaves and shows it again as it was
 * (inner#1235). Every case here works in a real browser: what hiding does to
 * focus, to the canvas library's store and to an editor's caret is browser
 * behaviour, and jsdom has none of it.
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { expect, test, type Page } from 'playwright/test';

import { CANVAS_SPACE, TEXT_BODY, liveModuleUrl } from '../helpers/live-module';
import { visibleSpace } from '../helpers/space';
import {
  activeId,
  addSpaces,
  openFreshProject,
  projectIdOf,
  stripIds,
} from '../helpers/tab-restore';

/**
 * Writes a text node holding some words into a Space's document.
 * @param p - A page with the Space open.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param id - The node id.
 * @param words - What the node says.
 */
async function seedTextNode(
  p: Page,
  projectId: string,
  spaceId: string,
  id: string,
  words: string,
): Promise<void> {
  const canvasAt = await liveModuleUrl(p, CANVAS_SPACE);
  const bodyAt = await liveModuleUrl(p, TEXT_BODY);
  await p.evaluate(
    async ([pid, sid, nodeId, text, canvasUrl, bodyUrl]: string[]) => {
      const canvas = (await import(/* @vite-ignore */ canvasUrl!)) as {
        addNode: (p: string, s: string, n: unknown) => void;
        getTextBody: (p: string, s: string, id: string) => unknown;
      };
      canvas.addNode(pid!, sid!, {
        id: nodeId,
        type: 'text',
        position: { x: 0, y: 0 },
        data: {
          name: 'keep-alive',
          createdAt: Date.now(),
          createdBy: 'keep-alive',
          locked: false,
          attachments: [],
        },
      });
      const shared = (await import(/* @vite-ignore */ bodyUrl!)) as {
        writePlainTextIntoBody: (b: unknown, t: string) => void;
      };
      shared.writePlainTextIntoBody(canvas.getTextBody(pid!, sid!, nodeId!), text!);
    },
    [projectId, spaceId, id, words, canvasAt, bodyAt],
  );
}

/**
 * Shows a Space by its tab.
 * @param p - The page.
 * @param spaceId - The Space.
 */
async function showSpace(p: Page, spaceId: string): Promise<void> {
  await p.locator(`[data-testid="space-tab-${spaceId}"]`).click();
  await expect.poll(() => activeId(p)).toBe(spaceId);
}

test('a text node being written stays open with its caret and undo across a switch', async ({
  page,
}) => {
  // A13: the words are in the document either way; what a switch must not
  // take is the editor itself — the caret where the reader left it and the
  // undo that takes back what they just typed.
  const projectUrl = await openFreshProject(page);
  await addSpaces(page, 1);
  const [first, second] = (await stripIds(page)) as [string, string];
  await showSpace(page, first);
  await seedTextNode(page, projectIdOf(projectUrl), first, 'keep-alive-text', 'Seeded');
  const node = visibleSpace(page).locator('.react-flow__node[data-id="keep-alive-text"]');
  await expect(node).toBeVisible({ timeout: 20_000 });
  await node.dblclick();
  const body = node.locator('[data-testid="text-node-body"][contenteditable="true"]');
  await expect(body).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type(' words');
  await expect(body).toHaveText('Seeded words');

  await showSpace(page, second);
  await showSpace(page, first);

  await expect(body).toBeVisible();
  await expect(body).toBeFocused();
  await page.keyboard.type('!');
  await expect(body).toHaveText('Seeded words!');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(body).not.toHaveText('Seeded words!');
});
