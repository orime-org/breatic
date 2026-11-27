// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The selection plus (inner#2216), in a real browser.
 *
 * The unit tests pin which rows the menu offers, where the new node goes and
 * how the references are ordered; this file walks what a person does: marquee
 * or Cmd/Ctrl-click several nodes (or click a Group), press the plus, pick a
 * type, and read the wires and the new node's reference rail. It also measures
 * with `elementFromPoint` that the whole plus on a singly selected node presses
 * its handle at 100% and 50% zoom, while the node body just above it does not.
 *
 * Nothing here generates: the Generate panel is only opened to read its rail.
 *
 *   pnpm --filter @breatic/web test:smoke tests/smoke/selection-add-node.spec.ts
 */
import { devices, expect, type BrowserContext, type Locator, type Page } from 'playwright/test';
import { test, stateFile } from '../helpers/slot';

import { dataOf } from '../helpers/api';
import { openGenerate, registerCanvasStage, seedNode } from '../helpers/audio-panel';
import { credentialsFor } from '../helpers/credentials';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { cleanMembership, inviteMember } from '../helpers/project-members';
import { openSpaceById, visibleSpace } from '../helpers/space';

registerCanvasStage();

/**
 * The browser's user agent for this file. The suite runs as Desktop Chrome,
 * whose agent says Windows, so xyflow takes Control as the multi-selection key;
 * on a Mac host a Control click is a right click and opens the node menu
 * instead. There the page is told the truth, and Cmd clicks as on a Mac.
 */
const USER_AGENT = process.platform === 'darwin'
  ? devices['Desktop Chrome'].userAgent.replace(/\(Windows[^)]*\)/, '(Macintosh; Intel Mac OS X 10_15_7)')
  : devices['Desktop Chrome'].userAgent;
test.use({ userAgent: USER_AGENT });

type Point = { x: number; y: number };


interface Graph {
  nodes: Array<{ id: string; type: string; parentId: string | null; x: number; y: number }>;
  edges: Array<{ id: string; source: string; target: string }>;
}

/**
 * The Project and Space the page shows.
 * @param page - A page with a canvas Space open.
 * @returns Their ids.
 * @throws {Error} When either cannot be read.
 */
async function idsOf(page: Page): Promise<{ projectId: string; spaceId: string }> {
  const projectId = (/([0-9a-f-]{36})$/.exec(page.url()) ?? [])[1] ?? '';
  const spaceId = (await visibleSpace(page).getAttribute('data-space-outlet')) ?? '';
  if (!projectId || !spaceId) throw new Error(`no ids on ${page.url()}`);
  return { projectId, spaceId };
}

/**
 * Runs a function body against the canvas module the page already loaded.
 * @param page - A page with the Space open.
 * @param body - A function body given `canvas`, `pid`, `sid` and `extra`.
 * @param extra - One value handed to the body.
 * @returns What the body returns.
 */
async function onCanvas<T>(page: Page, body: string, extra: unknown = null): Promise<T> {
  const { projectId, spaceId } = await idsOf(page);
  const url = await liveModuleUrl(page, CANVAS_SPACE);
  return page.evaluate(
    async ([at, pid, sid, source, arg]: [string, string, string, string, unknown]) => {
      const canvas = await import(/* @vite-ignore */ at);
      const run = new Function('canvas', 'pid', 'sid', 'extra', source) as (
        c: unknown, p: string, s: string, e: unknown,
      ) => unknown;
      return run(canvas, pid, sid, arg) as unknown;
    },
    [url, projectId, spaceId, body, extra] as [string, string, string, string, unknown],
  ) as Promise<T>;
}

/**
 * What the Space's document holds.
 * @param page - A page with the Space open.
 * @returns Its nodes and edges.
 */
async function graph(page: Page): Promise<Graph> {
  return onCanvas<Graph>(
    page,
    `const g = canvas.readCanvasGraph(pid, sid);
     return {
       nodes: g.nodes.map((n) => ({ id: n.id, type: n.type, parentId: n.parentId ?? null, x: n.position.x, y: n.position.y })),
       edges: g.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
     };`,
  );
}

/**
 * A node as drawn in the Space on screen.
 * @param page - The page.
 * @param id - The node id.
 * @returns Its locator.
 */
function nodeOf(page: Page, id: string): Locator {
  return visibleSpace(page).locator(`.react-flow__node[data-id="${id}"]`);
}

/**
 * Frames everything on the canvas, as a person does after adding nodes.
 * @param page - The page.
 */
async function fit(page: Page): Promise<void> {
  await page.getByTestId('viewport-toolbar').getByRole('button', { name: 'Fit to viewport', exact: true }).click();
  await page.waitForTimeout(600);
}

/**
 * Sets the zoom from the viewport toolbar's preset list and waits for it.
 * @param page - The page.
 * @param percent - The preset, such as 50 or 100.
 */
async function zoomTo(page: Page, percent: number): Promise<void> {
  await page.getByTestId('zoom-readout-trigger').click();
  await page.getByTestId(`zoom-preset-${String(percent)}`).click();
  await expect
    .poll(() => visibleSpace(page).locator('.react-flow__viewport').evaluate(
      (el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a,
    ))
    .toBeCloseTo(percent / 100, 3);
  await page.waitForTimeout(400);
}

/**
 * A point on the empty canvas: the pane itself is what it hits.
 * @param page - The page.
 * @returns The point.
 * @throws {Error} When no empty point is found.
 */
async function emptyPoint(page: Page): Promise<Point> {
  const pane = await visibleSpace(page).locator('.react-flow__pane').boundingBox();
  if (pane === null) throw new Error('no canvas pane');
  const tries: Point[] = [];
  for (const fx of [0.5, 0.25, 0.75, 0.1, 0.9]) {
    for (const fy of [0.85, 0.15, 0.7, 0.3]) tries.push({ x: pane.x + pane.width * fx, y: pane.y + pane.height * fy });
  }
  const hit = await page.evaluate((points) => points.find((p) => {
    const el = document.elementFromPoint(p.x, p.y);
    return el !== null && el.classList.contains('react-flow__pane');
  }) ?? null, tries);
  if (hit === null) throw new Error('no empty point on the canvas');
  return hit;
}

/**
 * Clicks a node near its top-left corner, optionally adding it to the selection.
 * @param page - The page.
 * @param id - The node id.
 * @param add - Whether to hold Cmd/Ctrl.
 * @param at - Where on the node, from its top-left corner.
 * @throws {Error} When the node is not drawn.
 */
async function clickNode(page: Page, id: string, add = false, at: Point = { x: 12, y: 12 }): Promise<void> {
  const box = await nodeOf(page, id).boundingBox();
  if (box === null) throw new Error(`${id} is not drawn`);
  // Held down rather than passed as a click option: xyflow reads the
  // multi-selection key from its own keydown listener.
  // xyflow picks the key from the page's user agent (Meta on a Mac, Control
  // elsewhere), and this suite's browser reports the Desktop Chrome one.
  const key = await page.evaluate(() => (navigator.userAgent.includes('Mac') ? 'Meta' : 'Control'));
  if (add) await page.keyboard.down(key);
  await page.mouse.click(box.x + at.x, box.y + at.y);
  if (add) await page.keyboard.up(key);
}

/**
 * The ids of the nodes drawn as selected.
 * @param page - The page.
 * @returns The selected ids, sorted.
 */
async function selectedIds(page: Page): Promise<string[]> {
  const ids = await visibleSpace(page).locator('.react-flow__node.selected').evaluateAll(
    (els) => els.map((el) => el.getAttribute('data-id') ?? ''),
  );
  return ids.sort();
}

/**
 * The refIds the open Generate panel's reference rail lists, in order.
 * @param page - The page.
 * @returns The refIds.
 */
async function railRefs(page: Page): Promise<string[]> {
  return page.getByTestId('generate-reference-rail').locator(':scope > [role="listitem"]').evaluateAll(
    (els) => els.map((el) => (el.getAttribute('data-testid') ?? '').replace(/^generate-ref-/, '')),
  );
}

/**
 * Waits for exactly one node the page did not have before.
 * @param page - The page.
 * @param before - The ids that were there.
 * @returns The new node.
 */
async function newNode(page: Page, before: readonly string[]): Promise<Graph['nodes'][number]> {
  let found: Graph['nodes'] = [];
  await expect.poll(async () => {
    found = (await graph(page)).nodes.filter((n) => !before.includes(n.id));
    return found.length;
  }, { timeout: 10_000 }).toBe(1);
  return found[0]!;
}

test('a marquee over a picture, a video and an audio node: the plus builds a picture wired only from the picture, and one undo removes it', async ({ page }) => {
  const image = crypto.randomUUID();
  const video = crypto.randomUUID();
  const audio = crypto.randomUUID();
  await seedNode(image, 'image', undefined, 0, 0);
  await seedNode(video, 'video', undefined, 320, 40);
  await seedNode(audio, 'audio', undefined, 640, 0);
  await fit(page);
  await zoomTo(page, 50);

  const boxes = await Promise.all([image, video, audio].map(async (id) => (await nodeOf(page, id).boundingBox())!));
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  await page.mouse.move(left - 30, top - 30);
  await page.mouse.down();
  await page.mouse.move(right + 30, bottom + 30, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => selectedIds(page)).toEqual([image, video, audio].sort());

  const plus = visibleSpace(page).getByTestId('selection-add-button');
  await expect(plus).toBeVisible();
  const plusBox = (await plus.boundingBox())!;
  expect(plusBox.x, 'the plus sits right of the selection').toBeGreaterThan(right);
  expect(plusBox.y + plusBox.height / 2).toBeGreaterThan(top);
  expect(plusBox.y + plusBox.height / 2).toBeLessThan(bottom);

  await plus.click();
  for (const type of ['text', 'image', 'audio', 'video']) {
    const row = page.getByTestId(`create-node-${type}`);
    await expect(row).toBeVisible();
    await expect(row, `${type} is offered`).not.toHaveAttribute('data-disabled');
  }
  await expect(page.getByTestId('selection-add-to-agent')).toBeVisible();
  await expect(visibleSpace(page).getByTestId('selection-add-preview').locator('path')).toHaveCount(3);

  const before = (await graph(page)).nodes.map((n) => n.id);
  await page.getByTestId('create-node-image').click();
  const made = await newNode(page, before);
  expect(made.type).toBe('image');
  expect(made.x, 'built right of the selection').toBeGreaterThan(640 + 288);
  await expect(nodeOf(page, made.id)).toBeVisible();
  await expect.poll(() => selectedIds(page)).toEqual([made.id]);
  await expect(visibleSpace(page).getByTestId('selection-add-preview')).toHaveCount(0);
  const into = (await graph(page)).edges.filter((e) => e.target === made.id);
  expect(into.map((e) => e.source)).toEqual([image]);

  // The new node, now the only selection, takes a press itself: nothing of
  // the marquee is left lying over it.
  const madeBox = (await nodeOf(page, made.id).boundingBox())!;
  const onMade = await page.evaluate((p) => {
    const el = document.elementFromPoint(p.x, p.y);
    return el?.closest('.react-flow__node')?.getAttribute('data-id') ?? el?.className ?? null;
  }, { x: madeBox.x + madeBox.width / 2, y: madeBox.y + madeBox.height / 2 });
  expect.soft(onMade, 'a press on the new node reaches the new node').toBe(made.id);
  // Select it the way a person gets past a leftover marquee, so the rail and
  // the undo below are still checked.
  const clear = await emptyPoint(page);
  await page.mouse.click(clear.x, clear.y);
  await clickNode(page, made.id);

  await openGenerate(made.id, 'generate-execute');
  await expect.poll(() => railRefs(page)).toEqual([into[0]!.id]);

  // Close the panel on the empty canvas, then undo from the canvas.
  const empty = await emptyPoint(page);
  await page.mouse.click(empty.x, empty.y);
  await expect(page.getByTestId('generate-execute')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => {
    const g = await graph(page);
    return {
      node: g.nodes.some((n) => n.id === made.id),
      edges: g.edges.filter((e) => e.target === made.id).length,
      kept: [image, video, audio].every((id) => g.nodes.some((n) => n.id === id)),
    };
  }).toEqual({ node: false, edges: 0, kept: true });
  await expect(nodeOf(page, made.id)).toHaveCount(0);
});

test('two audio nodes picked with Cmd/Ctrl: the picture row is greyed out and builds nothing', async ({ page }) => {
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  await seedNode(first, 'audio', undefined, 0, 0);
  await seedNode(second, 'audio', undefined, 360, 0);
  await fit(page);
  await zoomTo(page, 50);

  await clickNode(page, first);
  await clickNode(page, second, true);
  await expect.poll(() => selectedIds(page)).toEqual([first, second].sort());

  const plus = visibleSpace(page).getByTestId('selection-add-button');
  await expect(plus).toBeVisible();
  await plus.click();
  const imageRow = page.getByTestId('create-node-image');
  await expect(imageRow).toHaveAttribute('data-disabled', '');
  await expect(page.getByTestId('create-node-video'), 'a row audio connects into stays open').not.toHaveAttribute('data-disabled');

  await imageRow.click({ force: true });
  await page.waitForTimeout(800);
  const g = await graph(page);
  expect(g.nodes.map((n) => n.id).sort()).toEqual([first, second].sort());
  expect(g.edges).toEqual([]);

  await page.keyboard.press('Escape');
  await expect(imageRow).toHaveCount(0);
});

test('a selected Group: the plus builds a video outside it, wired from all three members, referenced top to bottom then left to right', async ({ page }) => {
  const group = crypto.randomUUID();
  // Seeded out of order so the rail's order can only come from the positions:
  // `low` sits under the other two, which share a row.
  const low = crypto.randomUUID();
  const right = crypto.randomUUID();
  const left = crypto.randomUUID();
  const at = { x: 0, y: 0 };
  const members = [
    { id: low, position: { x: 24, y: 260 } },
    { id: right, position: { x: 340, y: 24 } },
    { id: left, position: { x: 24, y: 24 } },
  ];
  await onCanvas(
    page,
    `const base = { createdAt: Date.now(), createdBy: 'selection-add-e2e', locked: false, state: 'idle', attachments: [] };
     for (const m of extra.members) {
       canvas.addNode(pid, sid, {
         id: m.id, type: 'image', position: { x: extra.at.x + m.position.x, y: extra.at.y + m.position.y },
         data: { ...base, name: 'member' },
       });
     }
     canvas.createGroup(pid, sid, {
       id: extra.group, type: 'group', position: extra.at,
       data: { ...base, name: 'group', width: 652, height: 476 },
     }, extra.members);`,
    { group, members, at },
  );
  await expect(nodeOf(page, left)).toBeVisible({ timeout: 15_000 });
  await fit(page);
  await zoomTo(page, 50);

  // Pressed on the frame's empty lower-right quarter, clear of every member.
  const groupBox = (await nodeOf(page, group).boundingBox())!;
  await clickNode(page, group, false, { x: groupBox.width * 0.75, y: groupBox.height * 0.75 });
  await expect.poll(() => selectedIds(page)).toEqual([group]);
  const plus = visibleSpace(page).getByTestId('selection-add-button');
  await expect(plus).toBeVisible();
  const plusBox = (await plus.boundingBox())!;
  expect(plusBox.x, 'the plus sits right of the Group').toBeGreaterThan(groupBox.x + groupBox.width);

  await plus.click();
  await expect(visibleSpace(page).getByTestId('selection-add-preview').locator('path')).toHaveCount(3);
  const before = (await graph(page)).nodes.map((n) => n.id);
  await page.getByTestId('create-node-video').click();
  const made = await newNode(page, before);
  expect(made.type).toBe('video');
  expect(made.parentId, 'the new node does not join the Group').toBeNull();
  expect(made.x, 'it sits right of the Group frame').toBeGreaterThanOrEqual(at.x + 652);

  const into = (await graph(page)).edges.filter((e) => e.target === made.id);
  expect(into.map((e) => e.source).sort()).toEqual([low, right, left].sort());
  await openGenerate(made.id, 'generate-video-execute');
  await expect.poll(() => railRefs(page)).toEqual([left, right, low].map((id) => `${id}->${made.id}`));
});

test('a singly selected node shows a plus on both handles that presses its handle at 100% and 50% zoom, and takes a wire', async ({ page }) => {
  const other = crypto.randomUUID();
  const chosen = crypto.randomUUID();
  await seedNode(other, 'image', undefined, 0, 0);
  await seedNode(chosen, 'image', undefined, 520, 0);
  await fit(page);
  await zoomTo(page, 100);

  await clickNode(page, chosen);
  await expect.poll(() => selectedIds(page)).toEqual([chosen]);
  await expect(nodeOf(page, chosen).getByTestId('handle-dot').getByTestId('handle-plus')).toHaveCount(2);
  await expect(nodeOf(page, other).getByTestId('handle-plus')).toHaveCount(0);

  await clickNode(page, other, true);
  await expect.poll(() => selectedIds(page)).toEqual([other, chosen].sort());
  await expect(visibleSpace(page).getByTestId('handle-plus')).toHaveCount(0);

  const empty = await emptyPoint(page);
  await page.mouse.click(empty.x, empty.y);
  await expect.poll(() => selectedIds(page)).toEqual([]);
  await clickNode(page, chosen);
  await expect(nodeOf(page, chosen).getByTestId('handle-plus')).toHaveCount(2);

  for (const percent of [100, 50]) {
    await zoomTo(page, percent);
    // The plus chases the pointer; park it on the empty canvas and let it spring back.
    const rest = await emptyPoint(page);
    await page.mouse.move(rest.x, rest.y);
    await page.waitForTimeout(500);
    const handle = nodeOf(page, chosen).locator('.react-flow__handle.source');
    const circle = (await handle.getByTestId('handle-plus').boundingBox())!;
    expect(circle.width, `the plus is 20px on screen at ${String(percent)}%`).toBeCloseTo(20, 0);
    const cx = circle.x + circle.width / 2;
    const cy = circle.y + circle.height / 2;
    const inset = 2;
    const pressed = {
      top: { x: cx, y: circle.y + inset },
      bottom: { x: cx, y: circle.y + circle.height - inset },
      innermost: { x: circle.x + inset, y: cy },
      centre: { x: cx, y: cy },
    };
    const hits = await handle.evaluate((h, points) => Object.fromEntries(Object.entries(points).map(([name, p]) => {
      const el = document.elementFromPoint(p.x, p.y);
      return [name, el?.closest('.react-flow__handle') === h];
    })), pressed);
    expect(hits, `every part of the plus presses the handle at ${String(percent)}%`).toEqual({
      top: true, bottom: true, innermost: true, centre: true,
    });
    const above = { x: cx - circle.width / 4, y: circle.y - 4 };
    const aboveHit = await page.evaluate((p) => {
      const el = document.elementFromPoint(p.x, p.y);
      return {
        handle: el?.closest('.react-flow__handle') != null,
        node: el?.closest('.react-flow__node')?.getAttribute('data-id') ?? null,
      };
    }, above);
    expect(aboveHit, `the node body above the plus is no handle at ${String(percent)}%`).toEqual({ handle: false, node: chosen });
  }

  await zoomTo(page, 100);
  const from = (await nodeOf(page, other).locator('.react-flow__handle.source').boundingBox())!;
  const onto = (await nodeOf(page, chosen).locator('.react-flow__handle.target').getByTestId('handle-plus').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(onto.x + onto.width / 2, onto.y + onto.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await graph(page)).edges.map((e) => `${e.source}->${e.target}`))
    .toEqual([`${other}->${chosen}`]);
});

test('a Viewer sees no selection plus and no handle plus', async ({ page, browser, baseURL }) => {
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  await seedNode(first, 'image', undefined, 0, 0);
  await seedNode(second, 'image', undefined, 360, 0);
  await fit(page);
  const { projectId, spaceId } = await idsOf(page);

  // The same two clicks show the plus to the editor, so an empty viewer
  // screen is about the role, not the selection.
  await clickNode(page, first);
  await clickNode(page, second, true);
  await expect(visibleSpace(page).getByTestId('selection-add-button')).toBeVisible();

  let viewer: BrowserContext | undefined;
  let viewerId: string | undefined;
  try {
    viewer = await browser.newContext({ baseURL, storageState: stateFile('B'), userAgent: USER_AGENT });
    await viewer.addInitScript(() => performance.setResourceTimingBufferSize(10_000));
    viewerId = (await dataOf<{ id: string }>(await viewer.request.get('/api/v1/auth/me'), 'read the viewer identity')).id;
    const seen = await inviteMember(page, viewer, projectId, credentialsFor('B').email, 'viewer');
    await seen.goto(page.url());
    await openSpaceById(seen, spaceId);
    await expect(nodeOf(seen, second)).toBeVisible({ timeout: 30_000 });
    await fit(seen);

    await clickNode(seen, first);
    await expect.poll(() => selectedIds(seen)).toEqual([first]);
    await expect(nodeOf(seen, first).getByTestId('handle-plus')).toHaveCount(0);
    await clickNode(seen, second, true);
    await expect.poll(() => selectedIds(seen)).toEqual([first, second].sort());
    await seen.waitForTimeout(500);
    await expect(visibleSpace(seen).getByTestId('selection-add-button')).toHaveCount(0);
  } finally {
    await viewer?.close();
    if (viewerId !== undefined) await cleanMembership(page, projectId, viewerId);
  }
});
