// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What one upload of several files becomes on the canvas (#2209).
 *
 * Several files arrive as one batch, so they leave as one: a Group the reader
 * grabs once. The three ways a batch gets in — the left menu's tool, a drag
 * onto the canvas, a paste — meet in the same `processFiles`, and each is
 * walked here because only a real canvas answers whether the members ended up
 * bound to the Group and whether the Group is what is selected.
 *
 * Needs a running dev stack (`pnpm dev`) and the smoke account setup.
 */
import { test, expect, type Page } from 'playwright/test';

import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { STATE_FILE, openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace } from '../helpers/space';

test.use({ storageState: STATE_FILE.A });

/** A 320x240 solid PNG, inline so it decodes with no network. */
const SOLID_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAADwCAIAAAD+Tyo8AAACD0lEQVR42u3TQQkAAAgEwUtnCJMY3w7+hIFJsLCpHuCpSAAGBgwMGBgMDBgYMDBgYDAwYGDAwGBgwMCAgQEDg4EBAwMGBgwMBgYMDBgYDAwYGDAwYGAwMGBgwMCAgcHAgIEBA4OBAQMDBgYMDAYGDAwYGAysAhgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMCAgcHAgIEBAwMGBgMDBgYMDAYGDAwYGDAwGBgwMGBgMDBgYMDAgIHBwICBAQMDBgYDAwYGDAwGBgwMGBgwMBgYMDBgYMDAYGDAwICBwcCAgQEDAwYGAwMGBgwMGBgMDBgYMDAYGDAwYGDAwGBgwMCAgcHAgIEBAwMGBgMDBgYMDBgYDAwYGDAwGBgwMGBgwMBgYMDAgIEBA4OBAQMDBgYDAwYGDAwYGAwMGBgwMBhYBTAwYGDAwGBgwMCAgQEDg4EBAwMGBgMDBgYMDBgYDAwYGDAwYGAwMGBgwMBgYMDAgIEBA4OBAQMDBgYMDAYGDAwYGAwMGBgwMGBgMDBgYMDAYGDAwICBAQODgQEDAwYGDAwGBgwMGBgMDBgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMCAgcHAgIEBA4OBAQMDBgYMDAYGDAwYGDAwGBgwMHC3pCIzOUa0Hy8AAAAASUVORK5CYII=';

/** What one picked file looks like to the input. */
function pngFile(index: number): {
  name: string;
  mimeType: string;
  buffer: Buffer;
} {
  return {
    name: `batch-${String(index)}.png`,
    mimeType: 'image/png',
    buffer: Buffer.from(SOLID_PNG, 'base64'),
  };
}

/** One node as the shared document has it. */
interface DocNode {
  id: string;
  parentId: string | null;
  type: string;
  /** Top-left; relative to the parent Group for a member, absolute otherwise. */
  position: { x: number; y: number };
  /** A Group's authoritative height; null for a node, which sizes itself. */
  height: number | null;
}

/**
 * Every node the document holds, which is what the collaborators get too.
 * Membership lives there, not on the rendered element.
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
        ) => {
          nodes: {
            id: string;
            parentId?: string;
            type: string;
            position: { x: number; y: number };
            data?: { height?: number };
          }[];
        };
      };
      return canvas.readCanvasGraph(pid, sid).nodes.map((n) => ({
        id: n.id,
        parentId: n.parentId ?? null,
        type: n.type,
        position: n.position,
        height: n.data?.height ?? null,
      }));
    },
    [projectId, spaceId, canvasUrl] as [string, string, string],
  );
}

/**
 * Which nodes the canvas shows as selected. Selection is this browser's own,
 * so it is read off the rendered elements rather than the document.
 * @param page - The page with the Space open.
 * @returns The selected node ids.
 */
async function selectedOnScreen(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.react-flow__node.selected')].map(
      (el) => (el as HTMLElement).dataset.id ?? '',
    ),
  );
}

/**
 * Hand a batch of files to the canvas the way a drag or a paste does: one
 * event carrying every file, aimed at the middle of the pane.
 * @param page - The page with the Space open.
 * @param how - Which entry to walk.
 * @param count - How many files the batch carries.
 */
async function handOverFiles(
  page: Page,
  how: 'drop' | 'paste',
  count: number,
): Promise<void> {
  await page.evaluate(
    async ([entry, total, encoded]: [string, number, string]) => {
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const transfer = new DataTransfer();
      for (let i = 0; i < total; i += 1) {
        transfer.items.add(
          new File([bytes], `batch-${String(i)}.png`, { type: 'image/png' }),
        );
      }
      const pane = document.querySelector('.react-flow__pane');
      if (pane === null) throw new Error('no canvas pane to hand files to');
      if (entry === 'paste') {
        // Aimed at the pane, not at `document`: the handler asks whether the
        // event's target sits in the canvas region before it reads the files.
        pane.dispatchEvent(
          new ClipboardEvent('paste', {
            clipboardData: transfer,
            bubbles: true,
            cancelable: true,
          }),
        );
        return;
      }
      const rect = pane.getBoundingClientRect();
      const at = {
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        bubbles: true,
        cancelable: true,
      };
      pane.dispatchEvent(
        new DragEvent('dragover', { ...at, dataTransfer: transfer }),
      );
      pane.dispatchEvent(
        new DragEvent('drop', { ...at, dataTransfer: transfer }),
      );
    },
    [how, count, SOLID_PNG] as [string, number, string],
  );
}

/**
 * Wait until the document holds `total` nodes, then read them.
 * @param page - The page with the Space open.
 * @param total - How many nodes the batch should have produced.
 * @returns Every node the document holds.
 */
async function settledNodes(page: Page, total: number): Promise<DocNode[]> {
  await expect
    .poll(async () => (await documentNodes(page)).length, { timeout: 30_000 })
    .toBe(total);
  return documentNodes(page);
}

/**
 * The one Group the batch produced, with every file bound to it.
 * @param page - The page with the Space open.
 * @param files - How many files the batch carried.
 * @returns The Group's id.
 */
async function theGroupOver(page: Page, files: number): Promise<string> {
  const nodes = await settledNodes(page, files + 1);
  const members = nodes.filter((n) => n.parentId !== null);
  expect(members).toHaveLength(files);
  const parents = new Set(members.map((n) => n.parentId));
  expect(parents.size).toBe(1);

  const groupId = [...parents][0] as string;
  expect(nodes.find((n) => n.id === groupId)?.type).toBe('group');
  return groupId;
}

let projectId = '';
let spaceId = '';

test.beforeEach(async ({ page }) => {
  await openSmokeProject(page);
  projectId = (/([0-9a-f-]{36})$/.exec(page.url()) ?? [])[1] as string;
  spaceId = await createSpace(page, 'canvas', `multi-upload ${Date.now()}`);
});

test.afterEach(async ({ page }) => {
  await deleteSpace(page, spaceId);
});

test('the upload tool turns one batch into one Group', async ({ page }) => {
  const files = 5;
  // Two inputs carry this id and only one takes a batch: the canvas has its
  // own single-file picker. The left menu's tool clicks the multiple one.
  await page
    .locator('input[data-testid="canvas-upload-input"][multiple]')
    .setInputFiles(Array.from({ length: files }, (_, i) => pngFile(i)));

  // The Group is what the reader grabs next, so it is what is selected — and
  // the only thing, or a right-click routes to the selection menu (#1477).
  const groupId = await theGroupOver(page, files);
  await expect
    .poll(async () => selectedOnScreen(page), { timeout: 15_000 })
    .toEqual([groupId]);
});

for (const entry of ['drop', 'paste'] as const) {
  test(`a ${entry} of several files turns into one Group`, async ({ page }) => {
    await handOverFiles(page, entry, 3);

    const groupId = await theGroupOver(page, 3);
    await expect
      .poll(async () => selectedOnScreen(page), { timeout: 15_000 })
      .toEqual([groupId]);
  });
}

test('the members keep the grid, and the Group takes them along', async ({
  page,
}) => {
  const files = 5;
  await page
    .locator('input[data-testid="canvas-upload-input"][multiple]')
    .setInputFiles(Array.from({ length: files }, (_, i) => pngFile(i)));
  const groupId = await theGroupOver(page, files);

  /**
   * Where the members sit inside the Group, read in reading order.
   * @returns One position per member, top row first.
   */
  const memberGrid = async (): Promise<{ x: number; y: number }[]> =>
    (await documentNodes(page))
      .filter((n) => n.parentId === groupId)
      .map((n) => n.position)
      .sort((a, b) => a.y - b.y || a.x - b.x);

  // 288x192 nodes stepped by 312 and 216, four across, inside 24 of padding.
  // Creating the Group rewrites every member's position, so this is where a
  // second answer to "where is node i" would show up as a jump.
  expect(await memberGrid()).toEqual([
    { x: 24, y: 24 },
    { x: 336, y: 24 },
    { x: 648, y: 24 },
    { x: 960, y: 24 },
    { x: 24, y: 240 },
  ]);

  const frame = await page
    .locator(`.react-flow__node[data-id="${groupId}"]`)
    .boundingBox();
  if (frame === null) throw new Error('the Group is not on screen');
  const before = (await documentNodes(page)).find((n) => n.id === groupId)
    ?.position;
  // Grabbed on the Group's own top strip, above every member — the way a
  // reader grabs the whole batch.
  await page.mouse.move(frame.x + 200, frame.y + 8);
  await page.mouse.down();
  for (let step = 1; step <= 6; step += 1) {
    await page.mouse.move(frame.x + 200 + step * 30, frame.y + 8 + step * 20);
  }
  await page.mouse.up();

  await expect
    .poll(
      async () =>
        (await documentNodes(page)).find((n) => n.id === groupId)?.position,
      { timeout: 15_000 },
    )
    .not.toEqual(before);
  // The whole batch went with it: nobody was left behind and nobody shifted
  // inside the frame.
  expect(await memberGrid()).toEqual([
    { x: 24, y: 24 },
    { x: 336, y: 24 },
    { x: 648, y: 24 },
    { x: 960, y: 24 },
    { x: 24, y: 240 },
  ]);
});

test('a second batch over a Group makes its own and joins nothing', async ({
  page,
}) => {
  await handOverFiles(page, 'drop', 2);
  const first = await theGroupOver(page, 2);

  // The same drop point, which is inside the Group the first batch made.
  await handOverFiles(page, 'drop', 2);

  const nodes = await settledNodes(page, 6);
  const groups = nodes.filter((n) => n.type === 'group');
  // Two batches, two Groups. Putting the second one into the first would
  // assert that those four files belong together, and nobody said that.
  expect(groups).toHaveLength(2);
  expect(groups.map((n) => n.id)).toContain(first);
  expect(nodes.filter((n) => n.parentId === first)).toHaveLength(2);
  expect(groups.every((n) => n.parentId === null)).toBe(true);

  // The two frames are drawn on top of each other, so both hold both sets of
  // members. A nudge inside its own frame must leave the second batch where it
  // is: taking whichever frame answered first empties the Group just made.
  const second = groups.map((n) => n.id).find((id) => id !== first) as string;
  const member = nodes.find((n) => n.parentId === second) as DocNode;
  const box = await page
    .locator(`.react-flow__node[data-id="${member.id}"]`)
    .boundingBox();
  if (box === null) throw new Error('the member is not on screen');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let step = 1; step <= 4; step += 1) {
    await page.mouse.move(box.x + box.width / 2 + step * 2, box.y + box.height / 2 + step);
  }
  await page.mouse.up();

  await expect
    .poll(
      async () =>
        (await documentNodes(page)).filter((n) => n.parentId === second).length,
      { timeout: 15_000 },
    )
    .toBe(2);
});

test('one undo takes the whole batch back', async ({ page }) => {
  await handOverFiles(page, 'drop', 3);
  await theGroupOver(page, 3);

  // One drop is one thing the reader did, so it is one thing to take back.
  // Aimed at the pane: the handler asks whether the event's target sits in
  // the canvas region before it reads the chord.
  await page.locator('.react-flow__pane').press('ControlOrMeta+z');

  await expect
    .poll(async () => (await documentNodes(page)).length, { timeout: 15_000 })
    .toBe(0);
});

test('one file stays one node, with no Group around it', async ({ page }) => {
  await page
    .locator('input[data-testid="canvas-upload-input"][multiple]')
    .setInputFiles([pngFile(0)]);

  const nodes = await settledNodes(page, 1);
  expect(nodes[0].parentId).toBeNull();
  // Nothing was wrapped, so the node itself is what the reader acts on.
  await expect
    .poll(async () => selectedOnScreen(page), { timeout: 15_000 })
    .toEqual([nodes[0].id]);
});
