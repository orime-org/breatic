// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every option in the model picker draws its vendor's mark (#2156).
 *
 * The unit test walks the catalog yaml; this one reads the picker the reader
 * opens, on each of the three generation panels, through the catalog a
 * running server serves.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

// The panel hangs below its node; the picker opens below the panel.
test.use({ viewport: { width: 1440, height: 1080 } });

let page: Page;
let projectId = '';
let spaceId = '';

/**
 * Write one empty node into the open Space's document.
 * @param p - A page with the Space open.
 * @param nodeId - The id to give the node.
 * @param kind - The node type to write.
 * @returns Nothing.
 */
async function seedNode(p: Page, nodeId: string, kind: 'image' | 'video' | 'audio'): Promise<void> {
  await expect(visibleSpace(p).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const canvasAt = await liveModuleUrl(p, CANVAS_SPACE);
  const seen = await p.evaluate(
    async ([pid, sid, id, type, at]: [string, string, string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ at)) as {
        addNode: (p: string, s: string, n: unknown) => void;
        readCanvasGraph: (p: string, s: string) => { nodes: { id: string }[] };
      };
      canvas.addNode(pid, sid, {
        id,
        type,
        position: { x: 0, y: 0 },
        data: { name: `${type}-marks`, createdAt: Date.now(), createdBy: 'marks-e2e', locked: false, state: 'idle', attachments: [] },
      });
      return canvas.readCanvasGraph(pid, sid).nodes.map((n) => n.id);
    },
    [projectId, spaceId, nodeId, kind, canvasAt] as [string, string, string, string, string],
  );
  if (!seen.includes(nodeId)) throw new Error(`${nodeId} never reached the document`);
}

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ storageState: STATE_FILE.A });
  await openSmokeProject(page);
  projectId = (/([0-9a-f-]{36})$/.exec(page.url()) ?? [])[1] ?? '';
  if (!projectId) throw new Error(`no project id in ${page.url()}`);
  spaceId = await createSpace(page, 'canvas', `marks-e2e-${Date.now()}`);
});

test.afterEach(async () => {
  await deleteSpace(page, spaceId);
  await page.close();
});

for (const [kind, execute] of [
  ['image', 'generate-execute'],
  ['video', 'generate-video-execute'],
  ['audio', 'generate-audio-execute'],
] as const) {
  test(`draws a mark on every model the ${kind} picker offers`, async () => {
    const nodeId = crypto.randomUUID();
    await seedNode(page, nodeId, kind);
    const node = visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`);
    await expect(node).toBeVisible({ timeout: 15_000 });
    await node.click({ button: 'right' });
    await page.getByTestId('node-menu-generate').click();
    await expect(page.getByTestId(execute)).toBeVisible({ timeout: 15_000 });

    const trigger = page.getByTestId('generate-model-trigger');
    await expect(trigger.locator('svg[data-testid^="model-icon-"]')).toBeVisible();
    await trigger.click();
    const options = page.locator('[data-testid^="generate-model-option-"]');
    await expect(options.first()).toBeVisible();
    const unmarked = await options.evaluateAll((rows) =>
      rows
        .filter((row) => row.querySelector('svg[data-testid^="model-icon-"]') === null)
        .map((row) => row.getAttribute('data-testid')),
    );
    expect(await options.count()).toBeGreaterThan(0);
    expect(unmarked).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`${kind}-picker.png`) });
  });
}
