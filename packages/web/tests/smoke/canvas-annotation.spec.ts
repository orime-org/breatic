// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A note crossing the collab server to the other canvas.
 *
 * Every case here has two live connections on one Space and asks what one
 * side sees after the other writes: a note landing, a pin moving, a reply
 * arriving, a rewrite arriving marked as edited, a delete handing the
 * keyboard back. Only a real round trip answers any of them.
 *
 * The cases that measure what a note looks like and how the board answers a
 * pointer are in `tests/visual/canvas-annotation.spec.ts`; both files take
 * their board and their moves from `tests/helpers/annotation-board.ts`.
 *
 * The second connection is a second page on the same account, because nothing
 * here depends on who wrote a line and a second sign-in draws on a rate limit
 * the whole suite shares. The halves that DO depend on the author — A6's
 * missing Edit on somebody else's note, A11's name — are answered by the unit
 * tests, which can hand the component any author.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect } from 'playwright/test';

import {
  SETTLE_MS,
  closeTheNote,
  inFlow,
  landANote,
  noteIds,
  openPeer,
  openTheNote,
} from '../helpers/annotation-board';

test('a note dropped on one canvas turns up on the other', async ({ page }) => {
  const peer = await openPeer(page);
  await page.getByTestId('tool-comment').click();

  const pane = page.locator('.react-flow__pane');
  const box = await pane.boundingBox();
  if (box === null) throw new Error('the canvas pane has no box');
  const at = {
    x: box.x + box.width * 0.45,
    y: box.y + box.height * 0.4,
  };
  const asked = await inFlow(page, at);
  await page.mouse.click(at.x, at.y);

  // A1: the box opens focused where the click landed, and Enter keeps it.
  const composer = page.getByTestId('annotation-composer-input');
  await expect(composer).toBeVisible({ timeout: SETTLE_MS });
  await page.keyboard.type('the shot needs to be slower');
  await page.keyboard.press('Enter');
  await expect(composer).toHaveCount(0);

  // A22: what lands on the board is a pin, wearing the face of whoever raised
  // it. The words are one click away.
  const pin = page.getByTestId('annotation-pin').first();
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
  const tail = await inFlow(page, {
    x: landed.x,
    y: landed.y + landed.height,
  });
  // Within a pixel: the press lands on a whole device pixel while the point
  // asked for carries a fraction, so the two disagree by up to one. Taking
  // the origin line out moves the tail by 28.
  expect(Math.abs(tail.x - asked.x)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(tail.y - asked.y)).toBeLessThanOrEqual(1.5);

  await openTheNote(page);
  await expect(page.getByTestId('annotation-sticky').first()).toContainText('the shot needs to be slower');

  // A12: the other client's canvas follows.
  await expect(peer.getByTestId('annotation-pin').first()).toBeVisible({
    timeout: SETTLE_MS,
  });
  await openTheNote(peer);
  await expect(peer.getByTestId('annotation-sticky').first()).toContainText('the shot needs to be slower');
});

test('the pin drags, and the other canvas follows it', async ({ page }) => {
  const peer = await openPeer(page);
  // The board a case starts on is empty, so this one puts the note it works
  // on there first.
  await landANote(page);
  // A24. Until the note became its pin this was the one thing on the board
  // that could not be moved: the sticky's face was covered in `nodrag`.
  await openTheNote(page);
  const pin = page.getByTestId('annotation-pin').first();
  const from = await pin.boundingBox();
  if (from === null) throw new Error('the pin draws nothing');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // The press has to travel past `nodeDragThreshold` before xyflow starts the
  // drag at all, and `startDrag` anchors the node to wherever the pointer was
  // on THAT event (`@xyflow/system@0.0.79:2199`) — so this nudge is the part
  // of the gesture the node never sees, and everything after it is the part
  // it does. Spelled out rather than left inside a stepped move, where the
  // discarded part would be one step's worth of whatever `steps` happened to
  // be.
  const NUDGE = 4;
  await page.mouse.move(from.x + from.width / 2 + NUDGE, from.y + from.height / 2);
  await page.mouse.move(from.x + 140, from.y + 90, { steps: 12 });
  await page.mouse.up();

  // Both axes: the pin's coordinate is its tail tip (origin [0,1]), so a drag
  // that fed the painted top-left back as the position would move it a pin's
  // height every time — and only the y would show it.
  await expect.poll(async () => (await pin.boundingBox())?.x ?? 0, { timeout: SETTLE_MS }).toBeGreaterThan(from.x + 60);
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
  const sticky = await page.getByTestId('annotation-sticky').boundingBox();
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

test('a reply written on one canvas turns up on the other', async ({ page }) => {
  const peer = await openPeer(page);
  // The board a case starts on is empty, so this one puts the note it works
  // on there first.
  await landANote(page);
  await openTheNote(peer);
  await openTheNote(page);
  // A3 + A19: the row is one full-width box until something is typed, and the
  // two buttons appear under it.
  const replyBox = peer.getByTestId('annotation-sticky-reply-input');
  await expect(replyBox).toBeVisible({ timeout: SETTLE_MS });
  await expect(peer.getByTestId('annotation-sticky-reply-post')).toHaveCount(0);

  await replyBox.click();
  await peer.keyboard.type('agreed, and wider');
  await expect(peer.getByTestId('annotation-sticky-reply-cancel')).toBeVisible();
  await peer.getByTestId('annotation-sticky-reply-post').click();

  await expect(peer.getByTestId('annotation-sticky-replies')).toContainText('agreed, and wider', {
    timeout: SETTLE_MS,
  });
  await expect(page.getByTestId('annotation-sticky-replies')).toContainText('agreed, and wider', {
    timeout: SETTLE_MS,
  });
});

test('a rewrite reaches the other canvas, and it says it was edited', async ({ page }) => {
  const peer = await openPeer(page);
  // The board a case starts on is empty, so this one puts the note it works
  // on there first.
  await landANote(page);
  await openTheNote(page);
  await openTheNote(peer);
  // A4. The menu belongs to the page of the line, and this account wrote
  // the note, so it is here on both pages; the rewrite is done on the page
  // that placed it.
  await page.getByTestId('annotation-sticky-body-menu').click();
  await page.getByTestId('annotation-sticky-body-edit').click();

  const editing = page.getByTestId('annotation-sticky-body-input');
  await expect(editing).toBeVisible({ timeout: SETTLE_MS });
  // The box opens holding what the note says, and the caret sits after it so
  // the next keystroke continues the line (user 2026-09-15). `focus()` leaves
  // the selection where it is and a textarea starts at offset 0, so read this
  // on a real browser — the caret was at the front of the words.
  expect(await editing.evaluate((el) => (el as HTMLTextAreaElement).selectionStart)).toBe(
    'the shot needs to be slower'.length,
  );
  await editing.fill('the shot needs to be slower and wider');
  await page.getByTestId('annotation-sticky-body-save').click();

  await expect(peer.getByTestId('annotation-sticky-body')).toContainText('slower and wider', { timeout: SETTLE_MS });
  await expect(peer.getByTestId('annotation-sticky-body-edited')).toBeVisible({
    timeout: SETTLE_MS,
  });
});

test('the keyboard reaches the reply buttons, and a rewrite keeps its own', async ({ page }) => {
  const peer = await openPeer(page);
  // The board a case starts on is empty, so this one puts the note it works
  // on there first.
  await landANote(page);
  await openTheNote(page);
  await openTheNote(peer);
  // F: Cancel and Post sit after the box in the tab order. Which element a Tab
  // lands on is the browser's own sequential navigation order, and jsdom has
  // none — the unit test can only say the reply survived the blur.
  const replyBox = page.getByTestId('annotation-sticky-reply-input');
  await replyBox.click();
  await page.keyboard.type('one more thing');

  await page.keyboard.press('Tab');
  await expect(page.getByTestId('annotation-sticky-reply-cancel')).toBeFocused();
  await expect(replyBox).toHaveValue('one more thing');

  await page.keyboard.press('Tab');
  await expect(page.getByTestId('annotation-sticky-reply-post')).toBeFocused();

  // A18: the cancel drops it, and nothing reaches the other canvas.
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('annotation-sticky-reply-cancel')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(replyBox).toHaveValue('');
  // Read off the sticky rather than the replies list: a note with no replies
  // draws no list at all, and `not.toContainText` on an element that is not
  // there fails for want of the element.
  await expect(peer.getByTestId('annotation-sticky')).not.toContainText('one more thing');

  // G: the rewrite box's buttons sit under the scroller that caps the words,
  // so a note long enough to fill the cap still shows them. Measured, because
  // "outside that element" is what the unit test can see and "on the screen
  // where the reader is" is what this is for.
  await page.getByTestId('annotation-sticky-body-menu').click();
  await page.getByTestId('annotation-sticky-body-edit').click();
  await page.getByTestId('annotation-sticky-body-input').fill('a long note. '.repeat(80));

  const scroller = page.getByTestId('annotation-sticky-body-scroller');
  const save = page.getByTestId('annotation-sticky-body-save');
  await expect(save).toBeVisible();
  const [scrollerBox, saveBox] = await Promise.all([scroller.boundingBox(), save.boundingBox()]);
  if (scrollerBox === null || saveBox === null) {
    throw new Error('the rewrite box or its scroller has no box');
  }
  expect(saveBox.y).toBeGreaterThanOrEqual(scrollerBox.y + scrollerBox.height);

  await page.getByTestId('annotation-sticky-body-cancel').click();
});

// Last, because it destroys the note it works on.
test('a note a collaborator deletes hands the keyboard back to the page', async ({ page }) => {
  const peer = await openPeer(page);
  // §6.5's last row. The pin holds the focus while its sticky is open, and a
  // peer's delete unmounts both — so there is nothing left to hand it to and
  // it falls back to `<body>`. jsdom moves `document.activeElement` for
  // neither a press nor an unmount, so every focus reading before round 19
  // came from a browser that was not modelling this at all.
  await closeTheNote(page);
  await closeTheNote(peer);

  // Its own note, so the delete takes nothing the cases above still stand on.
  const had = await noteIds(page);
  await page.getByTestId('tool-comment').click();
  const pane = page.locator('.react-flow__pane');
  const box = await pane.boundingBox();
  if (box === null) throw new Error('the board is not on screen');
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.25);
  await expect(page.getByTestId('annotation-composer-input')).toBeVisible({
    timeout: SETTLE_MS,
  });
  await page.keyboard.type('somebody will take this away');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await noteIds(page)).length, { timeout: SETTLE_MS }).toBe(had.length + 1);
  const doomed = (await noteIds(page)).find((id) => !had.includes(id));
  if (doomed === undefined) throw new Error('the new note has no id');

  // Open it here: the press leaves the focus on the pin, which is the thing
  // the delete is about to take away.
  const mine = `.react-flow__node[data-id="${doomed}"] [data-testid="annotation-pin"]`;
  await page.locator(mine).click();
  await expect(page.getByTestId('annotation-sticky')).toBeVisible({
    timeout: SETTLE_MS,
  });
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '')).toBe('annotation-pin');

  // The collaborator deletes it the way a person does.
  await expect.poll(() => peer.locator(mine).count(), { timeout: SETTLE_MS }).toBe(1);
  await peer.locator(mine).click();
  await peer.getByTestId('annotation-sticky-body-menu').click();
  await peer.getByTestId('annotation-sticky-body-delete').click();

  await expect(page.locator(mine)).toHaveCount(0, { timeout: SETTLE_MS });
  await expect(page.getByTestId('annotation-sticky')).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
});
