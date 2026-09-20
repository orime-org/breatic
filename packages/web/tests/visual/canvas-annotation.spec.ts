// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a note looks like on the board, and what the board does under a
 * pointer while the tool is armed.
 *
 * Each case here drives one canvas: where the sticky hangs off its pin, which
 * element a Tab lands on, what a small slip does, which of two overlapping
 * things takes a click, where the minimap draws a patch. None of them needs a
 * second connection.
 *
 * The cases that watch a note cross to another connection are in
 * `tests/smoke/canvas-annotation.spec.ts`; both files take their board and
 * their moves from `tests/helpers/annotation-board.ts`.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   pnpm --filter @breatic/web test:visual
 */
import { test, expect } from 'playwright/test';

import {
  SETTLE_MS,
  landANote,
  makeAGroup,
  closeTheNote,
  dropNote,
  noteIds,
  openTheNote,
  seedWiredPair,
  setZoom,
} from '../helpers/annotation-board';

test('the armed tool says so on the button and under the pointer', async ({ page }) => {
  const comment = page.getByTestId('tool-comment');
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
  const pane = page.locator('.react-flow__pane');
  const box = await pane.boundingBox();
  if (box === null) throw new Error('the board is not on screen');
  const spot: [number, number] = [box.x + 300, box.y + box.height - 140];
  /**
   * The cursor of the topmost element over the board.
   * @returns The computed cursor there.
   */
  const pointerOverTheBoard = async (): Promise<string> =>
    page.evaluate(([x, y]: [number, number]) => {
      const el = document.elementFromPoint(x, y);
      return el === null ? '' : getComputedStyle(el).cursor;
    }, spot);

  await expect.poll(pointerOverTheBoard, { timeout: SETTLE_MS }).toContain('url(');

  // The tool is spent on the click that says where, and the button goes dark
  // with it (A16's second half).
  await page.keyboard.press('Escape');
  await expect(comment).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(pointerOverTheBoard).not.toContain('url(');
});

test('the sticky hangs off the pin the way the demo has it', async ({ page }) => {
  // The board a case starts on is empty, so this one puts the note it works
  // on there first.
  await landANote(page);
  // Two decisions from the demo, both structural: their top edges are level,
  // and the gap between them is 8px. Centred instead — which is what
  // NodeToolbar does by default — a 280px sticky hung 126px above the point
  // somebody was pointing at.
  await openTheNote(page);
  const pin = await page.getByTestId('annotation-pin').first().boundingBox();
  const sticky = await page.getByTestId('annotation-sticky').boundingBox();
  if (pin === null || sticky === null) throw new Error('nothing to measure');
  expect(sticky.y).toBeCloseTo(pin.y, 0);
  expect(sticky.x - (pin.x + pin.width)).toBeCloseTo(8, 0);
});

test('a small slip on the pin opens the note instead of moving it', async ({ page }) => {
  // The board a case starts on is empty, so this one puts the note it works
  // on there first.
  await landANote(page);
  // §8.7.3: opening and dragging share one press, and the library's own
  // threshold is a single pixel — at which a trackpad click both wrote the
  // note a new position and had its click swallowed by d3-drag.
  const pin = page.getByTestId('annotation-pin').first();
  const at = await pin.boundingBox();
  if (at === null) throw new Error('the pin draws nothing');
  // Start closed, so the press has an outcome to show.
  if ((await page.getByTestId('annotation-sticky').count()) > 0) {
    await pin.click();
  }
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  await page.mouse.move(at.x + at.width / 2 + 2, at.y + at.height / 2 + 1);
  await page.mouse.up();

  await expect(page.getByTestId('annotation-sticky')).toBeVisible({
    timeout: SETTLE_MS,
  });
  const after = await pin.boundingBox();
  if (after === null) throw new Error('the pin draws nothing');
  expect(Math.abs(after.x - at.x)).toBeLessThanOrEqual(1);
});

test('the keyboard opens a note, without a pointer anywhere', async ({ page }) => {
  // The board a case starts on is empty, so this one puts the note it works
  // on there first.
  await landANote(page);
  // A25 / D1: xyflow's own key handling calls `handleNodeClick` on Enter and
  // never `onClick`, so a pin that only answered clicks would leave three of
  // this task's four verbs out of reach from the keyboard.
  await closeTheNote(page);
  const pin = page.getByTestId('annotation-pin').first();
  // xyflow makes every node wrapper a tab stop of its own, and Enter there
  // only selects the node — measured on a board, the sticky stayed shut. The
  // pin's button is the one stop for a note, so tabbing back onto it from its
  // neighbour lands on the button itself, not on a wrapper in between.
  expect(await pin.evaluate((el) => el.closest('.react-flow__node')?.getAttribute('tabindex'))).toBeNull();
  await pin.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(pin).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(page.getByTestId('annotation-sticky')).toBeVisible({
    timeout: SETTLE_MS,
  });
});

test('Escape collapses the note, and the draft box goes first', async ({ page }) => {
  // The board a case starts on is empty, so this one puts the note it works
  // on there first.
  await landANote(page);
  // §8.7.3. A pin is not one of xyflow's focus stops, so the library's own
  // "Escape unselects the focused node" never runs for a note — measured on a
  // board before the panel took the key itself, the sticky stayed open on
  // every press. The first press belongs to whatever box has something to
  // drop, so a reply half typed is not thrown away by the key that closes.
  await openTheNote(page);
  const replyBox = page.getByTestId('annotation-sticky-reply-input');
  await replyBox.click();
  await page.keyboard.type('not finished');
  await page.keyboard.press('Escape');
  await expect(replyBox).toHaveValue('');
  await expect(page.getByTestId('annotation-sticky')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('annotation-sticky')).toHaveCount(0, {
    timeout: SETTLE_MS,
  });
});

test('a wire is board too: the armed tool lands a note on an edge', async ({ page }) => {
  await closeTheNote(page);
  // xyflow routes a click on a wire to its own handler, not to the pane's, so
  // the pointer said "you can drop here" everywhere the wires run while the
  // click did nothing. jsdom renders no edges to click.
  await seedWiredPair(page);

  // The wire is an SVG group with no layout box of its own, so aim at the
  // middle of the path it draws.
  const wire = page.locator('.react-flow__edge-path').first();
  await expect.poll(() => wire.count(), { timeout: SETTLE_MS }).toBeGreaterThan(0);
  const box = await wire.boundingBox();
  if (box === null) throw new Error('the wire draws nothing');
  const before = await page.getByTestId('annotation-pin').count();

  await page.getByTestId('tool-comment').click();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const composer = page.getByTestId('annotation-composer-input');
  await expect(composer).toBeVisible({ timeout: SETTLE_MS });
  await page.keyboard.type('this wire is wrong');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('annotation-pin')).toHaveCount(before + 1, {
    timeout: SETTLE_MS,
  });
});

test('the box being typed into is on top of the notes already on the board', async ({ page }) => {
  // Reported from a board: two existing pins painted over the box somebody was
  // typing into. Stacking is the one thing jsdom computes nothing for, so it
  // is only answerable here — and `elementFromPoint` answers it the way the
  // pointer does, by asking who is actually on top.
  //
  // The pin that has to be under the box is put there first: the board a case
  // starts on is empty.
  await landANote(page);
  await closeTheNote(page);
  const pin = page.getByTestId('annotation-pin').first();
  const onScreen = await pin.boundingBox();
  if (onScreen === null) throw new Error('no pin on the board');
  const had = await noteIds(page);

  // The box hangs down-right of the point that was clicked, so clicking
  // above-left of the pin puts the pin inside the box's own rectangle —
  // measured: clicking 40 left and 30 up of a pin at (787,386) opens a box at
  // (760,370) 200x66, which covers the pin whole.
  await page.getByTestId('tool-comment').click();
  await page.mouse.click(onScreen.x - 40, onScreen.y - 30);
  const composer = page.getByTestId('annotation-composer-input');
  await expect(composer).toBeVisible({ timeout: SETTLE_MS });

  // Asked positively: whatever is on top at the pin's own centre has to be
  // part of the box. "Not the pin" is the assertion that let this through
  // once — the element on top there was the pin's AVATAR, a different id.
  const topmost = await page.evaluate(
    ([x, y]: [number, number]) => {
      const el = document.elementFromPoint(x, y);
      if (el === null) return '(nothing)';
      const box = el.closest('[data-testid="annotation-composer"]');
      if (box !== null) return 'inside the box';
      return el.closest('[data-testid]')?.getAttribute('data-testid') ?? el.tagName;
    },
    [onScreen.x + onScreen.width / 2, onScreen.y + onScreen.height / 2] as [number, number],
  );
  expect(topmost).toBe('inside the box');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('annotation-composer-input')).toHaveCount(0);
  expect(await noteIds(page)).toEqual(had);
});

test('a note stops accepting characters at the cap', async ({ page }) => {
  // `maxLength` is the platform refusing the 301st character, and jsdom writes
  // a value straight past the attribute — so the refusal itself is only
  // readable here. 300 is the number chosen for a note (user 2026-09-16).
  await closeTheNote(page);
  const had = await noteIds(page);
  await page.getByTestId('tool-comment').click();
  const pane = await page.locator('.react-flow__pane').boundingBox();
  if (pane === null) throw new Error('no pane');
  await page.mouse.click(pane.x + pane.width * 0.3, pane.y + pane.height * 0.6);
  const box = page.getByTestId('annotation-composer-input');
  await expect(box).toBeVisible({ timeout: SETTLE_MS });

  // Pasted rather than typed: the path a long note actually arrives by, and
  // the one `maxLength` has to hold.
  await box.fill('x'.repeat(400));
  expect(await box.inputValue()).toHaveLength(300);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('annotation-composer-input')).toHaveCount(0);
  expect(await noteIds(page)).toEqual(had);
});

test('a pin is board too while the tool is armed: the click lands a new note', async ({ page }) => {
  // The §8.7.3 row "armed, pressing this pin" says the pin does not open and
  // a second note goes down at that point, and the reason given is stacking:
  // the drop layer is the hit target over the whole board, pins included.
  // Stacking is the one thing jsdom computes nothing for, so the claim can
  // only be read here.
  //
  // The pin to press is put there first: the board a case starts on is empty.
  await landANote(page);
  await closeTheNote(page);
  const pin = page.getByTestId('annotation-pin').first();
  const box = await pin.boundingBox();
  if (box === null) throw new Error('no pin on the board');
  const had = await noteIds(page);

  await page.getByTestId('tool-comment').click();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const composer = page.getByTestId('annotation-composer-input');
  await expect(composer).toBeVisible({ timeout: SETTLE_MS });
  // The pin it was aimed at stayed shut: one press says one thing.
  await expect(page.getByTestId('annotation-sticky')).toHaveCount(0);

  await page.keyboard.type('and another thing');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await noteIds(page)).length, { timeout: SETTLE_MS }).toBe(had.length + 1);

  // It landed on top of the pin it was aimed at, which is the point — and it
  // is also a lid over that pin for every case after this one.
  const landed = (await noteIds(page)).find((id) => !had.includes(id));
  if (landed === undefined) throw new Error('the new note has no id');
  await dropNote(page, landed);
});

test('a marquee selection is board too, not a dead rectangle', async ({ page }) => {
  await closeTheNote(page);
  // xyflow lays `.react-flow__nodesselection-rect` over the selected nodes and
  // the gaps between them, at `pointer-events: all` above the viewport, and it
  // has no click handler of its own — no `onSelectionClick` exists to give it
  // one. Measured before this: the pointer went from the comment bubble to a
  // grab hand and the click did nothing at all, with the tool still armed.
  //
  // Two nodes with a wire between them, which is what a marquee has to draw
  // its rectangle over.
  await seedWiredPair(page);
  const a = await page.locator('[data-id="wire-a"]').boundingBox();
  const b = await page.locator('[data-id="wire-b"]').boundingBox();
  if (a === null || b === null) throw new Error('the seeded nodes are gone');

  await page.mouse.move(a.x - 60, a.y - 60);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width + 60, b.y + b.height + 60, {
    steps: 12,
  });
  await page.mouse.up();
  const rect = page.locator('.react-flow__nodesselection-rect');
  await expect(rect).toHaveCount(1, { timeout: SETTLE_MS });
  const box = await rect.boundingBox();
  if (box === null) throw new Error('the selection draws nothing');

  const before = await page.getByTestId('annotation-pin').count();
  await page.getByTestId('tool-comment').click();
  // The gap between the two cards: pane underneath, selection rectangle on top.
  await page.mouse.click(a.x + a.width + (b.x - (a.x + a.width)) / 2, box.y + box.height / 2);

  const composer = page.getByTestId('annotation-composer-input');
  await expect(composer).toBeVisible({ timeout: SETTLE_MS });
  await page.keyboard.type('these two need work');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('annotation-pin')).toHaveCount(before + 1, {
    timeout: SETTLE_MS,
  });
});

test('a long rewrite opens showing its end, where the caret is', async ({ page }) => {
  // The board a case starts on is empty, so this one puts the note it works
  // on there first.
  await landANote(page);
  await openTheNote(page);
  // Past the box's 120px cap the scroller around it decides what is on screen,
  // and the caret sits after the words. jsdom reports 0 for every scroll
  // measurement, so this is only answerable on a browser that laid the box out.
  // Ten lines fill the box's 120px cap several times over at 12px, and land
  // at 269 characters — inside the note's own 300 (`NOTE_MAX_CHARS`), which
  // the box refuses to take more than.
  const long = Array.from({ length: 10 }, (_, i) => `line ${i + 1} wants a cooler grade`).join('\n');
  await page.getByTestId('annotation-sticky-body-menu').click();
  await page.getByTestId('annotation-sticky-body-edit').click();
  const editing = page.getByTestId('annotation-sticky-body-input');
  await expect(editing).toBeVisible({ timeout: SETTLE_MS });
  await editing.fill(long);
  await page.getByTestId('annotation-sticky-body-save').click();
  await expect(page.getByTestId('annotation-sticky-body')).toContainText('line 10', { timeout: SETTLE_MS });

  await page.getByTestId('annotation-sticky-body-menu').click();
  await page.getByTestId('annotation-sticky-body-edit').click();
  const reopened = page.getByTestId('annotation-sticky-body-input');
  await expect(reopened).toBeVisible({ timeout: SETTLE_MS });

  const viewport = page.getByTestId('annotation-sticky-body-scroller');
  await expect
    .poll(() =>
      viewport.evaluate((el) => {
        const scroller = el.querySelector('[data-radix-scroll-area-viewport]');
        if (scroller === null) return -1;
        return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      }),
    )
    .toBeLessThanOrEqual(1);

  await page.getByTestId('annotation-sticky-body-cancel').click();
});

test('a floating panel over the board keeps its own clicks', async ({ page }) => {
  await closeTheNote(page);
  // Every one of this canvas's floating panels is a `NodeToolbar`, and
  // `NodeToolbarPortal` portals into `.react-flow__renderer` — measured there,
  // `closest('.react-flow__renderer')` is non-null and `closest('.react-flow__
  // pane')` is null. Scoped to the renderer the armed tool ate the panel's
  // clicks: the Group button made no group and opened a note box underneath
  // itself. The group toolbar stands in for all seven here, being the one that
  // needs no generation to appear.
  //
  // Two nodes to marquee over, which is what raises that toolbar.
  await seedWiredPair(page);
  const a = await page.locator('[data-id="wire-a"]').boundingBox();
  const b = await page.locator('[data-id="wire-b"]').boundingBox();
  if (a === null || b === null) throw new Error('the seeded nodes are gone');
  await page.mouse.move(a.x - 60, a.y - 60);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width + 60, b.y + b.height + 60, {
    steps: 12,
  });
  await page.mouse.up();

  const group = page.getByTestId('group-toolbar-group');
  await expect(group).toBeVisible({ timeout: SETTLE_MS });
  const notes = await page.getByTestId('annotation-pin').count();
  const groups = await page.locator('.react-flow__node-group').count();

  await page.getByTestId('tool-comment').click();
  await group.click();

  await expect(page.locator('.react-flow__node-group')).toHaveCount(groups + 1, { timeout: SETTLE_MS });
  await expect(page.getByTestId('annotation-composer')).toHaveCount(0);
  await expect(page.getByTestId('annotation-pin')).toHaveCount(notes);
  // The tool is still up: it was never spent.
  await expect(page.getByTestId('tool-comment')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
});

test('a thread follows the reply this client just posted', async ({ page }) => {
  // The board a case starts on is empty, so this one puts the note it works
  // on there first.
  await landANote(page);
  await openTheNote(page);
  // The thread is capped at 180px, which holds about four short replies, and
  // a reply goes on the end. Past the fourth the page posts into a part of
  // the sticky they cannot see.
  const sticky = page.getByTestId('annotation-sticky').first();
  await expect(sticky).toBeVisible({ timeout: SETTLE_MS });
  const box = sticky.getByTestId('annotation-sticky-reply-input');
  for (const line of ['one', 'two', 'three', 'four', 'five', 'six']) {
    await box.click();
    await page.keyboard.type(`reply ${line}`);
    await sticky.getByTestId('annotation-sticky-reply-post').click();
    await expect(sticky.getByTestId('annotation-sticky-replies')).toContainText(`reply ${line}`, {
      timeout: SETTLE_MS,
    });
  }

  const seen = await sticky.getByTestId('annotation-sticky-replies').evaluate((root) => {
    const viewport = root.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    const last = viewport.lastElementChild?.lastElementChild as HTMLElement;
    const window_ = viewport.getBoundingClientRect();
    const line = last.getBoundingClientRect();
    return {
      overflows: viewport.scrollHeight > viewport.clientHeight,
      scrollTop: viewport.scrollTop,
      lastInsideWindow: line.bottom <= window_.bottom + 1 && line.top >= window_.top - 1,
    };
  });
  expect(seen.overflows).toBe(true);
  expect(seen.scrollTop).toBeGreaterThan(0);
  expect(seen.lastInsideWindow).toBe(true);
});

test('an armed press that drifts lands the note instead of moving the board', async ({ page }) => {
  await closeTheNote(page);
  // Every gesture here begins at a press, and the two engines listen to
  // different events: xyflow's marquee to a pointer event, everything d3-drag
  // drives (node drags, a Group's drag, the resize grips, the selection
  // rectangle) to `mousedown`. Measured before this, all armed with 3-6px of
  // travel: a Group moved, a Group resized, a multi-selection moved, each with
  // no box and nothing said. A Group is the case a per-node flag cannot reach,
  // because a Group carries its own `draggable`.
  //
  // The group to press is put there first: the board a case starts on is
  // empty.
  await makeAGroup(page);
  const group = page.locator('.react-flow__node-group');
  await expect(group).toHaveCount(1, { timeout: SETTLE_MS });
  const box = await group.boundingBox();
  if (box === null) throw new Error('the group draws nothing');
  const before = await group.evaluate((el) => (el as HTMLElement).style.transform);
  const notes = await page.getByTestId('annotation-pin').count();

  await page.getByTestId('tool-comment').click();
  // The group's own top edge, clear of the members inside it.
  await page.mouse.move(box.x + box.width / 2, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 3, box.y + 11, { steps: 3 });
  await page.mouse.up();

  await expect(page.getByTestId('annotation-composer')).toBeVisible({
    timeout: SETTLE_MS,
  });
  expect(await group.evaluate((el) => (el as HTMLElement).style.transform)).toBe(before);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('annotation-pin')).toHaveCount(notes);
});

test('the pin holds its size while the board shrinks under it', async ({ page }) => {
  // The board a case starts on is empty, so this one puts the note it works
  // on there first.
  await landANote(page);
  // A22 / §8.7.2: a reader zooms out to see which notes still need answering,
  // so the pin cannot shrink with the board. Measured rather than reasoned:
  // the size lives on the node's own box, which is what xyflow measures, and
  // the only way to know the two agree is to look at the screen.
  const pin = page.getByTestId('annotation-pin').first();
  const before = await pin.boundingBox();
  if (before === null) throw new Error('the pin draws nothing');

  await setZoom(page, 25);
  await expect
    .poll(async () => (await pin.boundingBox())?.width ?? 0, {
      timeout: SETTLE_MS,
    })
    .toBeGreaterThan(24);
  const small = await pin.boundingBox();
  if (small === null) throw new Error('the pin draws nothing');
  expect(Math.abs(small.width - before.width)).toBeLessThanOrEqual(2);

  await setZoom(page, 200);
  await expect
    .poll(async () => (await pin.boundingBox())?.width ?? 0, {
      timeout: SETTLE_MS,
    })
    .toBeLessThan(before.width + 2);

  await setZoom(page, 100);
});

test('the minimap draws a note at a patch, not at the block its box measures', async ({ page }) => {
  // §8.7.2's other half. The minimap paints from the node's measured box in
  // FLOW coordinates, and a pin's box is `28 / zoom` of those — so at 10% zoom
  // every note was a 280-wide block, the size of an image node. Zooming out to
  // survey the board is exactly when somebody opens this map.
  //
  // A note for the map to draw: the board a case starts on is empty.
  await landANote(page);
  const show = page.getByRole('button', { name: 'Show minimap' });
  if ((await show.count()) > 0) await show.click();
  const map = page.getByTestId('rf__minimap');
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
        .map((r): [number, number] => [Number(r.getAttribute('width')), Number(r.getAttribute('height'))]),
    );

  const atHundred = await noteRects();
  expect(atHundred.length).toBeGreaterThan(0);
  expect(atHundred).toEqual(atHundred.map(() => [28, 28]));

  await setZoom(page, 10);
  // Same patch, and the board around it is now ten times its own size.
  await expect.poll(noteRects).toEqual(atHundred);

  await setZoom(page, 100);
  await page.getByRole('button', { name: 'Hide minimap' }).click();
});
