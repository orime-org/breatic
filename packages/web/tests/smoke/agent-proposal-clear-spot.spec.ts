// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A proposal put on the canvas lands clear of what is already there, and the
 * camera follows it there (inner#1443).
 *
 * The chat answer is served here, so no model is involved: what is under test
 * is the canvas side -- where the nodes land, and where the view ends up.
 * The node in the way is a text of wide letters placed just above the centre:
 * the height its words are estimated at stops short of the spot the proposal
 * is aimed at, and only the height it is drawn at, which the canvas measures,
 * reaches it.
 */

import { expect, type Locator, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { startNewConversation } from '../helpers/conversation';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { projectIdOf } from '../helpers/tab-restore';

/**
 * The layout module and the node geometry, read for the numbers the blocker
 * is placed against. Both are pure, so a copy of their own is as good as the
 * one the canvas loaded.
 */
const PLACE_FLOW = '/spaces/canvas/lib/place-flow.ts';
const GROUP_GEOMETRY = '/spaces/canvas/group-geometry.ts';

/** Wide letters: each draws about twice the width the estimate gives it. */
const WIDE_WORDS = 'WWWW '.repeat(60);

/** How far above the proposal's top edge the blocker's estimated bottom ends. */
const ESTIMATE_CLEARANCE = 58;

/** How far off the pane's middle a framed centre may land, in screen pixels. */
const CENTRE_TOLERANCE = 1.5;

test.use({ viewport: { width: 1500, height: 900 } });

let page: Page;
let spaceId = '';

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await openSmokeProject(page);
  spaceId = await createSpace(page, 'canvas', `clear-spot-${String(Date.now())}`);
});

test.afterEach(async () => {
  if (spaceId !== '') await deleteSpace(page, spaceId);
  await page.close();
});

/** One empty image node, the smallest proposal there is. */
const ONE = {
  placed: true,
  nodes: [{ role: 'source', type: 'image', name: 'Your photo' }],
  edges: [],
  modelNote: '',
  rationale: '',
};

/** Two empty image nodes, which land as a group. */
const TWO = {
  placed: true,
  nodes: [
    { role: 'source', type: 'image', name: 'Front' },
    { role: 'source', type: 'image', name: 'Back' },
  ],
  edges: [],
  modelNote: '',
  rationale: '',
  groupName: 'Both sides',
};

/**
 * Answer the next message with a turn that proposes `proposal`.
 * @param p - The page.
 * @param proposal - What the proposal tool answers with.
 */
async function answerWithProposal(p: Page, proposal: object): Promise<void> {
  const chunks = [
    { type: 'data-heartbeat', transient: true, data: {} },
    { type: 'data-conversation-titled', data: { title: 'clear spot' } },
    { type: 'start', messageId: 'm-reply' },
    { type: 'start-step' },
    {
      type: 'tool-input-available',
      toolCallId: 'call-1',
      toolName: 'propose_canvas_action',
      input: { action: 'add_nodes' },
    },
    { type: 'tool-output-available', toolCallId: 'call-1', output: proposal },
    { type: 'finish-step' },
    { type: 'finish' },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
  await p.route('**/chat/message', (route) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body }),
  );
}

/**
 * Ask in chat and press "Use" on the card that comes back.
 * @param p - The page.
 */
async function useTheProposal(p: Page): Promise<void> {
  await startNewConversation(p);
  const composer = p.getByTestId('chat-composer-box');
  await composer.fill('Set up nodes for my photos.');
  await composer.press('Enter');
  const card = p.getByTestId('proposal-card').last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByTestId('proposal-use').click();
}

/**
 * The view's pan and zoom, read off the transform the canvas draws with.
 * @param p - The page.
 * @returns The transform string.
 */
async function viewTransform(p: Page): Promise<string> {
  return visibleSpace(p)
    .locator('.react-flow__viewport')
    .evaluate((el) => (el as HTMLElement).style.transform);
}

/**
 * Wait until the view stops moving, then read it.
 * @param p - The page.
 * @returns The pan and zoom it came to rest at.
 */
async function settledView(p: Page): Promise<{ x: number; y: number; zoom: number }> {
  await expect
    .poll(async () => {
      const before = await viewTransform(p);
      await p.waitForTimeout(400);
      return before === (await viewTransform(p));
    }, { message: 'the view comes to rest', timeout: 10_000 })
    .toBe(true);
  return visibleSpace(p)
    .locator('.react-flow__viewport')
    .evaluate((el) => {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return { x: m.e, y: m.f, zoom: m.a };
    });
}

/**
 * Add a text node at the origin through the live canvas module.
 * @param p - The page.
 * @param id - The node's id.
 * @param words - What it holds.
 */
async function addText(p: Page, id: string, words: string): Promise<void> {
  const canvasAt = await liveModuleUrl(p, CANVAS_SPACE);
  await p.evaluate(
    async ([pid, sid, url, nodeId, content]: [string, string, string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ url)) as {
        addNode: (p: string, s: string, n: unknown) => void;
      };
      canvas.addNode(pid, sid, {
        id: nodeId,
        type: 'text',
        position: { x: 0, y: 0 },
        data: {
          name: 'Notes',
          content,
          createdAt: Date.now(),
          createdBy: 'clear-spot',
          locked: false,
          attachments: [],
        },
      });
    },
    [projectIdOf(p.url()), spaceId, canvasAt, id, words] as [string, string, string, string, string],
  );
  await expect(visibleSpace(p).locator(`.react-flow__node[data-id="${id}"]`)).toBeVisible({ timeout: 20_000 });
}

/**
 * Check that the camera ended on `target`: centred in the pane, all of it in view.
 * @param pane - The canvas pane.
 * @param target - What landed.
 */
async function expectFramed(pane: Locator, target: Locator): Promise<void> {
  const paneBox = (await pane.boundingBox())!;
  const box = (await target.boundingBox())!;
  expect(
    Math.abs(box.x + box.width / 2 - (paneBox.x + paneBox.width / 2)),
    'centred across',
  ).toBeLessThanOrEqual(CENTRE_TOLERANCE);
  expect(
    Math.abs(box.y + box.height / 2 - (paneBox.y + paneBox.height / 2)),
    'centred down',
  ).toBeLessThanOrEqual(CENTRE_TOLERANCE);
  expect(box.x, 'left edge in view').toBeGreaterThanOrEqual(paneBox.x);
  expect(box.y, 'top edge in view').toBeGreaterThanOrEqual(paneBox.y);
  expect(box.x + box.width, 'right edge in view').toBeLessThanOrEqual(paneBox.x + paneBox.width);
  expect(box.y + box.height, 'bottom edge in view').toBeLessThanOrEqual(paneBox.y + paneBox.height);
}

test('lands to the right of a node drawn over its spot, and the camera follows at the same zoom', async () => {
  const pane = visibleSpace(page).locator('.react-flow__pane');
  await expect(pane).toBeVisible({ timeout: 20_000 });

  // The note goes in first: the first node on an empty canvas makes it frame
  // that node, so the middle of the view is only known once that is done.
  await addText(page, 'blocker', WIDE_WORDS);
  const blocker = visibleSpace(page).locator('.react-flow__node[data-id="blocker"]');
  const before = await settledView(page);
  const viewBefore = await viewTransform(page);

  const paneBox = (await pane.boundingBox())!;
  const centre = {
    x: (paneBox.width / 2 - before.x) / before.zoom,
    y: (paneBox.height / 2 - before.y) / before.zoom,
  };
  const { estimate, node } = await page.evaluate(
    async ([flowUrl, geometryUrl, words]: [string, string, string]) => {
      const layout = (await import(/* @vite-ignore */ flowUrl)) as {
        textFootprintHeight: (text: string) => number;
      };
      const geometry = (await import(/* @vite-ignore */ geometryUrl)) as {
        EMPTY_NODE_SIZE: { width: number; height: number };
      };
      return { estimate: layout.textFootprintHeight(words), node: geometry.EMPTY_NODE_SIZE };
    },
    [PLACE_FLOW, GROUP_GEOMETRY, WIDE_WORDS] as [string, string, string],
  );
  // Its estimated height ends a gap and a little above the proposal's top
  // edge; the words it holds draw it far taller than that.
  const blockerAt = {
    x: centre.x - node.width / 2,
    y: centre.y - node.height / 2 - ESTIMATE_CLEARANCE - estimate,
  };
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  await page.evaluate(
    async ([pid, sid, url, x, y]: [string, string, string, number, number]) => {
      const canvas = (await import(/* @vite-ignore */ url)) as {
        setNodePosition: (p: string, s: string, id: string, at: { x: number; y: number }, parent: null) => void;
      };
      canvas.setNodePosition(pid, sid, 'blocker', { x, y }, null);
    },
    [projectIdOf(page.url()), spaceId, canvasAt, blockerAt.x, blockerAt.y] as [string, string, string, number, number],
  );
  const blockerTop = paneBox.y + paneBox.height / 2 + (blockerAt.y - centre.y) * before.zoom;
  await expect.poll(async () => Math.round((await blocker.boundingBox())!.y)).toBe(Math.round(blockerTop));
  expect(await viewTransform(page), 'moving the note leaves the view where it is').toBe(viewBefore);
  expect(
    (await blocker.boundingBox())!.height / before.zoom,
    'the note draws down into the proposal, past where its estimate ends',
  ).toBeGreaterThan(estimate + ESTIMATE_CLEARANCE);

  await answerWithProposal(page, ONE);
  await useTheProposal(page);
  const placed = visibleSpace(page).locator('.react-flow__node:not([data-id="blocker"])');
  await expect(placed).toHaveCount(1, { timeout: 20_000 });
  const after = await settledView(page);

  const placedBox = (await placed.boundingBox())!;
  const blockerBox = (await blocker.boundingBox())!;
  const clear =
    placedBox.x >= blockerBox.x + blockerBox.width ||
    blockerBox.x >= placedBox.x + placedBox.width ||
    placedBox.y >= blockerBox.y + blockerBox.height ||
    blockerBox.y >= placedBox.y + placedBox.height;
  expect(clear, `placed ${JSON.stringify(placedBox)} clear of ${JSON.stringify(blockerBox)}`).toBe(true);
  expect(placedBox.x, 'moved to the right of the note').toBeGreaterThanOrEqual(blockerBox.x + blockerBox.width);
  expect(after.zoom, 'one node fits, so the zoom stays the reader’s').toBe(before.zoom);
  await expectFramed(pane, placed);
});

test('zooms out just far enough to show a group that does not fit at the reader’s zoom', async () => {
  const pane = visibleSpace(page).locator('.react-flow__pane');
  await expect(pane).toBeVisible({ timeout: 20_000 });
  // A node first, so the canvas has framed its first content before the
  // reader zooms in.
  await addText(page, 'anchor', 'x');
  await settledView(page);
  await page.getByTestId('zoom-readout-trigger').click();
  await page.getByTestId('zoom-preset-200').click();
  await expect.poll(async () => (await settledView(page)).zoom).toBe(2);

  await answerWithProposal(page, TWO);
  await useTheProposal(page);
  const group = visibleSpace(page).locator('.react-flow__node-group');
  await expect(group).toHaveCount(1, { timeout: 20_000 });
  const after = await settledView(page);

  expect(after.zoom, 'zoomed out to fit').toBeLessThan(2);
  await expectFramed(pane, group);
});
