// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1350 A2–A5, A7: how far the body (or a table's frame) scrolls each
 * frame while something is dragged or a selection is pulled past its edge,
 * and the session that drives it (design §3, §5).
 */

import { describe, it, expect } from 'vitest';

import {
  BodyAutoScroll,
  carriesOutside,
  dragStep,
  pressStep,
  readEdge,
  type EdgeBox,
} from '@web/spaces/document/document-body-autoscroll';

/** A scroller 820 tall at y 80, x 320–1440, in a 1440×900 window. */
const BOX: EdgeBox = { top: 80, bottom: 900, left: 320, right: 1440 };
/** min(820 × 25%, 180) */
const HITBOX = 180;

describe('readEdge', () => {
  it('reads nothing in the middle of the scroller', () => {
    expect(readEdge(BOX, { x: 600, y: 490 }, 'y')).toEqual({ dir: 0, factor: 0, beyond: 0 });
  });

  it('rises linearly across the inner half of the hitbox and is full in the outer half', () => {
    const innerStart = BOX.bottom - HITBOX;
    expect(readEdge(BOX, { x: 600, y: innerStart + HITBOX / 4 }, 'y').factor).toBeCloseTo(0.5);
    expect(readEdge(BOX, { x: 600, y: BOX.bottom - HITBOX / 4 }, 'y')).toEqual({ dir: 1, factor: 1, beyond: 0 });
    expect(readEdge(BOX, { x: 600, y: BOX.top + 10 }, 'y')).toEqual({ dir: -1, factor: 1, beyond: 0 });
  });

  it('reports how far past the edge the pointer is', () => {
    expect(readEdge(BOX, { x: 600, y: 40 }, 'y')).toEqual({ dir: -1, factor: 1, beyond: 40 });
    expect(readEdge(BOX, { x: 600, y: 930 }, 'y')).toEqual({ dir: 1, factor: 1, beyond: 30 });
  });

  it('reads nothing for the body when the pointer is beside it (the Agent column)', () => {
    expect(readEdge(BOX, { x: 200, y: 890 }, 'y')).toEqual({ dir: 0, factor: 0, beyond: 0 });
  });

  it('reads a table frame whatever the pointer\'s height (a column handle sits half above its frame)', () => {
    const frame: EdgeBox = { top: 300, bottom: 500, left: 400, right: 1000 };
    expect(readEdge(frame, { x: 1040, y: 296 }, 'x')).toEqual({ dir: 1, factor: 1, beyond: 40 });
  });
});

describe('dragStep', () => {
  it('is zero with no reading', () => {
    expect(dragStep({ dir: 0, factor: 0, beyond: 0 }, 1000, 16)).toBe(0);
  });

  it('ramps up over 400ms from the first engaged frame', () => {
    const full = { dir: 1 as const, factor: 1, beyond: 0 };
    expect(dragStep(full, 0, 16)).toBe(1);
    expect(dragStep(full, 200, 16)).toBeCloseTo(7.5);
    expect(dragStep(full, 400, 16)).toBe(15);
  });

  it('normalises by frame time inside the hitbox and caps at the 60fps step', () => {
    const full = { dir: -1 as const, factor: 1, beyond: 0 };
    expect(dragStep(full, 1000, 8)).toBe(-8);
    expect(dragStep(full, 1000, 100)).toBe(-15);
  });

  it('scales by the distance factor and never moves less than 1px', () => {
    expect(dragStep({ dir: 1, factor: 0.5, beyond: 0 }, 1000, 16)).toBe(7.5);
    expect(dragStep({ dir: 1, factor: 0.01, beyond: 0 }, 1000, 16)).toBe(1);
  });

  it('beyond the edge moves 15 + 20 + the distance past it every frame', () => {
    expect(dragStep({ dir: 1, factor: 1, beyond: 30 }, 1000, 16)).toBe(65);
    expect(dragStep({ dir: 1, factor: 1, beyond: 30 }, 1000, 8)).toBe(65);
    expect(dragStep({ dir: -1, factor: 1, beyond: 0.5 }, 1000, 16)).toBe(-35.5);
  });

  it('is never slower just past the edge than at full speed inside it', () => {
    const inside = dragStep({ dir: 1, factor: 1, beyond: 0 }, 1000, 16) + 20;
    expect(dragStep({ dir: 1, factor: 1, beyond: 1 }, 1000, 16)).toBeGreaterThanOrEqual(inside);
  });
});

describe('pressStep', () => {
  it('follows Chrome selection autoscroll: 20 − distance inside the band, 20 + distance past it', () => {
    expect(pressStep(BOX, { x: 600, y: 490 })).toBe(0);
    expect(pressStep(BOX, { x: 600, y: BOX.bottom - 5 })).toBe(15);
    expect(pressStep(BOX, { x: 600, y: BOX.bottom + 30 })).toBe(50);
    expect(pressStep(BOX, { x: 600, y: BOX.top + 5 })).toBe(-15);
    expect(pressStep(BOX, { x: 600, y: BOX.top - 10 })).toBe(-30);
  });

  it('does not look at the horizontal position', () => {
    expect(pressStep(BOX, { x: 10, y: BOX.bottom + 30 })).toBe(50);
  });
});

describe('carriesOutside, for a drag from outside the window', () => {
  it('carries on when the pointer left past the edge', () => {
    expect(carriesOutside({ dir: -1, factor: 1, beyond: 30 }, false, false)).toBe(true);
  });

  it('stops for a full-speed reading inside the edge when the edge is not the window edge', () => {
    expect(carriesOutside({ dir: -1, factor: 1, beyond: 0 }, false, false)).toBe(false);
  });

  it('carries on for a full-speed reading when the edge is the window edge', () => {
    expect(carriesOutside({ dir: 1, factor: 1, beyond: 0 }, true, false)).toBe(true);
  });

  it('stops for anything slower or still', () => {
    expect(carriesOutside({ dir: 1, factor: 0.6, beyond: 0 }, true, false)).toBe(false);
    expect(carriesOutside({ dir: 0, factor: 0, beyond: 0 }, true, false)).toBe(false);
  });
});

describe('carriesOutside, for a drag started on the page', () => {
  it('carries on for any reading with a direction, and stops for one without', () => {
    expect(carriesOutside({ dir: 1, factor: 0.2, beyond: 0 }, false, true)).toBe(true);
    expect(carriesOutside({ dir: -1, factor: 1, beyond: 0 }, false, true)).toBe(true);
    expect(carriesOutside({ dir: 0, factor: 0, beyond: 0 }, true, true)).toBe(false);
  });
});

/**
 * A scroller whose box and scroll position the test controls.
 * @param box - Its box.
 * @returns The scroller.
 */
function fakeScroller(box: EdgeBox = BOX): HTMLElement {
  const el = { scrollTop: 0, scrollLeft: 0 } as unknown as HTMLElement;
  el.getBoundingClientRect = (): DOMRect =>
    ({ ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top }) as DOMRect;
  return el;
}

/** What a frame runs. */
type FrameCallback = (time: number) => void;

/** A clock whose frames the test runs by hand. */
interface FakeClock {
  deps: ConstructorParameters<typeof BodyAutoScroll>[0];
  tick: (ms?: number) => void;
  pending: () => number;
}

/**
 * Frames the test runs by hand.
 * @returns The clock.
 */
function fakeClock(): FakeClock {
  let now = 0;
  let next = 1;
  const queue: Map<number, FrameCallback> = new Map();
  return {
    deps: {
      requestFrame: (cb) => {
        const id = next++;
        queue.set(id, cb);
        return id;
      },
      cancelFrame: (id) => {
        queue.delete(id);
      },
      viewport: () => ({ width: 1440, height: 900 }),
    },
    tick: (ms = 16) => {
      now += ms;
      const due = [...queue.entries()];
      queue.clear();
      for (const [, cb] of due) cb(now);
    },
    pending: () => queue.size,
  };
}

describe('BodyAutoScroll', () => {
  it('idle: no frame is scheduled and pointer readings are ignored', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    auto.follow({ x: 600, y: 890 });
    expect(auto.state).toBe('idle');
    expect(clock.pending()).toBe(0);
  });

  it('a drag session scrolls the body down at the bottom edge and stops on end', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const body = fakeScroller();
    auto.beginDrag({ el: body, axis: 'y' });
    auto.follow({ x: 600, y: 890 });
    for (let i = 0; i < 40; i += 1) clock.tick();
    expect(body.scrollTop).toBeGreaterThan(300);
    auto.end();
    expect(auto.state).toBe('idle');
    expect(clock.pending()).toBe(0);
  });

  it('leaving the window past the edge carries on in that direction at the overflow speed', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const body = fakeScroller();
    body.scrollTop = 5000;
    auto.beginDrag({ el: body, axis: 'y' });
    auto.follow({ x: 600, y: 40 });
    for (let i = 0; i < 30; i += 1) clock.tick();
    auto.leaveWindow(false);
    expect(auto.state).toBe('outside');
    const before = body.scrollTop;
    clock.tick();
    expect(before - body.scrollTop).toBe(15 + 20 + 40);
  });

  it('a drag from outside the window that leaves it again from inside the top hitbox stops (Esc cannot be told apart, the top edge is not the window edge)', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const body = fakeScroller();
    body.scrollTop = 5000;
    auto.beginDrag({ el: body, axis: 'y' });
    auto.follow({ x: 600, y: BOX.top + 10 });
    for (let i = 0; i < 30; i += 1) clock.tick();
    auto.leaveWindow(false);
    const before = body.scrollTop;
    clock.tick();
    expect(body.scrollTop).toBe(before);
  });

  it('leaving the window from the full-speed half of the bottom hitbox carries on (the bottom edge is the window edge)', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const body = fakeScroller();
    auto.beginDrag({ el: body, axis: 'y' });
    auto.follow({ x: 600, y: 895 });
    for (let i = 0; i < 30; i += 1) clock.tick();
    auto.leaveWindow(false);
    const before = body.scrollTop;
    clock.tick();
    expect(body.scrollTop).toBeGreaterThan(before);
  });

  it('a drag started on the page carries on out of the window from the top hitbox, though the top edge is not the window edge', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const body = fakeScroller();
    body.scrollTop = 5000;
    auto.beginDrag({ el: body, axis: 'y' });
    auto.follow({ x: 600, y: BOX.top + 10 });
    for (let i = 0; i < 30; i += 1) clock.tick();
    auto.leaveWindow(true);
    const before = body.scrollTop;
    clock.tick();
    expect(body.scrollTop).toBeLessThan(before);
  });

  it('a drag started on the page carries on out of the window from the inner half of the bottom hitbox', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const body = fakeScroller();
    auto.beginDrag({ el: body, axis: 'y' });
    auto.follow({ x: 600, y: BOX.bottom - 150 });
    for (let i = 0; i < 30; i += 1) clock.tick();
    auto.leaveWindow(true);
    const before = body.scrollTop;
    clock.tick();
    expect(body.scrollTop).toBeGreaterThan(before);
  });

  it('a column dragged on the page carries the table frame on out of the window from its hitbox, the frame inside the window', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const frame = fakeScroller({ top: 300, bottom: 500, left: 400, right: 968 });
    auto.beginDrag({ el: frame, axis: 'x' });
    auto.follow({ x: 950, y: 400 });
    for (let i = 0; i < 30; i += 1) clock.tick();
    auto.leaveWindow(true);
    const before = frame.scrollLeft;
    clock.tick();
    expect(frame.scrollLeft).toBeGreaterThan(before);
  });

  it('a drag started on the page that leaves the window from the middle stops: there is no direction to go on in', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const body = fakeScroller();
    body.scrollTop = 500;
    auto.beginDrag({ el: body, axis: 'y' });
    auto.follow({ x: 600, y: 490 });
    clock.tick();
    auto.leaveWindow(true);
    const before = body.scrollTop;
    clock.tick();
    expect(body.scrollTop).toBe(before);
  });

  it('a pointer reading after leaving brings the session back to tracking', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    auto.beginDrag({ el: fakeScroller(), axis: 'y' });
    auto.follow({ x: 600, y: 895 });
    auto.leaveWindow(false);
    auto.follow({ x: 600, y: 490 });
    expect(auto.state).toBe('tracking');
  });

  it('a column drag scrolls the table frame sideways whatever the pointer\'s height, and never vertically', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const frame = fakeScroller({ top: 300, bottom: 500, left: 400, right: 1000 });
    auto.beginDrag({ el: frame, axis: 'x' });
    auto.follow({ x: 1040, y: 296 });
    for (let i = 0; i < 30; i += 1) clock.tick();
    expect(frame.scrollLeft).toBeGreaterThan(0);
    expect(frame.scrollTop).toBe(0);
  });

  it('a press session follows the Chrome formula with no hitbox ramp', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const body = fakeScroller();
    auto.beginPress(body, { x: 10, y: 400 });
    auto.follow({ x: 10, y: BOX.bottom + 30 });
    clock.tick();
    expect(body.scrollTop).toBe(50);
  });

  it('a drag starting while a press session runs replaces it', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const body = fakeScroller();
    auto.beginPress(body, { x: 10, y: 400 });
    auto.beginDrag({ el: body, axis: 'y' });
    expect(auto.source).toBe('drag');
    expect(clock.pending()).toBeLessThanOrEqual(1);
  });

  it('a press end does not end a drag session', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    auto.beginDrag({ el: fakeScroller(), axis: 'y' });
    auto.end('press');
    expect(auto.state).toBe('tracking');
  });

  it('ramps from the moment the pointer is over the scroller, as Pragmatic does, not from entering the hitbox', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const body = fakeScroller();
    auto.beginDrag({ el: body, axis: 'y' });
    // Over the middle for 640ms: past the 400ms ramp before any edge is near.
    auto.follow({ x: 600, y: 490 });
    for (let i = 0; i < 40; i += 1) clock.tick();
    auto.follow({ x: 600, y: 895 });
    const before = body.scrollTop;
    clock.tick();
    expect(body.scrollTop - before).toBe(15);
  });

  it('keeps the ramp while the pointer goes from the edge back to the middle and out again', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const body = fakeScroller();
    auto.beginDrag({ el: body, axis: 'y' });
    auto.follow({ x: 600, y: 895 });
    for (let i = 0; i < 40; i += 1) clock.tick();
    auto.follow({ x: 600, y: 490 });
    clock.tick();
    auto.follow({ x: 600, y: 895 });
    const before = body.scrollTop;
    clock.tick();
    expect(body.scrollTop - before).toBe(15);
  });

  it('restarts the ramp only after the pointer leaves the scroller (over the Agent column beside it)', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const body = fakeScroller();
    auto.beginDrag({ el: body, axis: 'y' });
    auto.follow({ x: 600, y: 895 });
    for (let i = 0; i < 40; i += 1) clock.tick();
    auto.follow({ x: BOX.left - 100, y: 895 });
    clock.tick();
    auto.follow({ x: 600, y: 895 });
    const before = body.scrollTop;
    clock.tick();
    expect(body.scrollTop - before).toBe(1);
  });
});

describe('BodyAutoScroll, the latest pointer (inner#1350 round 2)', () => {
  it('reads the last dragover when the pointer leaves the window, though no frame has run since', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const body = fakeScroller();
    body.scrollTop = 5000;
    auto.beginDrag({ el: body, axis: 'y' });
    auto.follow({ x: 600, y: 400 });
    clock.tick();
    // Over the top bar, and straight out of the window within the same frame.
    auto.follow({ x: 600, y: 40 });
    auto.leaveWindow(false);
    for (let i = 0; i < 10; i += 1) clock.tick();
    expect(body.scrollTop).toBeLessThan(5000);
  });

  it('ramps outside the window from the moment the pointer came over the scroller, though no frame read the edge', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const body = fakeScroller();
    body.scrollTop = 50_000;
    auto.beginDrag({ el: body, axis: 'y' });
    auto.follow({ x: 600, y: 400 });
    clock.tick();
    auto.follow({ x: 600, y: 40 });
    auto.leaveWindow(false);
    const start = body.scrollTop;
    clock.tick();
    // 16ms into the ramp: 4% of (15 + 20 + 40 past the top edge).
    expect(start - body.scrollTop).toBe(3);
    for (let i = 0; i < 60; i += 1) clock.tick();
    const before = body.scrollTop;
    clock.tick();
    // Past the top edge by 40: Chrome's selection step plus the hitbox's maximum.
    expect(before - body.scrollTop).toBe(75);
  });

  it('starts the ramp outside the window when the pointer left before any frame', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const body = fakeScroller();
    body.scrollTop = 50_000;
    auto.beginDrag({ el: body, axis: 'y' });
    auto.follow({ x: 600, y: 40 });
    auto.leaveWindow(false);
    const start = body.scrollTop;
    clock.tick();
    expect(start - body.scrollTop).toBe(1);
    for (let i = 0; i < 60; i += 1) clock.tick();
    const before = body.scrollTop;
    clock.tick();
    expect(before - body.scrollTop).toBe(75);
  });

  it('does not scroll a pulled selection that has no pointer yet', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const body = fakeScroller();
    auto.beginPress(body, null);
    for (let i = 0; i < 5; i += 1) clock.tick();
    expect(body.scrollTop).toBe(0);
  });

  it('starts a pulled selection from the point it was pressed at', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const body = fakeScroller();
    auto.beginPress(body, { x: 600, y: 930 });
    for (let i = 0; i < 5; i += 1) clock.tick();
    expect(body.scrollTop).toBeGreaterThan(0);
  });
});
