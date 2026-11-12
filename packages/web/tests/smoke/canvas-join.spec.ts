// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The join mini-tool (inner#1825 §6.5): two or more audio or video nodes
 * selected together offer Join above Copy, the panel lists the clips in
 * canvas order with a crossfade capped per medium, and Run sends the first
 * clip as the source and the rest, in order, as the clips; the result node
 * stands right of the furthest clip, wired from every clip. A video node's
 * own Tools menu opens the panel on that one clip, which waits for a second
 * picked through the add tile.
 *
 * What the unit suite cannot reach: the marquee and the selection menu as the
 * canvas draws them, the pick mode run from the panel, and the request body
 * and canvas writes of a real press. The run request is answered here, so no
 * container runs and nothing outside the stack is needed; the clips' files
 * are served by this spec from the fixtures.
 *
 * Needs a running dev stack (`pnpm dev`).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { openTool, seedNode } from '../helpers/mini-tool';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

const FIXTURES = resolve(__dirname, '../fixtures/mini-tools');

/** Where the clips' files are served from, by this spec. */
const MEDIA_HOST = 'https://smoke-media.test';

/** Each medium's fixture, its length, and the longest crossfade its join takes. */
const MEDIA = {
  audio: { file: 'speech.mp3', ext: 'mp3', mime: 'audio/mpeg', duration: 6.144, maxCrossfade: '3' },
  video: { file: 'driving.mp4', ext: 'mp4', mime: 'video/mp4', duration: 8.042, maxCrossfade: '2' },
} as const;

type Medium = keyof typeof MEDIA;

let page: Page;
let projectId = '';
let spaceId = '';

/** What the run request carried. */
interface JoinBody {
  tool: string;
  node_ids: string[];
  source: { url: string };
  slots: { clips?: { url: string }[] };
  params: { crossfade?: number };
}

interface GraphView {
  nodes: { id: string; type: string; position: { x: number; y: number } }[];
  edges: { source: string; target: string }[];
}

/**
 * The open Space's nodes and edges, read from its document.
 * @returns The graph.
 */
async function graph(): Promise<GraphView> {
  const at = await liveModuleUrl(page, CANVAS_SPACE);
  return page.evaluate(
    async ([pid, sid, url]: [string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ url)) as { readCanvasGraph: (p: string, s: string) => unknown };
      return JSON.parse(JSON.stringify(canvas.readCanvasGraph(pid, sid))) as GraphView;
    },
    [projectId, spaceId, at] as [string, string, string],
  );
}

/**
 * Seed one clip holding the medium's fixture under an address of its own, so
 * the request names which clip went where.
 * @param medium - Audio or video.
 * @param name - The node's name.
 * @param x - Where it sits.
 * @returns The node id and its address.
 */
async function seedClip(medium: Medium, name: string, x: number): Promise<{ id: string; url: string }> {
  const id = randomUUID();
  const url = `${MEDIA_HOST}/${id}.${MEDIA[medium].ext}`;
  await seedNode(page, { projectId, spaceId }, id, medium, x, {
    name,
    content: url,
    mimeType: MEDIA[medium].mime,
    duration: MEDIA[medium].duration,
  });
  return { id, url };
}

/** Fit every node into view. */
async function fit(): Promise<void> {
  await page.getByTestId('viewport-toolbar').getByRole('button', { name: 'Fit to viewport', exact: true }).click();
  await page.waitForTimeout(600);
}

/**
 * Select nodes with one marquee drag around them all.
 * @param ids - The nodes.
 */
async function marquee(ids: string[]): Promise<void> {
  const boxes = await Promise.all(ids.map((id) => visibleSpace(page).locator(`.react-flow__node[data-id="${id}"]`).boundingBox()));
  if (boxes.some((box) => box === null)) throw new Error('a clip is not on screen');
  const all = boxes as { x: number; y: number; width: number; height: number }[];
  await page.mouse.move(Math.min(...all.map((b) => b.x)) - 40, Math.min(...all.map((b) => b.y)) - 40);
  await page.mouse.down();
  await page.mouse.move(Math.max(...all.map((b) => b.x + b.width)) + 40, Math.max(...all.map((b) => b.y + b.height)) + 40, { steps: 10 });
  await page.mouse.up();
  await expect(visibleSpace(page).locator('.react-flow__nodesselection-rect')).toBeVisible();
}

/**
 * Answer the run request with a task, the way the server admits one, and keep its body.
 * @returns Reads the body once it was sent.
 */
async function answerRun(): Promise<() => JoinBody | null> {
  let sent: JoinBody | null = null;
  await page.route('**/api/v1/mini-tools', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    sent = route.request().postDataJSON() as JoinBody;
    // A final answer: an aborted request has no answer, and the press would
    // keep sending it (inner#1490).
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { task_id: randomUUID(), status: 'pending' } }),
    });
  });
  return () => sent;
}

/**
 * The ids of the clips the open join panel lists, in its order.
 * @returns The node ids.
 */
async function listedClips(): Promise<string[]> {
  return page
    .getByTestId('join-panel')
    .locator('[data-testid^="join-tile-"]')
    .evaluateAll((tiles) => tiles.map((tile) => (tile.getAttribute('data-testid') ?? '').replace('join-tile-', '')));
}

/**
 * Check what a press wrote to the canvas: one result node right of the
 * furthest clip, wired from every clip.
 * @param body - The run request.
 * @param medium - The clips' medium.
 * @param clips - The clips' node ids.
 */
async function expectResultWired(body: JoinBody, medium: Medium, clips: string[]): Promise<void> {
  expect(body.node_ids).toHaveLength(1);
  const resultId = body.node_ids[0] ?? '';
  const { nodes, edges } = await graph();
  const result = nodes.find((n) => n.id === resultId);
  expect(result?.type).toBe(medium);
  const furthest = Math.max(...nodes.filter((n) => clips.includes(n.id)).map((n) => n.position.x));
  expect(result?.position.x ?? 0).toBeGreaterThan(furthest);
  expect(edges.filter((e) => e.target === resultId).map((e) => e.source).sort()).toEqual([...clips].sort());
}

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const bytes = {
    audio: readFileSync(join(FIXTURES, MEDIA.audio.file)),
    video: readFileSync(join(FIXTURES, MEDIA.video.file)),
  };
  await page.route(`${MEDIA_HOST}/**`, (route) => {
    const medium: Medium = route.request().url().endsWith('.mp4') ? 'video' : 'audio';
    return route.fulfill({
      status: 200,
      body: bytes[medium],
      headers: { 'access-control-allow-origin': '*', 'content-type': MEDIA[medium].mime },
    });
  });
  await openSmokeProject(page);
  projectId = smokeProjectId();
  spaceId = await createSpace(page, 'canvas', `join-e2e-${Date.now()}`);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
});

test.afterEach(async () => {
  // A menu or pick left open, on a red case too, would sit over the Space's tab.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  if (spaceId !== '') await deleteSpace(page, spaceId);
  await page.close();
  spaceId = '';
});

for (const [medium, count] of [['audio', 3], ['video', 2]] as const) {
  test(`${String(count)} ${medium} nodes selected together join in canvas order, the result wired from every clip`, async () => {
    // Seeded out of order: the list follows where each clip sits, not when it came.
    const xs = count === 3 ? [320, 640, 0] : [340, 0];
    const seeded: { x: number; id: string; url: string }[] = [];
    for (const [i, x] of xs.entries()) seeded.push({ x, ...(await seedClip(medium, `Clip ${String(i + 1)}`, x)) });
    const ordered = [...seeded].sort((a, b) => a.x - b.x);
    await fit();
    const sent = await answerRun();

    await marquee(seeded.map((clip) => clip.id));
    await visibleSpace(page).locator('.react-flow__nodesselection-rect').click({ button: 'right' });
    const joinItem = page.getByTestId('selection-menu-join');
    await expect(joinItem).toHaveText('Join');
    // Measured once the menu's zoom-in has finished: the rows' boxes scale with it.
    await joinItem.evaluate((el) => {
      const menu = el.closest('[role="menu"]') ?? el;
      return Promise.all(menu.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined)));
    });
    // Right above Copy.
    const [joinBox, copyBox] = await Promise.all([joinItem.boundingBox(), page.getByTestId('selection-menu-copy').boundingBox()]);
    expect((joinBox?.y ?? 0) + (joinBox?.height ?? 0)).toBeLessThanOrEqual(copyBox?.y ?? 0);
    await joinItem.click();

    await expect(page.getByTestId('join-panel')).toBeVisible({ timeout: 15_000 });
    expect(await listedClips()).toEqual(ordered.map((clip) => clip.id));
    await expect(page.getByTestId('join-needs-clip')).toHaveCount(0);
    const crossfade = page.getByRole('slider', { name: /crossfade/i });
    await expect(crossfade).toHaveAttribute('aria-valuemax', MEDIA[medium].maxCrossfade);
    await crossfade.focus();
    await crossfade.press('End');
    await expect(crossfade).toHaveAttribute('aria-valuenow', MEDIA[medium].maxCrossfade);
    await page.screenshot({ path: test.info().outputPath(`${medium}-join-panel.png`) });

    await page.getByTestId('mini-tool-run').click();
    await expect.poll(sent, { timeout: 15_000 }).not.toBeNull();
    const body = sent() as JoinBody;
    expect(body.tool).toBe(`${medium}.join`);
    expect(body.source.url).toBe(ordered[0]?.url);
    expect((body.slots.clips ?? []).map((clip) => clip.url)).toEqual(ordered.slice(1).map((clip) => clip.url));
    expect(body.params.crossfade).toBe(Number(MEDIA[medium].maxCrossfade));
    await expectResultWired(body, medium, seeded.map((clip) => clip.id));
  });
}

test('join from one video node\'s Tools menu waits for a second clip picked through the add tile', async () => {
  const first = await seedClip('video', 'Opening', 0);
  const second = await seedClip('video', 'Ending', 340);
  await fit();
  const sent = await answerRun();

  await openTool(page, first.id, 'video.join');
  await expect(page.getByTestId('join-panel')).toBeVisible({ timeout: 15_000 });
  expect(await listedClips()).toEqual([first.id]);
  await expect(page.getByTestId('join-needs-clip')).toHaveText('Add one more clip to run.');
  await expect(page.getByTestId('mini-tool-run')).toBeDisabled();

  await page.getByTestId('join-add').click();
  const exit = page.getByTestId('reference-pick-exit');
  await expect(exit.locator('..')).toContainText('Pick videos to join');
  await visibleSpace(page).locator(`.react-flow__node[data-id="${second.id}"]`).click();
  await expect.poll(listedClips, { timeout: 10_000 }).toEqual([first.id, second.id]);
  await expect(page.getByTestId('join-needs-clip')).toHaveCount(0);
  // A list takes more than one pick, so the pick stays on until the user leaves it.
  await expect(exit).toBeVisible();
  await exit.click();
  await expect(exit).toBeHidden();

  await expect(page.getByTestId('mini-tool-run')).toBeEnabled();
  await page.getByTestId('mini-tool-run').click();
  await expect.poll(sent, { timeout: 15_000 }).not.toBeNull();
  const body = sent() as JoinBody;
  expect(body.tool).toBe('video.join');
  expect(body.source.url).toBe(first.url);
  expect((body.slots.clips ?? []).map((clip) => clip.url)).toEqual([second.url]);
  await expectResultWired(body, 'video', [first.id, second.id]);
});
