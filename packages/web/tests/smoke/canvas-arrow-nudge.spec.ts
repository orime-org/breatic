// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Arrow-key nudges reach the document (inner#1010).
 *
 * The unit tests pin what the canvas writes; this file checks what a person
 * sees: a node moved with the arrow keys moves on a second connection too,
 * stays where it was put after a reload, and comes back with one undo per
 * press, or one undo for a whole held key. Two pages in one context: the second tab is a peer of the first.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type BrowserContext, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { createSpace, deleteSpace } from '../helpers/space';

let context: BrowserContext;
let mover: Page;
let watcher: Page;
let projectId = '';
let spaceId = '';

/** A 1x1 PNG, inline so it decodes with no network. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

type Point = { x: number; y: number };

/**
 * Runs code against the canvas module the page already loaded.
 * @param page - A page with the Space open.
 * @param source - A function body given `canvas`, `pid`, `sid` and `extra`.
 * @param extra - One value handed to the body.
 * @returns What the body returns.
 */
async function onCanvas<T>(page: Page, source: string, extra: unknown): Promise<T> {
  const url = await liveModuleUrl(page, CANVAS_SPACE);
  return page.evaluate(
    async ([at, pid, sid, body, arg]: [string, string, string, string, unknown]) => {
      const canvas = await import(/* @vite-ignore */ at);
      const run = new Function('canvas', 'pid', 'sid', 'extra', body) as (
        c: unknown,
        p: string,
        s: string,
        e: unknown,
      ) => unknown;
      return run(canvas, pid, sid, arg) as unknown;
    },
    [url, projectId, spaceId, source, extra] as [string, string, string, string, unknown],
  ) as Promise<T>;
}

/**
 * Writes an image node, or a Group holding one, into the document.
 * @param page - A page with the Space open.
 * @param kind - Which to write.
 * @param id - The node id (the Group's, for a Group).
 * @param at - Its position.
 */
async function seed(
  page: Page,
  kind: 'image' | 'group',
  id: string,
  at: Point,
): Promise<void> {
  await onCanvas(
    page,
    `const base = { createdAt: Date.now(), createdBy: 'nudge-e2e', locked: false, attachments: [] };
     const image = (nid, x, y) => canvas.addNode(pid, sid, {
       id: nid, type: 'image', position: { x, y },
       data: { ...base, name: nid, content: extra.png },
     });
     if (extra.kind === 'image') { image(extra.id, extra.x, extra.y); return; }
     image(extra.id + '-m', extra.x + 24, extra.y + 24);
     canvas.createGroup(pid, sid, {
       id: extra.id, type: 'group', position: { x: extra.x, y: extra.y },
       data: { ...base, name: extra.id, width: 420, height: 320 },
     }, [{ id: extra.id + '-m', position: { x: 24, y: 24 } }]);`,
    { kind, id, x: at.x, y: at.y, png: PNG },
  );
}

/**
 * What the document holds for a node.
 * @param page - A page with the Space open.
 * @param id - The node id.
 * @returns Its position, parent and stored width, or null when absent.
 */
async function stored(
  page: Page,
  id: string,
): Promise<{ x: number; y: number; parentId: string | null; width: number | null } | null> {
  return onCanvas(
    page,
    `const n = canvas.readCanvasGraph(pid, sid).nodes.find((node) => node.id === extra);
     return n ? { x: n.position.x, y: n.position.y, parentId: n.parentId ?? null, width: n.data.width ?? null } : null;`,
    id,
  );
}

/**
 * Where a page draws a node on screen.
 * @param page - The page to read.
 * @param id - The node id.
 * @returns Its top-left, or null when not rendered.
 */
async function drawnAt(page: Page, id: string): Promise<Point | null> {
  const box = await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
  return box === null ? null : { x: box.x, y: box.y };
}

/**
 * Opens the run's Space in a page and waits for the canvas.
 * @param page - A signed-in page.
 */
async function openTheSpace(page: Page): Promise<void> {
  await page.goto(`/project/${projectId}`);
  const tab = page.getByTestId(`space-tab-name-${spaceId}`);
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click();
  await expect(page.locator('.react-flow')).toBeVisible({ timeout: 20_000 });
}

/**
 * Clicks a node near its top-left corner, which selects it and focuses it.
 * @param id - The node id.
 */
async function clickNode(id: string): Promise<void> {
  const at = await drawnAt(mover, id);
  if (at === null) throw new Error(`${id} is not drawn`);
  await mover.mouse.click(at.x + 10, at.y + 10);
}

test.setTimeout(240_000);

test.beforeEach(async ({ browser }) => {
  context = await browser.newContext({
    storageState: STATE_FILE.A,
    viewport: { width: 1680, height: 950 },
  });
  mover = await context.newPage();
  await openSmokeProject(mover);
  projectId = (/([0-9a-f-]{36})$/.exec(mover.url()) ?? [])[1] as string;
  spaceId = await createSpace(mover, 'canvas', `nudge-e2e-${Date.now()}`);
  await expect(mover.locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  watcher = await context.newPage();
  await openTheSpace(watcher);
});

test.afterEach(async () => {
  await watcher?.close();
  if (spaceId !== '' && mover !== undefined) await deleteSpace(mover, spaceId);
  await context?.close();
  spaceId = '';
});

test('a nudge reaches the other connection and survives a reload', async () => {
  const id = `n-${Date.now()}`;
  await seed(mover, 'image', id, { x: 200, y: 200 });
  await expect.poll(() => drawnAt(mover, id)).not.toBeNull();
  await clickNode(id);

  const seenBefore = await drawnAt(watcher, id);
  await mover.keyboard.press('ArrowRight');
  await expect.poll(() => stored(mover, id)).toMatchObject({ x: 205, y: 200 });
  await mover.keyboard.press('Shift+ArrowDown');
  await expect.poll(() => stored(mover, id)).toMatchObject({ x: 205, y: 220 });

  await expect
    .poll(async () => {
      const seen = await drawnAt(watcher, id);
      return seen === null || seenBefore === null
        ? null
        : seen.y - seenBefore.y > 0 && seen.x - seenBefore.x > 0;
    })
    .toBe(true);

  await watcher.reload();
  await openTheSpace(watcher);
  await expect.poll(() => stored(watcher, id)).toMatchObject({ x: 205, y: 220 });
});

test('each press is one undo step', async () => {
  const id = `u-${Date.now()}`;
  await seed(mover, 'image', id, { x: 200, y: 200 });
  await expect.poll(() => drawnAt(mover, id)).not.toBeNull();
  await clickNode(id);
  await mover.keyboard.press('ArrowRight');
  await expect.poll(() => stored(mover, id)).toMatchObject({ x: 205 });
  await mover.keyboard.press('ArrowRight');
  await expect.poll(() => stored(mover, id)).toMatchObject({ x: 210 });
  await mover.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => stored(mover, id)).toMatchObject({ x: 205 });
  await mover.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => stored(mover, id)).toMatchObject({ x: 200 });
});

test('a held arrow key is one undo step for the whole move', async () => {
  const id = `h-${Date.now()}`;
  await seed(mover, 'image', id, { x: 200, y: 200 });
  await expect.poll(() => drawnAt(mover, id)).not.toBeNull();
  await clickNode(id);
  // A second `down` on a key already held is sent with `repeat: true`.
  for (let i = 0; i < 4; i += 1) await mover.keyboard.down('ArrowRight');
  await mover.keyboard.up('ArrowRight');
  await expect.poll(() => stored(mover, id)).toMatchObject({ x: 220 });
  await mover.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => stored(mover, id)).toMatchObject({ x: 200, y: 200 });
});

test('a pointer press in the middle of a held key splits the undo steps', async () => {
  const id = `p-${Date.now()}`;
  await seed(mover, 'image', id, { x: 200, y: 200 });
  await expect.poll(() => drawnAt(mover, id)).not.toBeNull();
  await clickNode(id);
  for (let i = 0; i < 2; i += 1) await mover.keyboard.down('ArrowRight');
  await expect.poll(() => stored(mover, id)).toMatchObject({ x: 210 });
  await clickNode(id);
  for (let i = 0; i < 2; i += 1) await mover.keyboard.down('ArrowRight');
  await mover.keyboard.up('ArrowRight');
  await expect.poll(() => stored(mover, id)).toMatchObject({ x: 220 });
  await mover.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => stored(mover, id)).toMatchObject({ x: 210 });
});

test('a marquee selection moves together', async () => {
  const a = `a-${Date.now()}`;
  const b = `b-${Date.now()}`;
  await seed(mover, 'image', a, { x: 200, y: 200 });
  await seed(mover, 'image', b, { x: 260, y: 200 });
  await expect.poll(() => drawnAt(mover, b)).not.toBeNull();
  const first = (await drawnAt(mover, a)) as Point;
  const second = (await mover.locator(`.react-flow__node[data-id="${b}"]`).boundingBox())!;
  await mover.mouse.move(first.x - 30, first.y - 30);
  await mover.mouse.down();
  await mover.mouse.move(second.x + second.width + 30, second.y + second.height + 30, { steps: 10 });
  await mover.mouse.up();
  await expect(mover.locator('.react-flow__nodesselection-rect')).toBeVisible();
  await mover.keyboard.press('ArrowDown');
  await expect.poll(() => stored(mover, a)).toMatchObject({ x: 200, y: 205 });
  await expect.poll(() => stored(mover, b)).toMatchObject({ x: 260, y: 205 });
});

test('a nudged Group moves whole and keeps its size', async () => {
  const g = `g-${Date.now()}`;
  await seed(mover, 'group', g, { x: 200, y: 200 });
  await expect.poll(() => drawnAt(mover, g)).not.toBeNull();
  await clickNode(g);
  await mover.keyboard.press('ArrowRight');
  await expect.poll(() => stored(mover, g)).toMatchObject({ x: 205, y: 200, width: 420 });
  expect(await stored(mover, `${g}-m`)).toMatchObject({ x: 24, y: 24, parentId: g });
});

test('an arrow key during a drag leaves one undo step, for the drop', async () => {
  const id = `d-${Date.now()}`;
  await seed(mover, 'image', id, { x: 200, y: 200 });
  await expect.poll(() => drawnAt(mover, id)).not.toBeNull();
  const at = (await drawnAt(mover, id)) as Point;
  await mover.mouse.move(at.x + 10, at.y + 10);
  await mover.mouse.down();
  await mover.mouse.move(at.x + 60, at.y + 10, { steps: 6 });
  await mover.keyboard.press('ArrowDown');
  await mover.mouse.move(at.x + 110, at.y + 10, { steps: 6 });
  await mover.mouse.up();
  await expect.poll(async () => (await stored(mover, id))?.x).toBeGreaterThan(200);
  await mover.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => stored(mover, id)).toMatchObject({ x: 200, y: 200 });
});
