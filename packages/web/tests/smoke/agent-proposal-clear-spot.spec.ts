// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A proposal put on the canvas lands clear of what is already there
 * (inner#1443).
 *
 * The chat answer is served here, so no model is involved: what is under test
 * is the canvas side -- where the nodes land, and that the view stays where
 * the reader left it. The node in the way is a text of wide letters placed
 * just above the centre: the height its words are estimated at stops short of
 * the spot the proposal is aimed at, and only the height it is drawn at, which
 * the canvas measures, reaches it.
 */

import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { startNewConversation } from '../helpers/conversation';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';

/**
 * The layout module, whose height estimate the blocker is placed against. The
 * estimate is a pure function, so a copy of its own is as good as the one the
 * canvas loaded.
 */
const PLACE_FLOW = '/spaces/canvas/lib/place-flow.ts';

/** Wide letters: each draws about twice the width the estimate gives it. */
const WIDE_WORDS = 'WWWW '.repeat(60);

/** How far above the proposal's top edge the blocker's estimated bottom ends. */
const ESTIMATE_CLEARANCE = 58;
import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { projectIdOf } from '../helpers/tab-restore';

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
const PROPOSAL = {
  placed: true,
  nodes: [{ role: 'source', type: 'image', name: 'Your photo' }],
  edges: [],
  modelNote: '',
  rationale: '',
};

/**
 * Answer the next message with a turn that proposes {@link PROPOSAL}.
 * @param p - The page.
 */
async function answerWithProposal(p: Page): Promise<void> {
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
    { type: 'tool-output-available', toolCallId: 'call-1', output: PROPOSAL },
    { type: 'finish-step' },
    { type: 'finish' },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
  await p.route('**/chat/message', (route) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body }),
  );
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

test('lands to the right of a node drawn over its spot, and leaves the view alone', async () => {
  const pane = visibleSpace(page).locator('.react-flow__pane');
  await expect(pane).toBeVisible({ timeout: 20_000 });
  const pid = projectIdOf(page.url());
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);

  // The note goes in first: the first node on an empty canvas makes it frame
  // that node, so the middle of the view is only known once that is done.
  await page.evaluate(
    async ([p, sid, url, words]: [string, string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ url)) as {
        addNode: (p: string, s: string, n: unknown) => void;
      };
      canvas.addNode(p, sid, {
        id: 'blocker',
        type: 'text',
        position: { x: 0, y: 0 },
        data: {
          name: 'Long notes',
          content: words,
          createdAt: Date.now(),
          createdBy: 'clear-spot',
          locked: false,
          attachments: [],
        },
      });
    },
    [pid, spaceId, canvasAt, WIDE_WORDS] as [string, string, string, string],
  );
  const blocker = visibleSpace(page).locator('.react-flow__node[data-id="blocker"]');
  await expect(blocker).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => {
      const before = await viewTransform(page);
      await page.waitForTimeout(300);
      return before === (await viewTransform(page));
    }, { message: 'the view settles after framing the note', timeout: 10_000 })
    .toBe(true);

  // The flow point at the middle of the pane, where an unobstructed proposal
  // is centred.
  const paneBox = (await pane.boundingBox())!;
  const centre = await visibleSpace(page)
    .locator('.react-flow__viewport')
    .evaluate((el, box) => {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return { x: (box.width / 2 - m.e) / m.a, y: (box.height / 2 - m.f) / m.a, zoom: m.a };
    }, { width: paneBox.width, height: paneBox.height });

  // Its estimated height ends a gap and a little above the proposal's top
  // edge; the words it holds draw it far taller than that.
  const estimate = await page.evaluate(
    async ([url, words]: [string, string]) => {
      const layout = (await import(/* @vite-ignore */ url)) as {
        textFootprintHeight: (text: string) => number;
      };
      return layout.textFootprintHeight(words);
    },
    [PLACE_FLOW, WIDE_WORDS] as [string, string],
  );
  const viewSettled = await viewTransform(page);
  await page.evaluate(
    async ([p, sid, url, x, y]: [string, string, string, number, number]) => {
      const canvas = (await import(/* @vite-ignore */ url)) as {
        setNodePosition: (p: string, s: string, id: string, at: { x: number; y: number }, parent: null) => void;
      };
      canvas.setNodePosition(p, sid, 'blocker', { x, y }, null);
    },
    [pid, spaceId, canvasAt, centre.x - 144, centre.y - 96 - ESTIMATE_CLEARANCE - estimate] as [
      string,
      string,
      string,
      number,
      number,
    ],
  );
  const blockerTop = paneBox.y + (centre.y - 96 - ESTIMATE_CLEARANCE - estimate) * centre.zoom +
    (paneBox.height / 2 - centre.y * centre.zoom);
  await expect.poll(async () => Math.round((await blocker.boundingBox())!.y)).toBe(Math.round(blockerTop));
  expect(await viewTransform(page), 'moving the note leaves the view where it is').toBe(viewSettled);
  const blockerBox = (await blocker.boundingBox())!;
  expect(
    blockerBox.height / centre.zoom,
    'the note draws down into the proposal, past where its estimate ends',
  ).toBeGreaterThan(estimate + ESTIMATE_CLEARANCE);

  await answerWithProposal(page);
  await startNewConversation(page);
  const composer = page.getByTestId('chat-composer-box');
  await composer.fill('Set up a node for my photo.');
  await composer.press('Enter');
  const card = page.getByTestId('proposal-card').last();
  await expect(card).toBeVisible({ timeout: 20_000 });

  const viewBefore = await viewTransform(page);
  await card.getByTestId('proposal-use').click();
  const placed = visibleSpace(page).locator('.react-flow__node:not([data-id="blocker"])');
  await expect(placed).toHaveCount(1, { timeout: 20_000 });

  const placedBox = (await placed.boundingBox())!;
  const clear =
    placedBox.x >= blockerBox.x + blockerBox.width ||
    blockerBox.x >= placedBox.x + placedBox.width ||
    placedBox.y >= blockerBox.y + blockerBox.height ||
    blockerBox.y >= placedBox.y + placedBox.height;
  expect(clear, `placed ${JSON.stringify(placedBox)} clear of ${JSON.stringify(blockerBox)}`).toBe(true);
  expect(placedBox.x, 'moved to the right of the note').toBeGreaterThanOrEqual(blockerBox.x + blockerBox.width);
  expect(await viewTransform(page), 'the view did not move').toBe(viewBefore);
});
