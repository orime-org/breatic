// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One history row per content per node (#2186).
 *
 * The server holds each content once in a node's history, and the panel marks
 * as current the one row whose content the node shows. What only a browser
 * proves is the two together: keeping the same words twice, or uploading the
 * same bytes twice, leaves one row tagged current, every other row offers
 * Restore, and restoring moves the tag.
 *
 * Every action runs before the panel is first opened: an on-demand panel
 * reads a cached list for 30 seconds, so a second opening could show a list
 * from before the last action.
 *
 * Needs a running dev stack (`pnpm dev`):
 *
 *   pnpm --filter @breatic/web test:smoke:all
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { test, expect, type Page } from 'playwright/test';

import { CANVAS_SPACE, TEXT_BODY, liveModuleUrl } from '../helpers/live-module';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { createSpace, deleteSpace } from '../helpers/space';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let page: Page;
let projectId = '';
let spaceId = '';

test.use({ viewport: { width: 1680, height: 950 } });

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage();
  await openSmokeProject(page);
  projectId = smokeProjectId();
  spaceId = await createSpace(page, 'canvas', `history-unique-${Date.now()}`);
  await expect(page.locator('.react-flow')).toBeVisible({ timeout: 20_000 });
});

test.afterEach(async () => {
  if (spaceId !== '') await deleteSpace(page, spaceId);
  await page?.close();
  spaceId = '';
});

/**
 * Replace a text node's words, creating the node first when it is new.
 * @param nodeId - The node.
 * @param words - What its body should hold.
 * @param create - Whether to add the node before writing.
 * @returns Nothing; resolves once the node shows the words.
 */
async function writeWords(nodeId: string, words: string, create: boolean): Promise<void> {
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  const bodyAt = await liveModuleUrl(page, TEXT_BODY);
  await page.evaluate(
    async ([pid, sid, id, text, isNew, canvasUrl, bodyUrl]) => {
      const canvas = (await import(/* @vite-ignore */ canvasUrl)) as {
        addNode: (p: string, s: string, n: unknown) => void;
        getTextBody: (p: string, s: string, id: string) => unknown;
      };
      const shared = (await import(/* @vite-ignore */ bodyUrl)) as {
        writePlainTextIntoBody: (b: unknown, t: string) => void;
      };
      if (isNew) {
        canvas.addNode(pid, sid, {
          id, type: 'text', position: { x: 0, y: 0 },
          data: { name: 'text-e2e', createdAt: Date.now(), createdBy: 'history-e2e',
            locked: false, attachments: [] },
        });
      }
      shared.writePlainTextIntoBody(canvas.getTextBody(pid, sid, id), text);
    },
    [projectId, spaceId, nodeId, words, create, canvasAt, bodyAt] as const,
  );
  await expect(page.locator(`.react-flow__node[data-id="${nodeId}"]`)).toContainText(words, {
    timeout: 10_000,
  });
}

/**
 * Pick one item off a node's context menu.
 * @param nodeId - The node to right-click.
 * @param item - The menu item's test id.
 * @returns Nothing; resolves once the item was clicked.
 */
async function pickFromMenu(nodeId: string, item: string): Promise<void> {
  await page.locator(`.react-flow__node[data-id="${nodeId}"]`).click({ button: 'right' });
  await page.getByTestId(item).click();
}

/**
 * Keep a text node's words and wait for the server to answer.
 * @param nodeId - The node.
 * @returns Nothing; resolves once the snapshot request returned 2xx.
 */
async function keepSnapshot(nodeId: string): Promise<void> {
  const answered = page.waitForResponse(
    (r) => r.url().includes('/canvas/node-history/snapshot') && r.request().method() === 'POST',
  );
  await pickFromMenu(nodeId, 'node-menu-snapshot');
  expect((await answered).ok()).toBe(true);
}

/**
 * Upload bytes onto an existing node through its Upload menu item.
 * @param nodeId - The node.
 * @param bytes - The file's bytes.
 * @returns Nothing; resolves once the node shows an image from storage.
 */
async function uploadOnto(nodeId: string, bytes: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await pickFromMenu(nodeId, 'node-menu-upload');
  await (await chooser).setFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: bytes });
}

/** The image node's `src`, or empty while it has none. */
async function imageSrc(nodeId: string): Promise<string> {
  return page
    .locator(`.react-flow__node[data-id="${nodeId}"] img`)
    .first()
    .getAttribute('src', { timeout: 1_000 })
    .catch(() => '')
    .then((src) => src ?? '');
}

test('keeping the same words twice leaves one row, and Restore moves Current @needs-storage', async () => {
  const nodeId = randomUUID();
  await writeWords(nodeId, 'First words.', true);
  await keepSnapshot(nodeId);
  await keepSnapshot(nodeId);
  await writeWords(nodeId, 'Second words.', false);
  await keepSnapshot(nodeId);

  await pickFromMenu(nodeId, 'node-menu-history');
  const rows = page.getByTestId('node-history-row');
  // A snapshot row shows no words, so rows are told apart by order: newest
  // first, and the second keep of the same words added none.
  await expect(rows).toHaveCount(2, { timeout: 20_000 });
  const second = rows.nth(0);
  const first = rows.nth(1);
  await expect(second).toContainText('Current');
  await expect(second.getByTestId('node-history-restore')).toHaveCount(0);

  await first.getByTestId('node-history-restore').click();
  await expect(page.locator(`.react-flow__node[data-id="${nodeId}"]`)).toContainText('First words.');
  await expect(first).toContainText('Current');
  await expect(first.getByTestId('node-history-restore')).toHaveCount(0);
  await expect(second.getByTestId('node-history-restore')).toBeVisible();
});

test('uploading the same bytes twice leaves one row, and Restore moves Current @needs-ingest @needs-storage', async () => {
  // Fresh bytes per run: a fixed payload would already sit in the studio's
  // assets from an earlier run, which is fine for dedup but hides the first
  // upload's own row behind a past one.
  const same = Buffer.concat([TINY_PNG, randomBytes(16)]);
  const other = Buffer.concat([TINY_PNG, randomBytes(16)]);

  const nodeId = randomUUID();
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  await page.evaluate(
    async ([pid, sid, id, canvasUrl]) => {
      const canvas = (await import(/* @vite-ignore */ canvasUrl)) as {
        addNode: (p: string, s: string, n: unknown) => void;
      };
      canvas.addNode(pid, sid, {
        id, type: 'image', position: { x: 0, y: 0 },
        data: { name: 'image-e2e', createdAt: Date.now(), createdBy: 'history-e2e',
          locked: false, attachments: [] },
      });
    },
    [projectId, spaceId, nodeId, canvasAt] as const,
  );
  await expect(page.locator(`.react-flow__node[data-id="${nodeId}"]`)).toBeVisible();

  await uploadOnto(nodeId, same);
  await expect.poll(() => imageSrc(nodeId), { timeout: 30_000 }).toMatch(/^https?:\/\//);
  const sameUrl = await imageSrc(nodeId);

  await uploadOnto(nodeId, other);
  await expect.poll(() => imageSrc(nodeId), { timeout: 30_000 }).not.toBe(sameUrl);
  const otherUrl = await imageSrc(nodeId);

  await uploadOnto(nodeId, same);
  await expect.poll(() => imageSrc(nodeId), { timeout: 30_000 }).toBe(sameUrl);

  await pickFromMenu(nodeId, 'node-menu-history');
  const rows = page.getByTestId('node-history-row');
  await expect(rows).toHaveCount(2, { timeout: 20_000 });
  const current = rows.filter({ hasText: 'Current' });
  await expect(current).toHaveCount(1);
  const restorable = rows.filter({ has: page.getByTestId('node-history-restore') });
  await expect(restorable).toHaveCount(1);

  await restorable.getByTestId('node-history-restore').click();
  await expect.poll(() => imageSrc(nodeId), { timeout: 10_000 }).toBe(otherUrl);
  await expect(rows.filter({ hasText: 'Current' })).toHaveCount(1);
  await expect(rows.filter({ has: page.getByTestId('node-history-restore') })).toHaveCount(1);
});
