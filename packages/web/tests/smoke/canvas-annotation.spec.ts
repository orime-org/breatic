// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Annotations end to end (#1881) — the halves jsdom cannot answer.
 *
 * A custom CSS cursor fails silently in three separate ways and jsdom computes
 * no cursor at all, so A17 has only ever been read as text. Placement runs
 * through xyflow's own pane coordinates, which jsdom has none of. A12 is two
 * live connections converging on one collab server, which is not a thing one
 * document can be made to do. And a stacking order, a rendered size, or a
 * `maxLength` refusal is a thing a browser decides and jsdom does not — it
 * computes no z-index, no layout, and writes a value straight past the
 * attribute. Each case below says which of these it is standing on.
 *
 * Two pages in ONE context, one account. What A12 asks is whether what one
 * client writes reaches another, and presence on the wire keys on the
 * connection rather than the person — a second tab of the same account is a
 * second client in every way this measures, and costs no second sign-in
 * against a rate limit the whole suite shares. The halves that DO depend on
 * who wrote a line — A6's missing Edit on somebody else's note, A11's name —
 * are answered by the unit tests, which can hand the component any author.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type BrowserContext, type Page } from 'playwright/test';

import { openSmokeProject } from '../helpers/project';
import { signIn } from './helpers/session';
import { createSpace, deleteSpace } from './helpers/space';

// `author` writes, `peer` reads it back over the collab server.
let context: BrowserContext;
let author: Page;
let peer: Page;
let projectId = '';
let spaceId = '';

// A canvas that has just mounted is still syncing, and an update crosses the
// dev collab server before the other side draws it. Every wait below is a
// poll, so this is a ceiling and not a sleep.
const SETTLE_MS = 15_000;

/**
 * Bring a page into the run's Space and wait for the canvas to be live.
 * @param page - A signed-in page.
 * @throws {Error} When the canvas never appears.
 */
async function openTheSpace(page: Page): Promise<void> {
  await page.goto(`/project/${projectId}`);
  const tab = page.getByTestId(`space-tab-name-${spaceId}`);
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click();
  await expect(page.locator('.react-flow')).toBeVisible({ timeout: 20_000 });
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ viewport: { width: 1680, height: 950 } });
  author = await context.newPage();
  await signIn(author, email as string, password as string);

  // Reuse an existing Project: this spec is about annotations, and minting one
  // per run burns the tier's projects-per-studio allowance.
  await openSmokeProject(author);
  projectId = (/([0-9a-f-]{36})$/.exec(author.url()) ?? [])[1] as string;

  spaceId = await createSpace(author, 'canvas', `annotation-e2e ${Date.now()}`);
  await expect(author.locator('.react-flow')).toBeVisible({ timeout: 20_000 });

  peer = await context.newPage();
  await openTheSpace(peer);
});

test.afterAll(async () => {
  await peer?.close();
  if (spaceId !== '' && author !== undefined) {
    await deleteSpace(author, spaceId);
  }
  await context?.close();
});

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
async function inFlow(
  page: Page,
  at: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  return page.evaluate(([x, y]: [number, number]) => {
    const viewport = document.querySelector('.react-flow__viewport');
    if (viewport === null) throw new Error('no canvas');
    const m = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
    return { x: (x - m.e) / m.a, y: (y - m.f) / m.d };
  }, [at.x, at.y]);
}

/**
 * Set the canvas zoom from the viewport toolbar, the way a reader does.
 * @param page - The page to zoom.
 * @param percent - One of the toolbar's presets, as a whole percentage.
 */
async function setZoom(page: Page, percent: number): Promise<void> {
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
async function openTheNote(page: Page): Promise<void> {
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
 * cases below that aim at the board itself clear it first.
 * @param page - The page to collapse it on.
 */
async function closeTheNote(page: Page): Promise<void> {
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
async function noteIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.react-flow__node')]
      .filter((n) => n.querySelector('[data-testid="annotation-pin"]') !== null)
      .map((n) => n.getAttribute('data-id') ?? ''),
  );
}

/**
 * Take a note off the board through the document, as teardown.
 *
 * The cases below run in order on one board, and most of them reach for
 * `annotation-pin.first()` — so a case that leaves an extra pin on top of
 * another one blocks every click that follows it. This is the way back, and
 * it is deliberately not the menu: what is being torn down is this case's own
 * leftovers, not the thing it measured.
 * @param page - The page to write from.
 * @param nodeId - The note to remove.
 */
async function dropNote(page: Page, nodeId: string): Promise<void> {
  await page.evaluate(
    async ([pid, sid, id]: [string, string, string]) => {
      // Vite serves each module under a versioned URL; importing the bare path
      // would evaluate a SECOND copy whose caches are empty.
      const live = (re: RegExp): string =>
        performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .find((n) => re.test(n)) ?? '';
      const canvas = await import(
        /* @vite-ignore */ live(/data\/yjs\/canvas-space\.ts/)
      );
      canvas.removeNode(pid, sid, id);
    },
    [projectId, spaceId, nodeId] as [string, string, string],
  );
  await expect(
    page.locator(`.react-flow__node[data-id="${nodeId}"]`),
  ).toHaveCount(0, { timeout: SETTLE_MS });
}

// Two live collab connections and a Space to hold them outlast the suite-wide
// 30s budget before a single assertion runs.
test.setTimeout(90_000);

test('the armed tool says so on the button and under the pointer', async () => {
  const comment = author.getByTestId('tool-comment');
  await expect(comment).toHaveAttribute('aria-pressed', 'false');

  await comment.click();
  await expect(comment).toHaveAttribute('aria-pressed', 'true');

  // A17. The three ways a custom cursor fails — an SVG with no intrinsic
  // size, an image over 32x32, a rule with no keyword to fall back on — all
  // leave the pointer as it was with nothing in the console, so the only
  // answer that means anything comes from a browser that resolved the rule.
  //
  // Asked of whatever is on top at a point on the board, not of a named
  // element: while the tool is armed that is the drop layer, and the pointer
  // has to agree with the thing the click will land on or one of them is
  // lying about where a note may go.
  const pane = author.locator('.react-flow__pane');
  const box = await pane.boundingBox();
  if (box === null) throw new Error('the board is not on screen');
  const spot: [number, number] = [box.x + 300, box.y + box.height - 140];
  /**
   * The cursor of the topmost element over the board.
   * @returns The computed cursor there.
   */
  const pointerOverTheBoard = async (): Promise<string> =>
    author.evaluate(([x, y]: [number, number]) => {
      const el = document.elementFromPoint(x, y);
      return el === null ? '' : getComputedStyle(el).cursor;
    }, spot);

  await expect.poll(pointerOverTheBoard, { timeout: SETTLE_MS }).toContain(
    'url(',
  );

  // The tool is spent on the click that says where, and the button goes dark
  // with it (A16's second half).
  await author.keyboard.press('Escape');
  await expect(comment).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(pointerOverTheBoard).not.toContain('url(');
});

test('a note dropped on one canvas turns up on the other', async () => {
  await author.getByTestId('tool-comment').click();

  const pane = author.locator('.react-flow__pane');
  const box = await pane.boundingBox();
  if (box === null) throw new Error('the canvas pane has no box');
  const at = {
    x: box.x + box.width * 0.45,
    y: box.y + box.height * 0.4,
  };
  const asked = await inFlow(author, at);
  await author.mouse.click(at.x, at.y);

  // A1: the box opens focused where the click landed, and Enter keeps it.
  const composer = author.getByTestId('annotation-composer-input');
  await expect(composer).toBeVisible({ timeout: SETTLE_MS });
  await author.keyboard.type('the shot needs to be slower');
  await author.keyboard.press('Enter');
  await expect(composer).toHaveCount(0);

  // A22: what lands on the board is a pin, wearing the face of whoever raised
  // it. The words are one click away.
  const pin = author.getByTestId('annotation-pin').first();
  await expect(pin).toBeVisible({ timeout: SETTLE_MS });

  // A17 / §8.7.2: the pin's TAIL TIP sits on the point that was pointed at,
  // which is what the per-node origin `[0, 1]` buys and the only thing that
  // makes the bubble cursor honest. Measured here because nothing else can
  // see it: with the origin line taken out, 2884 unit tests and every other
  // case in this file stayed green while the pin sat a pin's height low.
  // In flow coordinates, because `fitView` frames this first note the moment
  // it appears and the board is somewhere else by the time this reads it.
  const landed = await pin.boundingBox();
  if (landed === null) throw new Error('the pin draws nothing');
  const tail = await inFlow(author, {
    x: landed.x,
    y: landed.y + landed.height,
  });
  // Within a pixel: the press lands on a whole device pixel while the point
  // asked for carries a fraction, so the two disagree by up to one. Taking
  // the origin line out moves the tail by 28.
  expect(Math.abs(tail.x - asked.x)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(tail.y - asked.y)).toBeLessThanOrEqual(1.5);

  await openTheNote(author);
  await expect(author.getByTestId('annotation-sticky').first()).toContainText(
    'the shot needs to be slower',
  );

  // A12: the other client's canvas follows.
  await expect(peer.getByTestId('annotation-pin').first()).toBeVisible({
    timeout: SETTLE_MS,
  });
  await openTheNote(peer);
  await expect(peer.getByTestId('annotation-sticky').first()).toContainText(
    'the shot needs to be slower',
  );
});

test('the sticky hangs off the pin the way the demo has it', async () => {
  // Two decisions from the demo, both structural: their top edges are level,
  // and the gap between them is 8px. Centred instead — which is what
  // NodeToolbar does by default — a 280px sticky hung 126px above the point
  // somebody was pointing at.
  await openTheNote(author);
  const pin = await author.getByTestId('annotation-pin').first().boundingBox();
  const sticky = await author.getByTestId('annotation-sticky').boundingBox();
  if (pin === null || sticky === null) throw new Error('nothing to measure');
  expect(sticky.y).toBeCloseTo(pin.y, 0);
  expect(sticky.x - (pin.x + pin.width)).toBeCloseTo(8, 0);
});

test('the pin drags, and the other canvas follows it', async () => {
  // A24. Until the note became its pin this was the one thing on the board
  // that could not be moved: the sticky's face was covered in `nodrag`.
  await openTheNote(author);
  const pin = author.getByTestId('annotation-pin').first();
  const from = await pin.boundingBox();
  if (from === null) throw new Error('the pin draws nothing');
  await author.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await author.mouse.down();
  // The press has to travel past `nodeDragThreshold` before xyflow starts the
  // drag at all, and `startDrag` anchors the node to wherever the pointer was
  // on THAT event (`@xyflow/system@0.0.79:2199`) — so this nudge is the part
  // of the gesture the node never sees, and everything after it is the part
  // it does. Spelled out rather than left inside a stepped move, where the
  // discarded part would be one step's worth of whatever `steps` happened to
  // be.
  const NUDGE = 4;
  await author.mouse.move(
    from.x + from.width / 2 + NUDGE,
    from.y + from.height / 2,
  );
  await author.mouse.move(from.x + 140, from.y + 90, { steps: 12 });
  await author.mouse.up();

  // Both axes: the pin's coordinate is its tail tip (origin [0,1]), so a drag
  // that fed the painted top-left back as the position would move it a pin's
  // height every time — and only the y would show it.
  await expect
    .poll(async () => (await pin.boundingBox())?.x ?? 0, { timeout: SETTLE_MS })
    .toBeGreaterThan(from.x + 60);
  const landed = await pin.boundingBox();
  if (landed === null) throw new Error('the pin draws nothing');
  // The drag began at the pin's centre plus the nudge and released at
  // (+140, +90) of its top-left, and the pin goes exactly that far on both
  // axes. Measured before the frame conversion went in, the pin came up a
  // pin's height short on y: a note's coordinate is its tail tip, and the
  // painted top-left was being fed back as the position.
  expect(landed.x - from.x).toBeCloseTo(140 - from.width / 2 - NUDGE, 0);
  expect(landed.y - from.y).toBeCloseTo(90 - from.height / 2, 0);
  // The sticky rode along rather than staying where the pin used to be.
  const sticky = await author.getByTestId('annotation-sticky').boundingBox();
  const moved = await pin.boundingBox();
  if (sticky === null || moved === null) throw new Error('nothing to measure');
  expect(sticky.x).toBeGreaterThan(moved.x);

  // The position is in the document, so the other canvas has it too.
  const peerPin = peer.getByTestId('annotation-pin').first();
  await expect
    .poll(async () => (await peerPin.boundingBox())?.x ?? 0, {
      timeout: SETTLE_MS,
    })
    .toBeGreaterThan(from.x + 60);
});

test('a small slip on the pin opens the note instead of moving it', async () => {
  // §8.7.3: opening and dragging share one press, and the library's own
  // threshold is a single pixel — at which a trackpad click both wrote the
  // note a new position and had its click swallowed by d3-drag.
  const pin = author.getByTestId('annotation-pin').first();
  const at = await pin.boundingBox();
  if (at === null) throw new Error('the pin draws nothing');
  // Start closed, so the press has an outcome to show.
  if ((await author.getByTestId('annotation-sticky').count()) > 0) {
    await pin.click();
  }
  await author.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await author.mouse.down();
  await author.mouse.move(at.x + at.width / 2 + 2, at.y + at.height / 2 + 1);
  await author.mouse.up();

  await expect(author.getByTestId('annotation-sticky')).toBeVisible({
    timeout: SETTLE_MS,
  });
  const after = await pin.boundingBox();
  if (after === null) throw new Error('the pin draws nothing');
  expect(Math.abs(after.x - at.x)).toBeLessThanOrEqual(1);
});

test('the keyboard opens a note, without a pointer anywhere', async () => {
  // A25 / D1: xyflow's own key handling calls `handleNodeClick` on Enter and
  // never `onClick`, so a pin that only answered clicks would leave three of
  // this task's four verbs out of reach from the keyboard.
  await closeTheNote(author);
  const pin = author.getByTestId('annotation-pin').first();
  // xyflow makes every node wrapper a tab stop of its own, and Enter there
  // only selects the node — measured on a board, the sticky stayed shut. The
  // pin's button is the one stop for a note, so tabbing back onto it from its
  // neighbour lands on the button itself, not on a wrapper in between.
  expect(
    await pin.evaluate((el) =>
      el.closest('.react-flow__node')?.getAttribute('tabindex'),
    ),
  ).toBeNull();
  await pin.focus();
  await author.keyboard.press('Shift+Tab');
  await author.keyboard.press('Tab');
  await expect(pin).toBeFocused();

  await author.keyboard.press('Enter');
  await expect(author.getByTestId('annotation-sticky')).toBeVisible({
    timeout: SETTLE_MS,
  });
});

test('Escape collapses the note, and the draft box goes first', async () => {
  // §8.7.3. A pin is not one of xyflow's focus stops, so the library's own
  // "Escape unselects the focused node" never runs for a note — measured on a
  // board before the panel took the key itself, the sticky stayed open on
  // every press. The first press belongs to whatever box has something to
  // drop, so a reply half typed is not thrown away by the key that closes.
  await openTheNote(author);
  const replyBox = author.getByTestId('annotation-sticky-reply-input');
  await replyBox.click();
  await author.keyboard.type('not finished');
  await author.keyboard.press('Escape');
  await expect(replyBox).toHaveValue('');
  await expect(author.getByTestId('annotation-sticky')).toBeVisible();

  await author.keyboard.press('Escape');
  await expect(author.getByTestId('annotation-sticky')).toHaveCount(0, {
    timeout: SETTLE_MS,
  });
});

test('a reply written on one canvas turns up on the other', async () => {
  await openTheNote(peer);
  await openTheNote(author);
  // A3 + A19: the row is one full-width box until something is typed, and the
  // two buttons appear under it.
  const replyBox = peer.getByTestId('annotation-sticky-reply-input');
  await expect(replyBox).toBeVisible({ timeout: SETTLE_MS });
  await expect(peer.getByTestId('annotation-sticky-reply-post')).toHaveCount(0);

  await replyBox.click();
  await peer.keyboard.type('agreed, and wider');
  await expect(peer.getByTestId('annotation-sticky-reply-cancel')).toBeVisible();
  await peer.getByTestId('annotation-sticky-reply-post').click();

  await expect(peer.getByTestId('annotation-sticky-replies')).toContainText(
    'agreed, and wider',
    { timeout: SETTLE_MS },
  );
  await expect(author.getByTestId('annotation-sticky-replies')).toContainText(
    'agreed, and wider',
    { timeout: SETTLE_MS },
  );
});

test('a rewrite reaches the other canvas, and it says it was edited', async () => {
  await openTheNote(author);
  await openTheNote(peer);
  // A4. The menu belongs to the author of the line, and this account wrote
  // the note, so it is here on both pages; the rewrite is done on the page
  // that placed it.
  await author.getByTestId('annotation-sticky-body-menu').click();
  await author.getByTestId('annotation-sticky-body-edit').click();

  const editing = author.getByTestId('annotation-sticky-body-input');
  await expect(editing).toBeVisible({ timeout: SETTLE_MS });
  // The box opens holding what the note says, and the caret sits after it so
  // the next keystroke continues the line (user 2026-09-15). `focus()` leaves
  // the selection where it is and a textarea starts at offset 0, so read this
  // on a real browser — the caret was at the front of the words.
  expect(
    await editing.evaluate(
      (el) => (el as HTMLTextAreaElement).selectionStart,
    ),
  ).toBe('the shot needs to be slower'.length);
  await editing.fill('the shot needs to be slower and wider');
  await author.getByTestId('annotation-sticky-body-save').click();

  await expect(peer.getByTestId('annotation-sticky-body')).toContainText(
    'slower and wider',
    { timeout: SETTLE_MS },
  );
  await expect(peer.getByTestId('annotation-sticky-body-edited')).toBeVisible({
    timeout: SETTLE_MS,
  });
});

test('the keyboard reaches the reply buttons, and a rewrite keeps its own', async () => {
  await openTheNote(author);
  await openTheNote(peer);
  // F: Cancel and Post sit after the box in the tab order. Which element a Tab
  // lands on is the browser's own sequential navigation order, and jsdom has
  // none — the unit test can only say the reply survived the blur.
  const replyBox = author.getByTestId('annotation-sticky-reply-input');
  await replyBox.click();
  await author.keyboard.type('one more thing');

  await author.keyboard.press('Tab');
  await expect(author.getByTestId('annotation-sticky-reply-cancel')).toBeFocused();
  await expect(replyBox).toHaveValue('one more thing');

  await author.keyboard.press('Tab');
  await expect(author.getByTestId('annotation-sticky-reply-post')).toBeFocused();

  // A18: the cancel drops it, and nothing reaches the other canvas.
  await author.keyboard.press('Shift+Tab');
  await expect(author.getByTestId('annotation-sticky-reply-cancel')).toBeFocused();
  await author.keyboard.press('Enter');
  await expect(replyBox).toHaveValue('');
  await expect(peer.getByTestId('annotation-sticky-replies')).not.toContainText(
    'one more thing',
  );

  // G: the rewrite box's buttons sit under the scroller that caps the words,
  // so a note long enough to fill the cap still shows them. Measured, because
  // "outside that element" is what the unit test can see and "on the screen
  // where the reader is" is what this is for.
  await author.getByTestId('annotation-sticky-body-menu').click();
  await author.getByTestId('annotation-sticky-body-edit').click();
  await author
    .getByTestId('annotation-sticky-body-input')
    .fill('a long note. '.repeat(80));

  const scroller = author.getByTestId('annotation-sticky-body-scroller');
  const save = author.getByTestId('annotation-sticky-body-save');
  await expect(save).toBeVisible();
  const [scrollerBox, saveBox] = await Promise.all([
    scroller.boundingBox(),
    save.boundingBox(),
  ]);
  if (scrollerBox === null || saveBox === null) {
    throw new Error('the rewrite box or its scroller has no box');
  }
  expect(saveBox.y).toBeGreaterThanOrEqual(scrollerBox.y + scrollerBox.height);

  await author.getByTestId('annotation-sticky-body-cancel').click();
});

test('a wire is board too: the armed tool lands a note on an edge', async () => {
  await closeTheNote(author);
  // xyflow routes a click on a wire to its own handler, not to the pane's, so
  // the pointer said "you can drop here" everywhere the wires run while the
  // click did nothing. jsdom renders no edges to click.
  await author.evaluate(
    async ([pid, sid]: [string, string]) => {
      // Vite serves each module under a versioned URL; importing the bare path
      // would evaluate a SECOND copy whose caches are empty.
      const live = (re: RegExp): string =>
        performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .find((n) => re.test(n)) ?? '';
      const canvas = await import(
        /* @vite-ignore */ live(/data\/yjs\/canvas-space\.ts/)
      );
      // In flow coordinates that are on screen right now. Fixed ones depend on
      // where the board happens to be panned, and a wire below the fold is a
      // click into nothing — which reads exactly like the bug this is for.
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
      canvas.addEdge(pid, sid, {
        id: 'wire-e',
        source: 'wire-a',
        target: 'wire-b',
      });
    },
    [projectId, spaceId] as [string, string],
  );

  // The wire is an SVG group with no layout box of its own, so aim at the
  // middle of the path it draws.
  const wire = author.locator('.react-flow__edge-path').first();
  await expect
    .poll(() => wire.count(), { timeout: SETTLE_MS })
    .toBeGreaterThan(0);
  const box = await wire.boundingBox();
  if (box === null) throw new Error('the wire draws nothing');
  const before = await author.getByTestId('annotation-pin').count();

  await author.getByTestId('tool-comment').click();
  await author.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const composer = author.getByTestId('annotation-composer-input');
  await expect(composer).toBeVisible({ timeout: SETTLE_MS });
  await author.keyboard.type('this wire is wrong');
  await author.keyboard.press('Enter');
  await expect(author.getByTestId('annotation-pin')).toHaveCount(before + 1, {
    timeout: SETTLE_MS,
  });
});

test('the box being typed into is on top of the notes already on the board', async () => {
  // Reported from a board: two existing pins painted over the box somebody was
  // typing into. Stacking is the one thing jsdom computes nothing for, so it
  // is only answerable here — and `elementFromPoint` answers it the way the
  // pointer does, by asking who is actually on top.
  await closeTheNote(author);
  const pin = author.getByTestId('annotation-pin').first();
  const onScreen = await pin.boundingBox();
  if (onScreen === null) throw new Error('no pin on the board');
  const had = await noteIds(author);

  // The box hangs down-right of the point that was clicked, so clicking
  // above-left of the pin puts the pin inside the box's own rectangle —
  // measured: clicking 40 left and 30 up of a pin at (787,386) opens a box at
  // (760,370) 200x66, which covers the pin whole.
  await author.getByTestId('tool-comment').click();
  await author.mouse.click(onScreen.x - 40, onScreen.y - 30);
  const composer = author.getByTestId('annotation-composer-input');
  await expect(composer).toBeVisible({ timeout: SETTLE_MS });

  // Asked positively: whatever is on top at the pin's own centre has to be
  // part of the box. "Not the pin" is the assertion that let this through
  // once — the element on top there was the pin's AVATAR, a different id.
  const topmost = await author.evaluate(([x, y]: [number, number]) => {
    const el = document.elementFromPoint(x, y);
    if (el === null) return '(nothing)';
    const box = el.closest('[data-testid="annotation-composer"]');
    if (box !== null) return 'inside the box';
    return el.closest('[data-testid]')?.getAttribute('data-testid') ?? el.tagName;
  }, [onScreen.x + onScreen.width / 2, onScreen.y + onScreen.height / 2] as [number, number]);
  expect(topmost).toBe('inside the box');

  await author.keyboard.press('Escape');
  await expect(author.getByTestId('annotation-composer-input')).toHaveCount(0);
  expect(await noteIds(author)).toEqual(had);
});

test('a note stops accepting characters at the cap', async () => {
  // `maxLength` is the platform refusing the 301st character, and jsdom writes
  // a value straight past the attribute — so the refusal itself is only
  // readable here. 300 is the number chosen for a note (user 2026-09-16).
  await closeTheNote(author);
  const had = await noteIds(author);
  await author.getByTestId('tool-comment').click();
  const pane = await author.locator('.react-flow__pane').boundingBox();
  if (pane === null) throw new Error('no pane');
  await author.mouse.click(pane.x + pane.width * 0.3, pane.y + pane.height * 0.6);
  const box = author.getByTestId('annotation-composer-input');
  await expect(box).toBeVisible({ timeout: SETTLE_MS });

  // Pasted rather than typed: the path a long note actually arrives by, and
  // the one `maxLength` has to hold.
  await box.fill('x'.repeat(400));
  expect(await box.inputValue()).toHaveLength(300);

  await author.keyboard.press('Escape');
  await expect(author.getByTestId('annotation-composer-input')).toHaveCount(0);
  expect(await noteIds(author)).toEqual(had);
});

test('a pin is board too while the tool is armed: the click lands a new note', async () => {
  // The §8.7.3 row "armed, pressing this pin" says the pin does not open and
  // a second note goes down at that point, and the reason given is stacking:
  // the drop layer is the hit target over the whole board, pins included.
  // Stacking is the one thing jsdom computes nothing for, so the claim can
  // only be read here.
  await closeTheNote(author);
  const pin = author.getByTestId('annotation-pin').first();
  const box = await pin.boundingBox();
  if (box === null) throw new Error('no pin on the board');
  const had = await noteIds(author);

  await author.getByTestId('tool-comment').click();
  await author.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const composer = author.getByTestId('annotation-composer-input');
  await expect(composer).toBeVisible({ timeout: SETTLE_MS });
  // The pin it was aimed at stayed shut: one press says one thing.
  await expect(author.getByTestId('annotation-sticky')).toHaveCount(0);

  await author.keyboard.type('and another thing');
  await author.keyboard.press('Enter');
  await expect
    .poll(async () => (await noteIds(author)).length, { timeout: SETTLE_MS })
    .toBe(had.length + 1);

  // It landed on top of the pin it was aimed at, which is the point — and it
  // is also a lid over that pin for every case after this one.
  const landed = (await noteIds(author)).find((id) => !had.includes(id));
  if (landed === undefined) throw new Error('the new note has no id');
  await dropNote(author, landed);
});

test('a marquee selection is board too, not a dead rectangle', async () => {
  await closeTheNote(author);
  // xyflow lays `.react-flow__nodesselection-rect` over the selected nodes and
  // the gaps between them, at `pointer-events: all` above the viewport, and it
  // has no click handler of its own — no `onSelectionClick` exists to give it
  // one. Measured before this: the pointer went from the comment bubble to a
  // grab hand and the click did nothing at all, with the tool still armed.
  // The two nodes the edge case seeded are already on the board.
  const a = await author.locator('[data-id="wire-a"]').boundingBox();
  const b = await author.locator('[data-id="wire-b"]').boundingBox();
  if (a === null || b === null) throw new Error('the seeded nodes are gone');

  await author.mouse.move(a.x - 60, a.y - 60);
  await author.mouse.down();
  await author.mouse.move(b.x + b.width + 60, b.y + b.height + 60, {
    steps: 12,
  });
  await author.mouse.up();
  const rect = author.locator('.react-flow__nodesselection-rect');
  await expect(rect).toHaveCount(1, { timeout: SETTLE_MS });
  const box = await rect.boundingBox();
  if (box === null) throw new Error('the selection draws nothing');

  const before = await author.getByTestId('annotation-pin').count();
  await author.getByTestId('tool-comment').click();
  // The gap between the two cards: pane underneath, selection rectangle on top.
  await author.mouse.click(
    a.x + a.width + (b.x - (a.x + a.width)) / 2,
    box.y + box.height / 2,
  );

  const composer = author.getByTestId('annotation-composer-input');
  await expect(composer).toBeVisible({ timeout: SETTLE_MS });
  await author.keyboard.type('these two need work');
  await author.keyboard.press('Enter');
  await expect(author.getByTestId('annotation-pin')).toHaveCount(before + 1, {
    timeout: SETTLE_MS,
  });
});

test('a long rewrite opens showing its end, where the caret is', async () => {
  await openTheNote(author);
  // Past the box's 120px cap the scroller around it decides what is on screen,
  // and the caret sits after the words. jsdom reports 0 for every scroll
  // measurement, so this is only answerable on a browser that laid the box out.
  // Ten lines fill the box's 120px cap several times over at 12px, and land
  // at 269 characters — inside the note's own 300 (`NOTE_MAX_CHARS`), which
  // the box refuses to take more than.
  const long = Array.from(
    { length: 10 },
    (_, i) => `line ${i + 1} wants a cooler grade`,
  ).join('\n');
  await author.getByTestId('annotation-sticky-body-menu').click();
  await author.getByTestId('annotation-sticky-body-edit').click();
  const editing = author.getByTestId('annotation-sticky-body-input');
  await expect(editing).toBeVisible({ timeout: SETTLE_MS });
  await editing.fill(long);
  await author.getByTestId('annotation-sticky-body-save').click();
  await expect(author.getByTestId('annotation-sticky-body')).toContainText(
    'line 10',
    { timeout: SETTLE_MS },
  );

  await author.getByTestId('annotation-sticky-body-menu').click();
  await author.getByTestId('annotation-sticky-body-edit').click();
  const reopened = author.getByTestId('annotation-sticky-body-input');
  await expect(reopened).toBeVisible({ timeout: SETTLE_MS });

  const viewport = author.getByTestId('annotation-sticky-body-scroller');
  await expect
    .poll(() =>
      viewport.evaluate((el) => {
        const scroller = el.querySelector('[data-radix-scroll-area-viewport]');
        if (scroller === null) return -1;
        return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      }),
    )
    .toBeLessThanOrEqual(1);

  await author.getByTestId('annotation-sticky-body-cancel').click();
});

test('a floating panel over the board keeps its own clicks', async () => {
  await closeTheNote(author);
  // Every one of this canvas's floating panels is a `NodeToolbar`, and
  // `NodeToolbarPortal` portals into `.react-flow__renderer` — measured there,
  // `closest('.react-flow__renderer')` is non-null and `closest('.react-flow__
  // pane')` is null. Scoped to the renderer the armed tool ate the panel's
  // clicks: the Group button made no group and opened a note box underneath
  // itself. The group toolbar stands in for all seven here, being the one that
  // needs no generation to appear.
  const a = await author.locator('[data-id="wire-a"]').boundingBox();
  const b = await author.locator('[data-id="wire-b"]').boundingBox();
  if (a === null || b === null) throw new Error('the seeded nodes are gone');
  await author.mouse.move(a.x - 60, a.y - 60);
  await author.mouse.down();
  await author.mouse.move(b.x + b.width + 60, b.y + b.height + 60, {
    steps: 12,
  });
  await author.mouse.up();

  const group = author.getByTestId('group-toolbar-group');
  await expect(group).toBeVisible({ timeout: SETTLE_MS });
  const notes = await author.getByTestId('annotation-pin').count();
  const groups = await author.locator('.react-flow__node-group').count();

  await author.getByTestId('tool-comment').click();
  await group.click();

  await expect(author.locator('.react-flow__node-group')).toHaveCount(
    groups + 1,
    { timeout: SETTLE_MS },
  );
  await expect(author.getByTestId('annotation-composer')).toHaveCount(0);
  await expect(author.getByTestId('annotation-pin')).toHaveCount(notes);
  // The tool is still up: it was never spent.
  await expect(author.getByTestId('tool-comment')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await author.keyboard.press('Escape');
});

test('a thread follows the reply this client just posted', async () => {
  await openTheNote(author);
  // The thread is capped at 180px, which holds about four short replies, and
  // a reply goes on the end. Past the fourth the author posts into a part of
  // the sticky they cannot see.
  const sticky = author.getByTestId('annotation-sticky').first();
  await expect(sticky).toBeVisible({ timeout: SETTLE_MS });
  const box = sticky.getByTestId('annotation-sticky-reply-input');
  for (const line of ['one', 'two', 'three', 'four', 'five', 'six']) {
    await box.click();
    await author.keyboard.type(`reply ${line}`);
    await sticky.getByTestId('annotation-sticky-reply-post').click();
    await expect(sticky.getByTestId('annotation-sticky-replies')).toContainText(
      `reply ${line}`,
      { timeout: SETTLE_MS },
    );
  }

  const seen = await sticky
    .getByTestId('annotation-sticky-replies')
    .evaluate((root) => {
      const viewport = root.querySelector(
        '[data-radix-scroll-area-viewport]',
      ) as HTMLElement;
      const last = viewport.lastElementChild?.lastElementChild as HTMLElement;
      const window_ = viewport.getBoundingClientRect();
      const line = last.getBoundingClientRect();
      return {
        overflows: viewport.scrollHeight > viewport.clientHeight,
        scrollTop: viewport.scrollTop,
        lastInsideWindow:
          line.bottom <= window_.bottom + 1 && line.top >= window_.top - 1,
      };
    });
  expect(seen.overflows).toBe(true);
  expect(seen.scrollTop).toBeGreaterThan(0);
  expect(seen.lastInsideWindow).toBe(true);
});

test('an armed press that drifts lands the note instead of moving the board', async () => {
  await closeTheNote(author);
  // Every gesture here begins at a press, and the two engines listen to
  // different events: xyflow's marquee to a pointer event, everything d3-drag
  // drives (node drags, a Group's drag, the resize grips, the selection
  // rectangle) to `mousedown`. Measured before this, all armed with 3-6px of
  // travel: a Group moved, a Group resized, a multi-selection moved, each with
  // no box and nothing said. A Group is the case a per-node flag cannot reach,
  // because a Group carries its own `draggable`.
  const group = author.locator('.react-flow__node-group');
  await expect(group).toHaveCount(1, { timeout: SETTLE_MS });
  const box = await group.boundingBox();
  if (box === null) throw new Error('the group draws nothing');
  const before = await group.evaluate((el) => (el as HTMLElement).style.transform);
  const notes = await author.getByTestId('annotation-pin').count();

  await author.getByTestId('tool-comment').click();
  // The group's own top edge, clear of the members inside it.
  await author.mouse.move(box.x + box.width / 2, box.y + 8);
  await author.mouse.down();
  await author.mouse.move(box.x + box.width / 2 + 3, box.y + 11, { steps: 3 });
  await author.mouse.up();

  await expect(author.getByTestId('annotation-composer')).toBeVisible({
    timeout: SETTLE_MS,
  });
  expect(
    await group.evaluate((el) => (el as HTMLElement).style.transform),
  ).toBe(before);
  await author.keyboard.press('Escape');
  await expect(author.getByTestId('annotation-pin')).toHaveCount(notes);
});

test('the pin holds its size while the board shrinks under it', async () => {
  // A22 / §8.7.2: a reader zooms out to see which notes still need answering,
  // so the pin cannot shrink with the board. Measured rather than reasoned:
  // the size lives on the node's own box, which is what xyflow measures, and
  // the only way to know the two agree is to look at the screen.
  const pin = author.getByTestId('annotation-pin').first();
  const before = await pin.boundingBox();
  if (before === null) throw new Error('the pin draws nothing');

  await setZoom(author, 25);
  await expect
    .poll(async () => (await pin.boundingBox())?.width ?? 0, {
      timeout: SETTLE_MS,
    })
    .toBeGreaterThan(24);
  const small = await pin.boundingBox();
  if (small === null) throw new Error('the pin draws nothing');
  expect(Math.abs(small.width - before.width)).toBeLessThanOrEqual(2);

  await setZoom(author, 200);
  await expect
    .poll(async () => (await pin.boundingBox())?.width ?? 0, {
      timeout: SETTLE_MS,
    })
    .toBeLessThan(before.width + 2);

  await setZoom(author, 100);
});

test('the minimap draws a note at a patch, not at the block its box measures', async () => {
  // §8.7.2's other half. The minimap paints from the node's measured box in
  // FLOW coordinates, and a pin's box is `28 / zoom` of those — so at 10% zoom
  // every note was a 280-wide block, the size of an image node. Zooming out to
  // survey the board is exactly when somebody opens this map.
  const show = author.getByRole('button', { name: 'Show minimap' });
  if ((await show.count()) > 0) await show.click();
  const map = author.getByTestId('rf__minimap');
  await expect(map).toBeVisible({ timeout: SETTLE_MS });

  /**
   * Every note's rect on the map, in the map's own (flow) units.
   * @returns One entry per note, `[width, height]`.
   */
  const noteRects = async (): Promise<[number, number][]> =>
    map.evaluate((el) =>
      // Notes are the palette's orange slot on this map; nothing else is.
      [...el.querySelectorAll('rect')]
        .filter((r) => r.style.fill.includes('palette-orange'))
        .map((r): [number, number] => [
          Number(r.getAttribute('width')),
          Number(r.getAttribute('height')),
        ]),
    );

  const atHundred = await noteRects();
  expect(atHundred.length).toBeGreaterThan(0);
  expect(atHundred).toEqual(atHundred.map(() => [28, 28]));

  await setZoom(author, 10);
  // Same patch, and the board around it is now ten times its own size.
  await expect.poll(noteRects).toEqual(atHundred);

  await setZoom(author, 100);
  await author.getByRole('button', { name: 'Hide minimap' }).click();
});

// Last, because it destroys the note it works on.
test('a note a collaborator deletes hands the keyboard back to the page', async () => {
  // §6.5's last row. The pin holds the focus while its sticky is open, and a
  // peer's delete unmounts both — so there is nothing left to hand it to and
  // it falls back to `<body>`. jsdom moves `document.activeElement` for
  // neither a press nor an unmount, so every focus reading before round 19
  // came from a browser that was not modelling this at all.
  await closeTheNote(author);
  await closeTheNote(peer);

  // Its own note, so the delete takes nothing the cases above still stand on.
  const had = await noteIds(author);
  await author.getByTestId('tool-comment').click();
  const pane = author.locator('.react-flow__pane');
  const box = await pane.boundingBox();
  if (box === null) throw new Error('the board is not on screen');
  await author.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.25);
  await expect(author.getByTestId('annotation-composer-input')).toBeVisible({
    timeout: SETTLE_MS,
  });
  await author.keyboard.type('somebody will take this away');
  await author.keyboard.press('Enter');
  await expect
    .poll(async () => (await noteIds(author)).length, { timeout: SETTLE_MS })
    .toBe(had.length + 1);
  const doomed = (await noteIds(author)).find((id) => !had.includes(id));
  if (doomed === undefined) throw new Error('the new note has no id');

  // Open it here: the press leaves the focus on the pin, which is the thing
  // the delete is about to take away.
  const mine = `.react-flow__node[data-id="${doomed}"] [data-testid="annotation-pin"]`;
  await author.locator(mine).click();
  await expect(author.getByTestId('annotation-sticky')).toBeVisible({
    timeout: SETTLE_MS,
  });
  expect(
    await author.evaluate(
      () => document.activeElement?.getAttribute('data-testid') ?? '',
    ),
  ).toBe('annotation-pin');

  // The collaborator deletes it the way a person does.
  await expect
    .poll(() => peer.locator(mine).count(), { timeout: SETTLE_MS })
    .toBe(1);
  await peer.locator(mine).click();
  await peer.getByTestId('annotation-sticky-body-menu').click();
  await peer.getByTestId('annotation-sticky-body-delete').click();

  await expect(author.locator(mine)).toHaveCount(0, { timeout: SETTLE_MS });
  await expect(author.getByTestId('annotation-sticky')).toHaveCount(0);
  expect(await author.evaluate(() => document.activeElement?.tagName)).toBe(
    'BODY',
  );
});
