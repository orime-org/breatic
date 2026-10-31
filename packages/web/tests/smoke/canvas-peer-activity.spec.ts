// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Who is doing what on an empty node, seen from another connection
 * (inner#1303 §6.8, A14).
 *
 * The unit tests drive each side alone: a mark going into awareness, and a
 * table coming out of it onto a node. This file joins them through a live
 * collab server: one tab starts an operation on an empty node, the other reads
 * "{name} is uploading" off that node, and the line goes when the operation
 * ends or the first tab leaves.
 *
 * Two tabs of one account, as in `canvas-awareness.spec.ts`: the line keys on
 * the connection, and the roster names the account the same way in both.
 *
 * The operation is started through the page's own marks store rather than a
 * real upload: a real one answers in well under a second on a dev stack, and
 * the entry points that start a mark are pinned by their unit tests.
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { expect, type BrowserContext, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { smokeProjectId } from '../helpers/project';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { openTool, seedNode, zoomBy } from '../helpers/mini-tool';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

/** The marks store, as the page loaded it. */
const UPLOAD_MARKS = 'stores/upload-marks.ts';

const SETTLE_MS = 4_000;

/** Yjs drops a silent peer's awareness after 30 s; a closed tab may wait that long. */
const PEER_TIMEOUT_MS = 35_000;

let context: BrowserContext;
let starter: Page;
let viewer: Page;
let projectId = '';
let spaceId = '';
let nodeId = '';

/**
 * Write one empty image node into the open Space's document.
 * @param page - A page with the Space open.
 */
async function seedEmptyImageNode(page: Page): Promise<void> {
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  await page.evaluate(
    async ([pid, sid, id, at]: [string, string, string, string]) => {
      const canvas = await import(/* @vite-ignore */ at);
      canvas.addNode(pid, sid, {
        id,
        type: 'image',
        position: { x: 120, y: 120 },
        data: {
          name: 'peer-activity-e2e',
          createdAt: Date.now(),
          createdBy: 'peer-activity-e2e',
          locked: false,
          state: 'idle',
          attachments: [],
        },
      });
    },
    [projectId, spaceId, nodeId, canvasAt] as [string, string, string, string],
  );
}

/**
 * Start an operation on the node from the starter's tab.
 * @param action - What it does: `upload`, `readText` or a tool id.
 * @returns The operation's id.
 */
async function begin(action: string): Promise<string> {
  const at = await liveModuleUrl(starter, UPLOAD_MARKS);
  return starter.evaluate(
    async ([url, sid, id, act]: [string, string, string, string]) => {
      const marks = await import(/* @vite-ignore */ url);
      return marks.useUploadMarksStore.getState().begin(sid, id, act) as string;
    },
    [at, spaceId, nodeId, action] as [string, string, string, string],
  );
}

/**
 * End an operation from the starter's tab.
 * @param op - The operation's id.
 * @param how - Answered by the server, or failed before that.
 */
async function end(op: string, how: 'answer' | 'fail'): Promise<void> {
  const at = await liveModuleUrl(starter, UPLOAD_MARKS);
  await starter.evaluate(
    async ([url, sid, id, o, h]: [string, string, string, string, string]) => {
      const marks = (await import(/* @vite-ignore */ url)).useUploadMarksStore.getState();
      if (h === 'answer') marks.answer(sid, id, o);
      else marks.fail(sid, id, o, { key: 'canvas.upload.failed' });
    },
    [at, spaceId, nodeId, op, how] as [string, string, string, string, string],
  );
}

/**
 * The placeholder of the node on a page.
 * @param page - Either tab.
 * @returns Its locator.
 */
function placeholderOn(page: Page): ReturnType<Page['locator']> {
  return visibleSpace(page).locator(`[data-id="${nodeId}"] [data-testid=node-placeholder]`);
}

test.beforeEach(async ({ browser }) => {
  context = await browser.newContext({ viewport: { width: 1680, height: 950 } });
  // The canvas loads more modules than the default 250 resource entries hold,
  // and the marks store comes late enough to be dropped from the list
  // `liveModuleUrl` reads.
  await context.addInitScript(() => performance.setResourceTimingBufferSize(10_000));
  starter = await context.newPage();
  projectId = smokeProjectId();
  await starter.goto(`/project/${projectId}`);
  spaceId = await createSpace(starter, 'canvas', `peer-activity-e2e-${Date.now()}`);
  await expect(visibleSpace(starter).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  nodeId = `peer-activity-e2e-node-${Date.now()}`;
  await seedEmptyImageNode(starter);
  await expect(placeholderOn(starter)).toBeVisible({ timeout: 20_000 });

  viewer = await context.newPage();
  await viewer.goto(`/project/${projectId}`);
  const tab = viewer.getByTestId(`space-tab-name-${spaceId}`);
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click();
  await expect(placeholderOn(viewer)).toBeVisible({ timeout: 20_000 });
});

test.afterEach(async () => {
  // The leaving case closes the starter, so the Space goes through whichever
  // tab is still open.
  const open = starter !== undefined && !starter.isClosed() ? starter : viewer;
  if (spaceId !== '' && open !== undefined && !open.isClosed()) {
    await deleteSpace(open, spaceId);
  }
  await context?.close();
});

test('the other tab says who is uploading, and the line goes on the answer', async () => {
  const op = await begin('upload');

  // The starter sees its own skeleton, never its own line.
  await expect(placeholderOn(starter).getByTestId('node-upload-skeleton')).toBeVisible({
    timeout: SETTLE_MS,
  });
  await expect(placeholderOn(starter).getByTestId('node-peer-activity')).toHaveCount(0);

  const line = placeholderOn(viewer).getByTestId('node-peer-activity');
  await expect(line).toBeVisible({ timeout: SETTLE_MS });
  await expect(line).not.toHaveText('', { timeout: SETTLE_MS });
  await expect(placeholderOn(viewer).getByTestId('node-upload-skeleton')).toHaveCount(0);

  await end(op, 'answer');
  await expect(line).toHaveCount(0, { timeout: SETTLE_MS });
});

test('the line goes when the operation fails', async () => {
  const op = await begin('readText');
  const line = placeholderOn(viewer).getByTestId('node-peer-activity');
  await expect(line).toBeVisible({ timeout: SETTLE_MS });

  await end(op, 'fail');
  await expect(line).toHaveCount(0, { timeout: SETTLE_MS });
});

test('the line names the tool someone runs', async () => {
  await begin('image.grid');
  const line = placeholderOn(viewer).getByTestId('node-peer-activity');
  await expect(line).toBeVisible({ timeout: SETTLE_MS });
  // The tool's own name, in whatever language the account reads.
  await expect(line).toHaveText(/Grid split|宫格切图|宮格切圖|グリッド分割|격자 분할/);
});

test('the line goes when the starting tab leaves', async () => {
  await begin('upload');
  const line = placeholderOn(viewer).getByTestId('node-peer-activity');
  await expect(line).toBeVisible({ timeout: SETTLE_MS });

  await starter.close();
  await expect(line).toHaveCount(0, { timeout: PEER_TIMEOUT_MS });
});

// A14 through a real tool run: the press's operation runs on through its
// upload, so the other tab reads the tool, not an upload, until the tickets
// come back. The tickets are held so the wait is long enough to read.
test('the other tab names the tool a real grid run is waiting on @needs-internet', async () => {
  const source = crypto.randomUUID();
  // Close enough to the middle that the grid panel opening under it clears the
  // minimap in the bottom-right corner.
  await seedNode(starter, { projectId, spaceId }, source, 'image', 360, {
    content: `https://picsum.photos/seed/${crypto.randomUUID()}/400/300.jpg`,
    mimeType: 'image/jpeg',
    size: 40_000,
  });
  const shown = visibleSpace(starter).locator(`.react-flow__node[data-id="${source}"]`).getByTestId('image-node-img');
  await expect(shown).toBeVisible({ timeout: 20_000 });
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await starter.route('**/assets/upload-ticket*', async (route) => {
    await held;
    await route.continue();
  });
  await openTool(starter, source, 'image.grid');
  await starter.getByTestId('mini-tool-run').click();

  // The canvas draws only the nodes in view; zoom the other tab out until the
  // whole group is.
  await expect(visibleSpace(viewer).getByTestId('group-node')).toHaveCount(1, { timeout: SETTLE_MS * 2 });
  for (let i = 0; i < 3; i += 1) await zoomBy(viewer, 600);
  const lines = visibleSpace(viewer).getByTestId('node-peer-activity');
  await expect(lines).toHaveCount(9, { timeout: SETTLE_MS * 2 });
  await expect(lines.first()).toHaveText(/Grid split|宫格切图|宮格切圖|グリッド分割|격자 분할/);
  release();
  await starter.unroute('**/assets/upload-ticket*');
  await expect(lines).toHaveCount(0, { timeout: 30_000 });
});
