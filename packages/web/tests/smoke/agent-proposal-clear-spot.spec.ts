// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A proposal put on the canvas lands clear of what is already there
 * (inner#1443).
 *
 * The chat answer is served here, so no model is involved: what is under test
 * is the canvas side -- where the nodes land, and that the view stays where
 * the reader left it. The node in the way is a long text placed just above
 * the centre, so that only its drawn height, not the standard footprint,
 * reaches the spot the proposal is aimed at.
 */

import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { startNewConversation } from '../helpers/conversation';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
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
  const paneBox = (await pane.boundingBox())!;
  // The flow point at the middle of the pane, where an unobstructed proposal
  // is centred.
  const centre = await visibleSpace(page)
    .locator('.react-flow__viewport')
    .evaluate((el, box) => {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return { x: (box.width / 2 - m.e) / m.a, y: (box.height / 2 - m.f) / m.a };
    }, { width: paneBox.width, height: paneBox.height });

  // Its standard footprint (192 tall) would end a gap and a little above the
  // proposal's top edge; the words it holds draw it far taller than that.
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  await page.evaluate(
    async ([pid, sid, url, x, y]: [string, string, string, number, number]) => {
      const canvas = (await import(/* @vite-ignore */ url)) as {
        addNode: (p: string, s: string, n: unknown) => void;
      };
      canvas.addNode(pid, sid, {
        id: 'blocker',
        type: 'text',
        position: { x, y },
        data: {
          name: 'Long notes',
          content: 'A long note that wraps over many lines. '.repeat(40),
          createdAt: Date.now(),
          createdBy: 'clear-spot',
          locked: false,
          attachments: [],
        },
      });
    },
    [projectIdOf(page.url()), spaceId, canvasAt, centre.x - 144, centre.y - 96 - 58 - 192] as [
      string,
      string,
      string,
      number,
      number,
    ],
  );
  const blocker = visibleSpace(page).locator('.react-flow__node[data-id="blocker"]');
  await expect(blocker).toBeVisible({ timeout: 20_000 });
  const blockerBox = (await blocker.boundingBox())!;
  const zoom = await visibleSpace(page)
    .locator('.react-flow__viewport')
    .evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
  expect(blockerBox.height / zoom, 'the note draws taller than the standard footprint').toBeGreaterThan(260);

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
