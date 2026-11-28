// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The selection plus (inner#2216), in a real browser.
 *
 * The unit tests pin which rows the menu offers, where the new node goes and
 * how the references are ordered; this file walks what a person does: marquee
 * or Cmd/Ctrl-click several nodes (or click a Group), press the plus, pick a
 * type, and read the wires and the new node's reference rail. It also measures
 * that the plus on a singly selected node rests 4px outside each border,
 * presses its handle and follows the pointer without crossing into the node
 * at 100% and 50% zoom, while the node body inside the border is no handle
 * (`elementFromPoint`).
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
import { roomForUploads } from '../helpers/upload-budget';
import { VISIBLE_SPACE, openSpaceById, visibleSpace } from '../helpers/space';

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
 * The canvas zoom the viewport is drawn at.
 * @param page - The page.
 * @returns The zoom.
 */
async function zoomOf(page: Page): Promise<number> {
  return visibleSpace(page).locator('.react-flow__viewport').evaluate(
    (el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a,
  );
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
  expect(plusBox.width, 'the plus is 24px wide on screen').toBeCloseTo(24, 0);
  expect(plusBox.height, 'the plus is 24px tall on screen').toBeCloseTo(24, 0);
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
  // Above a selected node (xyflow lifts those to 1000), so a wire passing
  // behind a neighbouring source stays one unbroken line.
  const previewZ = await visibleSpace(page).getByTestId('selection-add-preview').evaluate(
    (el) => Number(getComputedStyle(el).zIndex),
  );
  expect(previewZ, 'the preview draws above the selected nodes').toBeGreaterThan(1000);

  // With nothing to its right, the new node's left edge is one 72 canvas px
  // column past the selection's right edge.
  const zoom = await zoomOf(page);
  const seededX = new Map([[image, 0], [video, 320], [audio, 640]]);
  const selectionRight = Math.max(...[image, video, audio].map((id, i) => seededX.get(id)! + boxes[i]!.width / zoom));
  const before = (await graph(page)).nodes.map((n) => n.id);
  await page.getByTestId('create-node-image').click();
  const made = await newNode(page, before);
  expect(made.type).toBe('image');
  expect(Math.abs(made.x - (selectionRight + 72)), `built at ${String(selectionRight + 72)}, got ${String(made.x)}`).toBeLessThanOrEqual(1);
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
  expect(onMade, 'a press on the new node reaches the new node').toBe(made.id);

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

test('a singly selected node shows a plus 4px outside both borders that presses its handle and follows the pointer outside the node at 100% and 50% zoom, and takes a wire', async ({ page }) => {
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
    const node = (await nodeOf(page, chosen).boundingBox())!;
    const source = nodeOf(page, chosen).locator('.react-flow__handle.source');
    const target = nodeOf(page, chosen).locator('.react-flow__handle.target');
    const out = (await source.getByTestId('handle-plus').boundingBox())!;
    const back = (await target.getByTestId('handle-plus').boundingBox())!;
    expect(out.width, `the plus is 20px on screen at ${String(percent)}%`).toBeCloseTo(20, 0);
    // Wholly outside the node, 4 screen px from each border at rest.
    const border = node.x + node.width;
    expect(Math.abs(out.x - border - 4), `source gap at ${String(percent)}%`).toBeLessThanOrEqual(2);
    expect(Math.abs(node.x - (back.x + back.width) - 4), `target gap at ${String(percent)}%`).toBeLessThanOrEqual(2);
    const centre = { x: out.x + out.width / 2, y: out.y + out.height / 2 };
    const pressesSource = await source.evaluate((h, p) => document.elementFromPoint(p.x, p.y)?.closest('.react-flow__handle') === h, centre);
    expect(pressesSource, `the plus centre presses its handle at ${String(percent)}%`).toBe(true);
    // Nothing reaches into the node: just past the target's 8px anchor (which
    // sits inside the left border so the wire attaches flush), level with the
    // target plus, is node body.
    const anchor = (await target.boundingBox())!;
    const inside = { x: anchor.x + anchor.width + 2, y: back.y + back.height / 2 };
    const insideHit = await page.evaluate((p) => {
      const el = document.elementFromPoint(p.x, p.y);
      return {
        handle: el?.closest('.react-flow__handle') != null,
        node: el?.closest('.react-flow__node')?.getAttribute('data-id') ?? null,
      };
    }, inside);
    expect(insideHit, `just inside the left border is no handle at ${String(percent)}%`).toEqual({ handle: false, node: chosen });

    // It follows the pointer inside its zone: out towards the zone's far end...
    const restCentre = centre;
    const far = { x: border + 32, y: restCentre.y + 6 };
    await page.mouse.move(far.x, far.y, { steps: 4 });
    await page.waitForTimeout(500);
    const followed = (await source.getByTestId('handle-plus').boundingBox())!;
    const followedCentre = { x: followed.x + followed.width / 2, y: followed.y + followed.height / 2 };
    expect(followedCentre.x, `the plus moves out towards the pointer at ${String(percent)}%`).toBeGreaterThan(restCentre.x + 2);
    expect(Math.hypot(far.x - followedCentre.x, far.y - followedCentre.y), `the plus moves closer to the pointer at ${String(percent)}%`)
      .toBeLessThan(Math.hypot(far.x - restCentre.x, far.y - restCentre.y));
    // ...in to the border, and never past it into the node...
    await page.mouse.move(border + 1, restCentre.y, { steps: 4 });
    await page.waitForTimeout(500);
    const atBorder = (await source.getByTestId('handle-plus').boundingBox())!;
    expect(atBorder.x - border, `the plus stops at the border at ${String(percent)}%`).toBeGreaterThanOrEqual(-1);
    expect(atBorder.x - border, `the plus came in to the border at ${String(percent)}%`).toBeLessThanOrEqual(2);
    // ...and back to its 4px rest once the pointer leaves the zone.
    await page.mouse.move(rest.x, rest.y, { steps: 4 });
    await page.waitForTimeout(500);
    const back2 = (await source.getByTestId('handle-plus').boundingBox())!;
    expect(Math.abs(back2.x - border - 4), `the plus returns to rest at ${String(percent)}%`).toBeLessThanOrEqual(2);
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

/**
 * Drags a wire from a node's source handle and releases it at a point.
 * @param page - The page.
 * @param fromId - The node the wire starts from.
 * @param to - Where it is released, on screen.
 */
async function wireTo(page: Page, fromId: string, to: Point): Promise<void> {
  const from = (await nodeOf(page, fromId).locator('.react-flow__handle.source').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

// inner#2216: a wire released anywhere on the lone selected node's plus lands
// on that handle, at 50% zoom too, where the plus sits furthest outside the
// handle's own radius; the drag-to-blank create menu never opens instead.
test('at 50% zoom a wire released on the centre or the outer edge of a lone selected node\'s target plus connects to it', async ({ page }) => {
  const source = crypto.randomUUID();
  const chosen = crypto.randomUUID();
  await seedNode(source, 'image', undefined, 0, 0);
  await seedNode(chosen, 'image', undefined, 520, 0);
  await fit(page);
  await zoomTo(page, 50);

  const cases: Array<{ name: string; at: (plus: { x: number; y: number; width: number; height: number }) => Point }> = [
    { name: 'centre', at: (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 }) },
    // The target plus sits left of the node, so its outer edge is its left one.
    { name: 'outer edge', at: (b) => ({ x: b.x + 1, y: b.y + b.height / 2 }) },
  ];
  for (const { name, at } of cases) {
    await clickNode(page, chosen);
    await expect.poll(() => selectedIds(page)).toEqual([chosen]);
    const plus = nodeOf(page, chosen).locator('.react-flow__handle.target').getByTestId('handle-plus');
    await expect(plus).toHaveCount(1);
    // The plus chases the pointer; park it on the empty canvas and let it spring back.
    const rest = await emptyPoint(page);
    await page.mouse.move(rest.x, rest.y);
    await page.waitForTimeout(500);
    await wireTo(page, source, at((await plus.boundingBox())!));
    await expect.poll(async () => (await graph(page)).edges.map((e) => `${e.source}->${e.target}`), { message: `released on the ${name}` })
      .toEqual([`${source}->${chosen}`]);
    await expect(page.getByTestId('create-node-text'), `no create menu after a release on the ${name}`).toHaveCount(0);

    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await graph(page)).edges).toEqual([]);
  }
});

// inner#2216: with A the lone selection, its source plus zone reaches 36
// screen px past its right border, over a neighbour B whose left border sits
// 15 screen px away. A drag from A's own plus, or from a third node C, must
// still land on B's left dot: A's zone stands down for both (only a plus the
// drag could end on stays pressable), and no create menu opens.
for (const percent of [100, 50]) {
  test(`at ${String(percent)}% zoom a wire from the lone node's plus or from another node lands on a neighbour 15px right of it`, async ({ page }) => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const c = crypto.randomUUID();
    await seedNode(a, 'image', undefined, 0, 0);
    await seedNode(c, 'image', undefined, 0, 400);
    await fit(page);
    await zoomTo(page, percent);
    const zoom = await zoomOf(page);
    const aWidth = (await nodeOf(page, a).boundingBox())!.width / zoom;
    await seedNode(b, 'image', undefined, aWidth + 15 / zoom, 0);
    await fit(page);
    await zoomTo(page, percent);

    const aBox = (await nodeOf(page, a).boundingBox())!;
    const bBox = (await nodeOf(page, b).boundingBox())!;
    expect(Math.abs(bBox.x - (aBox.x + aBox.width) - 15), 'B\'s left border is 15 screen px right of A\'s').toBeLessThanOrEqual(2);
    const aSource = nodeOf(page, a).locator('.react-flow__handle.source');
    const bDot = nodeOf(page, b).locator('.react-flow__handle.target').getByTestId('handle-dot');
    const centreOf = (box: { x: number; y: number; width: number; height: number }): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    const bDotAt = centreOf((await bDot.boundingBox())!);
    expect(Math.abs(centreOf((await aSource.boundingBox())!).y - bDotAt.y), 'the handles sit at one height').toBeLessThanOrEqual(1);

    for (const from of ['plus', 'other'] as const) {
      await clickNode(page, a);
      await expect.poll(() => selectedIds(page)).toEqual([a]);
      await expect(nodeOf(page, a).getByTestId('handle-plus')).toHaveCount(2);
      const rest = await emptyPoint(page);
      await page.mouse.move(rest.x, rest.y);
      await page.waitForTimeout(500);
      const start = from === 'plus'
        ? centreOf((await aSource.getByTestId('handle-plus').boundingBox())!)
        : centreOf((await nodeOf(page, c).locator('.react-flow__handle.source').boundingBox())!);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      // B's dot sits a few px from A's plus, so the wire swings out below
      // first, as a hand does, rather than ending where it was pressed.
      await page.mouse.move(bDotAt.x + 40, bDotAt.y + 80, { steps: 8 });
      await page.mouse.move(bDotAt.x, bDotAt.y, { steps: 8 });
      await page.mouse.up();
      const wire = `${from === 'plus' ? a : c}->${b}`;
      await expect.poll(async () => (await graph(page)).edges.map((e) => `${e.source}->${e.target}`), { message: `a wire from the ${from}` })
        .toEqual([wire]);
      await expect(page.getByTestId('create-node-text'), `no create menu after the wire from the ${from}`).toHaveCount(0);
      await page.keyboard.press('ControlOrMeta+z');
      await expect.poll(async () => (await graph(page)).edges).toEqual([]);
    }
  });
}

// inner#2216: one thing made after a marquee is selected like a clicked node:
// the marquee's rect must not shrink onto it and take its presses.
test('a marquee over two nodes, then two text files dropped: their Group comes out selected with no selection rect, and a member takes a click', async ({ page }) => {
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  await seedNode(first, 'image', undefined, 0, 0);
  await seedNode(second, 'image', undefined, 360, 0);
  await fit(page);
  await zoomTo(page, 50);

  await marqueeOver(page, [first, second]);
  const before = (await graph(page)).nodes.map((n) => n.id);
  const at = await emptyPoint(page);
  await roomForUploads(2);
  await page.evaluate(([point, space]: [Point, string]) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['first brief'], 'rect-e2e-a.txt', { type: 'text/plain' }));
    transfer.items.add(new File(['second brief'], 'rect-e2e-b.txt', { type: 'text/plain' }));
    const pane = document.querySelector(`${space} .react-flow__pane`);
    if (pane === null) throw new Error('no canvas pane');
    const init = { clientX: point.x, clientY: point.y, bubbles: true, cancelable: true, dataTransfer: transfer };
    pane.dispatchEvent(new DragEvent('dragover', init));
    pane.dispatchEvent(new DragEvent('drop', init));
  }, [at, VISIBLE_SPACE] as [Point, string]);
  let group = '';
  let members: string[] = [];
  await expect.poll(async () => {
    const g = await graph(page);
    group = g.nodes.find((n) => n.type === 'group' && !before.includes(n.id))?.id ?? '';
    members = g.nodes.filter((n) => n.parentId === group && group !== '').map((n) => n.id);
    return members.length;
  }, { timeout: 20_000 }).toBe(2);
  await expect.poll(() => selectedIds(page)).toEqual([group]);
  await expect(visibleSpace(page).locator('.react-flow__nodesselection-rect')).toHaveCount(0);
  await clickNode(page, members[0]!);
  await expect.poll(() => selectedIds(page)).toEqual([members[0]!]);
});

// inner#2216: what a paste selects is exactly what it made. An edge selected
// before it is let go, so its scissors go and Delete cannot take it along.
test('a selected edge, then one copied node pasted: the edge is let go and the copy is the selection', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const copied = crypto.randomUUID();
  await seedNode(first, 'image', undefined, 0, 0);
  await seedNode(second, 'image', undefined, 520, 0);
  await seedNode(copied, 'image', undefined, 0, 600);
  const wire = `${first}->${second}`;
  await onCanvas(
    page,
    'canvas.addEdge(pid, sid, { id: extra.id, source: extra.source, target: extra.target, createdAt: Date.now() });',
    { id: wire, source: first, target: second },
  );
  const edge = visibleSpace(page).locator(`.react-flow__edge[data-id="${wire}"]`);
  await expect(edge).toHaveCount(1);
  await fit(page);
  await zoomTo(page, 50);

  await clickNode(page, copied);
  await expect.poll(() => selectedIds(page)).toEqual([copied]);
  await page.keyboard.press('ControlOrMeta+C');

  // The middle of the wire's path on screen, confirmed to hit the wire.
  const onWire = await edge.evaluate((el) => {
    const path = el.querySelector('path.react-flow__edge-path') ?? el.querySelector('path');
    if (!(path instanceof SVGPathElement)) return null;
    const at = path.getPointAtLength(path.getTotalLength() / 2);
    const matrix = path.getScreenCTM();
    if (matrix === null) return null;
    const point = new DOMPoint(at.x, at.y).matrixTransform(matrix);
    const hit = document.elementFromPoint(point.x, point.y)?.closest('.react-flow__edge');
    return hit === el ? { x: point.x, y: point.y } : null;
  });
  expect(onWire, 'a point on screen that hits the wire').not.toBeNull();
  await page.mouse.click(onWire!.x, onWire!.y);
  await expect(edge).toHaveClass(/selected/);
  await expect(visibleSpace(page).getByTestId(`edge-scissors-${wire}`)).toBeVisible();

  const before = (await graph(page)).nodes.map((n) => n.id);
  await page.keyboard.press('ControlOrMeta+V');
  const made = await newNode(page, before);
  await expect.poll(() => selectedIds(page)).toEqual([made.id]);
  await expect(edge).not.toHaveClass(/selected/);
  await expect(visibleSpace(page).getByTestId(`edge-scissors-${wire}`)).toHaveCount(0);
});

test('a marquee over two nodes, then one copied node pasted: no selection rect, and the copy takes a click', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const copied = crypto.randomUUID();
  await seedNode(first, 'image', undefined, 0, 0);
  await seedNode(second, 'image', undefined, 360, 0);
  await seedNode(copied, 'image', undefined, 0, 600);
  await fit(page);
  await zoomTo(page, 50);

  await clickNode(page, copied);
  await expect.poll(() => selectedIds(page)).toEqual([copied]);
  await page.keyboard.press('ControlOrMeta+C');
  await marqueeOver(page, [first, second]);
  const before = (await graph(page)).nodes.map((n) => n.id);
  await page.keyboard.press('ControlOrMeta+V');
  const made = await newNode(page, before);
  await expect.poll(() => selectedIds(page)).toEqual([made.id]);
  await expect(visibleSpace(page).locator('.react-flow__nodesselection-rect')).toHaveCount(0);
  const box = (await nodeOf(page, made.id).boundingBox())!;
  const hit = await page.evaluate((p) => document.elementFromPoint(p.x, p.y)?.closest('.react-flow__node')?.getAttribute('data-id') ?? null,
    { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  expect(hit, 'a press on the copy reaches the copy').toBe(made.id);
});

/**
 * Drags a marquee over the given nodes and waits for xyflow's selection rect.
 * @param page - The page.
 * @param ids - The nodes the marquee covers.
 */
async function marqueeOver(page: Page, ids: readonly string[]): Promise<void> {
  await holdMarqueeOver(page, ids);
  await page.mouse.up();
  await expect.poll(() => selectedIds(page)).toEqual([...ids].sort());
  await expect(visibleSpace(page).locator('.react-flow__nodesselection-rect')).toBeVisible();
}

/**
 * Waits for xyflow's selection rect to stand around exactly the given nodes.
 * @param page - The page.
 * @param ids - The nodes it must surround.
 */
async function expectRectAround(page: Page, ids: readonly string[]): Promise<void> {
  await expect.poll(() => selectedIds(page)).toEqual([...ids].sort());
  const rect = visibleSpace(page).locator('.react-flow__nodesselection-rect');
  await expect(rect).toBeVisible();
  await expect.poll(async () => {
    const r = await rect.boundingBox();
    if (r === null) return 'no rect';
    for (const id of ids) {
      const b = await nodeOf(page, id).boundingBox();
      if (b === null) return `${id} is not drawn`;
      if (b.x < r.x - 1 || b.y < r.y - 1 || b.x + b.width > r.x + r.width + 1 || b.y + b.height > r.y + r.height + 1) {
        return `${id} lies outside the rect`;
      }
    }
    return 'around';
  }).toBe('around');
}

// inner#2216: building from the selection plus clears xyflow's marquee rect
// for its one new node, but a duplicate or a paste of a marquee selection
// keeps it: the copies come out selected inside the rect, ready to drag.
// inner#2216: the selection rect wears the canvas's selected colour, not
// xyflow's default blue, in whichever theme the page is in.
test('a marquee over two nodes: the selection rect is filled with the selected colour, not xyflow\'s blue', async ({ page }) => {
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  await seedNode(first, 'image', undefined, 0, 0);
  await seedNode(second, 'image', undefined, 360, 0);
  await fit(page);
  await zoomTo(page, 50);

  await marqueeOver(page, [first, second]);
  const fill = await visibleSpace(page).locator('.react-flow__nodesselection-rect').evaluate((el) => getComputedStyle(el).backgroundColor);
  // The token resolved where the rect is drawn: a probe inside the canvas.
  const selectedBg = await visibleSpace(page).locator('.react-flow').first().evaluate((flow) => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--color-status-selected-bg)';
    flow.appendChild(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  });
  expect(fill, 'not xyflow\'s default blue').not.toBe('rgba(0, 89, 220, 0.08)');
  // Tailwind drops an @theme token no utility uses, and an unset token reads
  // as transparent here: the rect would then match a probe of nothing.
  expect(selectedBg, 'the token resolves to a colour').not.toBe('rgba(0, 0, 0, 0)');
  expect(fill, 'the selected background token').toBe(selectedBg);
});

test('a marquee over two nodes and Cmd/Ctrl+D: the selection rect surrounds the copies', async ({ page }) => {
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  await seedNode(first, 'image', undefined, 0, 0);
  await seedNode(second, 'image', undefined, 360, 0);
  await fit(page);
  await zoomTo(page, 50);

  await marqueeOver(page, [first, second]);
  const before = (await graph(page)).nodes.map((n) => n.id);
  await page.keyboard.press('ControlOrMeta+D');
  await expect.poll(async () => (await graph(page)).nodes.length, { timeout: 20_000 }).toBe(before.length + 2);
  const copies = (await graph(page)).nodes.filter((n) => !before.includes(n.id)).map((n) => n.id);
  await expectRectAround(page, copies);
});

test('a marquee over two nodes, copied and pasted: the selection rect surrounds the pasted copies', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  await seedNode(first, 'image', undefined, 0, 0);
  await seedNode(second, 'image', undefined, 360, 0);
  await fit(page);
  await zoomTo(page, 50);

  await marqueeOver(page, [first, second]);
  const before = (await graph(page)).nodes.map((n) => n.id);
  await page.keyboard.press('ControlOrMeta+C');
  await page.keyboard.press('ControlOrMeta+V');
  await expect.poll(async () => (await graph(page)).nodes.length, { timeout: 20_000 }).toBe(before.length + 2);
  const copies = (await graph(page)).nodes.filter((n) => !before.includes(n.id)).map((n) => n.id);
  await expectRectAround(page, copies);
});

test('a marquee over one node leaves nothing over it: its body takes a press and its plus presses the handle', async ({ page }) => {
  const lone = crypto.randomUUID();
  const other = crypto.randomUUID();
  await seedNode(lone, 'image', undefined, 0, 0);
  await seedNode(other, 'image', undefined, 520, 0);
  await fit(page);
  await zoomTo(page, 100);

  const box = (await nodeOf(page, lone).boundingBox())!;
  await page.mouse.move(box.x - 30, box.y - 30);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 30, box.y + box.height + 30, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => selectedIds(page)).toEqual([lone]);
  await expect(nodeOf(page, lone).getByTestId('handle-plus')).toHaveCount(2);

  // The plus chases the pointer; park it on the empty canvas and let it spring back.
  const rest = await emptyPoint(page);
  await page.mouse.move(rest.x, rest.y);
  await page.waitForTimeout(500);
  // xyflow leaves its marquee rect over a node the marquee ended on; it must
  // be gone, so the node takes a press as a click-selected one does.
  const onBody = await page.evaluate((p) => {
    const el = document.elementFromPoint(p.x, p.y);
    return el?.closest('.react-flow__node')?.getAttribute('data-id') ?? el?.getAttribute('class') ?? null;
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  expect(onBody, 'a press on the node body reaches the node').toBe(lone);
  const handle = nodeOf(page, lone).locator('.react-flow__handle.source');
  const circle = (await handle.getByTestId('handle-plus').boundingBox())!;
  const centre = { x: circle.x + circle.width / 2, y: circle.y + circle.height / 2 };
  const pressesHandle = await handle.evaluate((h, p) => document.elementFromPoint(p.x, p.y)?.closest('.react-flow__handle') === h, centre);
  expect(pressesHandle, 'the plus presses the handle').toBe(true);
});

/**
 * Presses on the pane above and left of the given nodes and drags a marquee
 * past their far corner, leaving the button held.
 * @param page - The page.
 * @param ids - The nodes the marquee covers.
 */
async function holdMarqueeOver(page: Page, ids: readonly string[]): Promise<void> {
  const boxes = await Promise.all(ids.map(async (id) => (await nodeOf(page, id).boundingBox())!));
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  await page.mouse.move(left - 30, top - 30);
  await page.mouse.down();
  await page.mouse.move(right + 30, bottom + 30, { steps: 10 });
}

test('while a marquee over two connected nodes is still held, neither the plus, the group toolbar nor the edge scissors show; all show on release', async ({ page }) => {
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  await seedNode(first, 'image', undefined, 0, 0);
  await seedNode(second, 'image', undefined, 360, 0);
  await onCanvas(
    page,
    'canvas.addEdge(pid, sid, { id: extra.source + "->" + extra.target, source: extra.source, target: extra.target, createdAt: Date.now() });',
    { source: first, target: second },
  );
  await expect(visibleSpace(page).locator('.react-flow__edge')).toHaveCount(1);
  await fit(page);
  await zoomTo(page, 50);

  await holdMarqueeOver(page, [first, second]);
  // The marquee has already selected both: what is held back is the chrome.
  await expect.poll(() => selectedIds(page)).toEqual([first, second].sort());
  await page.waitForTimeout(300);
  await expect(visibleSpace(page).getByTestId('selection-add-button')).not.toBeVisible();
  await expect(visibleSpace(page).getByTestId('group-selection-toolbar')).not.toBeVisible();
  const scissors = visibleSpace(page).locator('[data-testid^="edge-scissors-"]');
  await expect(scissors.filter({ visible: true })).toHaveCount(0);

  await page.mouse.up();
  await expect(visibleSpace(page).getByTestId('selection-add-button')).toBeVisible();
  await expect(visibleSpace(page).getByTestId('group-selection-toolbar')).toBeVisible();
  await expect(scissors.filter({ visible: true }).first()).toBeVisible();
});

test('while a marquee over one node is still held, its handles show no plus; both show it on release', async ({ page }) => {
  const lone = crypto.randomUUID();
  const other = crypto.randomUUID();
  await seedNode(lone, 'image', undefined, 0, 0);
  await seedNode(other, 'image', undefined, 520, 0);
  await fit(page);
  await zoomTo(page, 50);

  await holdMarqueeOver(page, [lone]);
  await expect.poll(() => selectedIds(page)).toEqual([lone]);
  await page.waitForTimeout(300);
  await expect(nodeOf(page, lone).getByTestId('handle-plus')).toHaveCount(0);

  await page.mouse.up();
  await expect(nodeOf(page, lone).getByTestId('handle-plus')).toHaveCount(2);
});

/**
 * Seeds two picture nodes and a decoy far to their left, frames all three so
 * the two sit against the pane's right edge, and selects the two.
 * @param page - The page.
 * @returns The two selected ids.
 */
async function selectTwoAtRightEdge(page: Page): Promise<[string, string]> {
  const decoy = crypto.randomUUID();
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  await seedNode(decoy, 'image', undefined, -3000, 0);
  await seedNode(first, 'image', undefined, 0, 0);
  await seedNode(second, 'image', undefined, 0, 300);
  await fit(page);
  await clickNode(page, first);
  await clickNode(page, second, true);
  await expect.poll(() => selectedIds(page)).toEqual([first, second].sort());
  return [first, second];
}

test('near the window\'s right edge, every row of the plus menu stays on screen', async ({ page }) => {
  await selectTwoAtRightEdge(page);
  const plus = visibleSpace(page).getByTestId('selection-add-button');
  await expect(plus).toBeVisible();
  await plus.click();
  await expect(page.getByTestId('selection-add-to-agent')).toBeVisible();
  // Let Radix settle its position before measuring.
  await page.waitForTimeout(300);
  const view = page.viewportSize()!;
  const menu = (await page.getByRole('menu').boundingBox())!;
  const plusBox = (await plus.boundingBox())!;
  expect(plusBox.x + plusBox.width + menu.width, 'opened to the right, the menu would pass the window edge').toBeGreaterThan(view.width);
  const rows = page.locator('[role="menuitem"]');
  await expect(rows).toHaveCount(5);
  for (const row of await rows.all()) {
    const b = (await row.boundingBox())!;
    const name = (await row.getAttribute('data-testid')) ?? 'row';
    expect(b.x, `${name} left`).toBeGreaterThanOrEqual(0);
    expect(b.y, `${name} top`).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width, `${name} right`).toBeLessThanOrEqual(view.width);
    expect(b.y + b.height, `${name} bottom`).toBeLessThanOrEqual(view.height);
  }
  await page.keyboard.press('Escape');
});

test('a pick that lands past the window\'s edge slides the new node into the canvas', async ({ page }) => {
  const [first, second] = await selectTwoAtRightEdge(page);
  const pane = (await visibleSpace(page).locator('.react-flow__pane').boundingBox())!;
  const zoom = await zoomOf(page);
  const boxes = await Promise.all([first, second].map(async (id) => (await nodeOf(page, id).boundingBox())!));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  expect(right + (72 + 288) * zoom, 'without a pan the new node would end past the pane').toBeGreaterThan(pane.x + pane.width);

  await visibleSpace(page).getByTestId('selection-add-button').click();
  const before = (await graph(page)).nodes.map((n) => n.id);
  await page.getByTestId('create-node-image').click();
  const made = await newNode(page, before);
  await expect(nodeOf(page, made.id)).toBeVisible();
  await expect.poll(async () => {
    const b = await nodeOf(page, made.id).boundingBox();
    return b !== null
      && b.x >= pane.x - 1 && b.y >= pane.y - 1
      && b.x + b.width <= pane.x + pane.width + 1 && b.y + b.height <= pane.y + pane.height + 1;
  }, { message: 'the new node ends inside the canvas pane', timeout: 5_000 }).toBe(true);
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
