// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A canvas Space with a note on it, and the moves the annotation cases make.
 *
 * Both halves start here: the cases that measure what a note looks like and
 * how the board answers a pointer, and the ones that watch a note cross the
 * collab server to a second connection. A spec importing this evaluates it in
 * its own scope, so the hooks below build that file's Space and neither file
 * can reach the other's (measured, playwright 1.62.1, 2026-09-19).
 *
 * Each case gets its own Space. The cases used to run in order on one board,
 * which is why several of them ended by taking their own note off it again —
 * a leftover pin sits on top of the next case's and swallows its clicks.
 *
 * The second connection is opened only by the cases that need one. It is a
 * second page on the same context rather than a second account: nothing here
 * depends on who wrote a line, and the halves that do — A6's missing Edit on
 * somebody else's note, A11's name — are answered by the unit tests, which
 * can hand the component any author.
 */
import { expect, test, type Page } from 'playwright/test';

import { CANVAS_SPACE, liveModuleUrl } from './live-module';
import { openSmokeProject } from './project';
import { createSpace, deleteSpace } from './space';

/**
 * How long a change is given to cross the collab server.
 *
 * A canvas that has just mounted is still syncing, and an update crosses the
 * dev collab server before the other side draws it. Every wait is a poll, so
 * this is a ceiling and not a sleep.
 */
export const SETTLE_MS = 15_000;

/** The board this case is working on. */
interface Board {
  projectId: string;
  spaceId: string;
}

/** The current case's board, replaced before each of them. */
let board: Board | null = null;

/** The second connections this case opened, closed when it ends. */
let peers: Page[] = [];

/**
 * The Project and Space this case was given.
 * @returns The current case's board.
 * @throws {Error} When called outside a case, where there is none.
 */
function current(): Board {
  if (board === null) {
    throw new Error('no board: annotation helpers only work inside a case');
  }
  return board;
}

test.beforeEach(async ({ page }) => {
  // Wide, because several cases measure a sticky that hangs off its pin and a
  // minimap in the corner, and both want the board they were written against.
  await page.setViewportSize({ width: 1680, height: 950 });
  await openSmokeProject(page);
  const projectId = (/([0-9a-f-]{36})$/.exec(page.url()) ?? [])[1] ?? '';
  if (!projectId) throw new Error(`no project id in ${page.url()}`);
  const spaceId = await createSpace(page, 'canvas', `annotation-e2e ${Date.now()}`);
  await expect(page.locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  board = { projectId, spaceId };
});

test.afterEach(async ({ page }) => {
  for (const peer of peers) await peer.close();
  peers = [];
  if (board !== null) await deleteSpace(page, board.spaceId);
  board = null;
});

/**
 * Open a second connection to this case's Space and wait for its canvas.
 *
 * A second page on the same context, so it carries the same cookies and costs
 * no second sign-in.
 * @param page - The page this case was given, whose context the peer joins.
 * @returns The second page, live on the same Space.
 * @throws {Error} When its canvas never appears.
 */
export async function openPeer(page: Page): Promise<Page> {
  const { projectId, spaceId } = current();
  const peer = await page.context().newPage();
  peers.push(peer);
  await peer.setViewportSize({ width: 1680, height: 950 });
  await peer.goto(`/project/${projectId}`);
  const tab = peer.getByTestId(`space-tab-name-${spaceId}`);
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click();
  await expect(peer.locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  return peer;
}

/**
 * Arm the comment tool and land one note on the board.
 *
 * The board a case starts on is empty, so a case that opens "the note" puts
 * one there first. The point is left of centre, clear of the minimap in the
 * bottom-right corner and of the toolbar along the top.
 * @param page - The page to write on.
 * @param says - What the note says.
 * @returns The node id of the note that landed.
 * @throws {Error} When no pin appears.
 */
export async function landANote(page: Page, says = 'the shot needs to be slower'): Promise<string> {
  const before = await noteIds(page);
  await page.getByTestId('tool-comment').click();
  const board = await page.locator('.react-flow__pane').boundingBox();
  if (board === null) throw new Error('the board draws nothing');
  await page.mouse.click(board.x + board.width * 0.35, board.y + board.height * 0.45);
  const composer = page.getByTestId('annotation-composer-input');
  await expect(composer).toBeVisible({ timeout: SETTLE_MS });
  await page.keyboard.type(says);
  await page.keyboard.press('Enter');
  await expect(composer).toHaveCount(0);
  await expect(page.getByTestId('annotation-pin').first()).toBeVisible({
    timeout: SETTLE_MS,
  });
  const after = await noteIds(page);
  const landed = after.find((id) => !before.includes(id));
  if (landed === undefined) throw new Error('no new note reached the board');
  return landed;
}

/**
 * Seed two text nodes with a wire between them, both on screen right now.
 *
 * Flow coordinates are computed from where the board happens to be panned:
 * fixed ones put a wire below the fold, and a click into nothing reads exactly
 * like the defect these cases are for.
 * @param page - The page to write on.
 * @throws {Error} When the canvas is not on the page, or the wire never draws.
 */
export async function seedWiredPair(page: Page): Promise<void> {
  const { projectId, spaceId } = current();
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  await page.evaluate(
    async ([pid, sid, at]: [string, string, string]) => {
      const canvas = await import(/* @vite-ignore */ at);
      const viewport = document.querySelector('.react-flow__viewport');
      const pane = document.querySelector('.react-flow__pane');
      if (viewport === null || pane === null) throw new Error('no canvas');
      const m = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
      const seen = pane.getBoundingClientRect();
      /**
       * Flow coordinates for a point on screen.
       * @param sx - Screen x.
       * @param sy - Screen y.
       * @returns The same point in flow coordinates.
       */
      const atScreen = (sx: number, sy: number): { x: number; y: number } => ({
        x: (sx - m.e) / m.a,
        y: (sy - m.f) / m.d,
      });
      const left = atScreen(seen.x + 60, seen.y + seen.height * 0.72);
      const right = atScreen(seen.x + seen.width * 0.6, left.y * m.d + m.f);
      for (const [id, x] of [
        ['wire-a', left.x],
        ['wire-b', right.x],
      ] as [string, number][]) {
        canvas.addNode(pid, sid, {
          id,
          type: 'text',
          position: { x, y: left.y },
          data: {
            name: id,
            createdAt: Date.now(),
            createdBy: 'edge-e2e',
            locked: false,
            state: 'idle',
            attachments: [],
            content: id,
          },
        });
      }
      canvas.addEdge(pid, sid, { id: 'wire-e', source: 'wire-a', target: 'wire-b' });
    },
    [projectId, spaceId, canvasAt] as [string, string, string],
  );
  await expect.poll(() => page.locator('.react-flow__edge-path').count(), { timeout: SETTLE_MS }).toBeGreaterThan(0);
}

/**
 * Put a group on the board, with two nodes inside it.
 *
 * A marquee over a seeded pair raises the group toolbar, and its Group button
 * is what a person presses. A case that needs a group to press or drag puts
 * one there itself: the board it starts on is empty.
 * @param page - The page to work on.
 * @throws {Error} When the seeded nodes never draw, or no group appears.
 */
export async function makeAGroup(page: Page): Promise<void> {
  await seedWiredPair(page);
  const a = await page.locator('[data-id="wire-a"]').boundingBox();
  const b = await page.locator('[data-id="wire-b"]').boundingBox();
  if (a === null || b === null) throw new Error('the seeded nodes draw nothing');
  await page.mouse.move(a.x - 60, a.y - 60);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width + 60, b.y + b.height + 60, { steps: 12 });
  await page.mouse.up();
  const button = page.getByTestId('group-toolbar-group');
  await expect(button).toBeVisible({ timeout: SETTLE_MS });
  await button.click();
  await expect(page.locator('.react-flow__node-group')).toHaveCount(1, {
    timeout: SETTLE_MS,
  });
}

/**
 * A screen point in the board's own coordinates.
 *
 * The board moves under the reader — `fitView` frames the first node the
 * moment it appears — so anything compared across such a move has to be
 * compared here, where the viewport cannot reach it.
 * @param page - The page holding the board.
 * @param at - The point, in client coordinates.
 * @returns The same point in flow coordinates.
 */
export async function inFlow(page: Page, at: { x: number; y: number }): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([x, y]: [number, number]) => {
      const viewport = document.querySelector('.react-flow__viewport');
      if (viewport === null) throw new Error('no canvas');
      const m = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
      return { x: (x - m.e) / m.a, y: (y - m.f) / m.d };
    },
    [at.x, at.y] as [number, number],
  );
}

/**
 * Set the canvas zoom from the viewport toolbar, the way a reader does.
 * @param page - The page to zoom.
 * @param percent - One of the toolbar's presets, as a whole percentage.
 */
export async function setZoom(page: Page, percent: number): Promise<void> {
  await page.getByTestId('zoom-readout-trigger').click();
  await page.getByTestId(`zoom-preset-${percent}`).click();
  await expect(page.getByTestId('zoom-readout')).toHaveText(`${percent}%`, {
    timeout: SETTLE_MS,
  });
}

/**
 * Open the note's sticky on this page, if it is not open already.
 *
 * A note is a pin on the board and the sticky is what the pin opens into
 * (§8.7), so every assertion about what a note says goes through here. Opening
 * is per-reader and never reaches the document, so each page opens its own.
 * @param page - The page to open it on.
 */
export async function openTheNote(page: Page): Promise<void> {
  const sticky = page.getByTestId('annotation-sticky');
  if ((await sticky.count()) > 0) return;
  await page.getByTestId('annotation-pin').first().click();
  await expect(sticky.first()).toBeVisible({ timeout: SETTLE_MS });
}

/**
 * Collapse whatever note is open on this page.
 *
 * An open sticky floats over the board and keeps its own clicks — which is
 * what §8.7 asks of it, and what makes it a lid over whatever it covers. The
 * cases that aim at the board itself clear it first.
 * @param page - The page to collapse it on.
 */
export async function closeTheNote(page: Page): Promise<void> {
  if ((await page.getByTestId('annotation-sticky').count()) === 0) return;
  await page.getByTestId('annotation-pin').first().click();
  await expect(page.getByTestId('annotation-sticky')).toHaveCount(0, {
    timeout: SETTLE_MS,
  });
}

/**
 * The node ids of the notes on a page, in DOM order.
 * @param page - The page to read.
 * @returns One id per pin drawn.
 */
export async function noteIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.react-flow__node')]
      .filter((n) => n.querySelector('[data-testid="annotation-pin"]') !== null)
      .map((n) => n.getAttribute('data-id') ?? ''),
  );
}

/**
 * Take a note off the board through the document.
 *
 * A case that lands more than one note reaches for `annotation-pin.first()`
 * afterwards, so the extra pin has to go or it swallows the clicks meant for
 * the one under it. Deliberately not the menu: what is being removed is the
 * case's own leftovers, not the thing it measured.
 * @param page - The page to write from.
 * @param nodeId - The note to remove.
 */
export async function dropNote(page: Page, nodeId: string): Promise<void> {
  const { projectId, spaceId } = current();
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  await page.evaluate(
    async ([pid, sid, id, at]: [string, string, string, string]) => {
      const canvas = await import(/* @vite-ignore */ at);
      canvas.removeNode(pid, sid, id);
    },
    [projectId, spaceId, nodeId, canvasAt] as [string, string, string, string],
  );
  await expect(page.locator(`.react-flow__node[data-id="${nodeId}"]`)).toHaveCount(0, {
    timeout: SETTLE_MS,
  });
}
