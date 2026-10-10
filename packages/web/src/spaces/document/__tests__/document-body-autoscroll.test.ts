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
    expect(readEdge(BOX, { x: 600, y: 490 }, 'y', true)).toEqual({ dir: 0, factor: 0, beyond: 0 });
  });

  it('rises linearly across the inner half of the hitbox and is full in the outer half', () => {
    const innerStart = BOX.bottom - HITBOX;
    expect(readEdge(BOX, { x: 600, y: innerStart + HITBOX / 4 }, 'y', true).factor).toBeCloseTo(0.5);
    expect(readEdge(BOX, { x: 600, y: BOX.bottom - HITBOX / 4 }, 'y', true)).toEqual({ dir: 1, factor: 1, beyond: 0 });
    expect(readEdge(BOX, { x: 600, y: BOX.top + 10 }, 'y', true)).toEqual({ dir: -1, factor: 1, beyond: 0 });
  });

  it('reports how far past the edge the pointer is', () => {
    expect(readEdge(BOX, { x: 600, y: 40 }, 'y', true)).toEqual({ dir: -1, factor: 1, beyond: 40 });
    expect(readEdge(BOX, { x: 600, y: 930 }, 'y', true)).toEqual({ dir: 1, factor: 1, beyond: 30 });
  });

  it('reads nothing when the gated other axis is outside the scroller (the Agent column)', () => {
    expect(readEdge(BOX, { x: 200, y: 890 }, 'y', true)).toEqual({ dir: 0, factor: 0, beyond: 0 });
  });

  it('ignores the other axis when not gated (a column handle sits half above its frame)', () => {
    const frame: EdgeBox = { top: 300, bottom: 500, left: 400, right: 1000 };
    expect(readEdge(frame, { x: 1040, y: 296 }, 'x', false)).toEqual({ dir: 1, factor: 1, beyond: 40 });
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

describe('carriesOutside', () => {
  it('carries on when the last frame was past the edge', () => {
    expect(carriesOutside({ dir: -1, factor: 1, beyond: 30 }, false)).toBe(true);
  });

  it('stops for a full-speed reading inside the edge when the edge is not the window edge', () => {
    expect(carriesOutside({ dir: -1, factor: 1, beyond: 0 }, false)).toBe(false);
  });

  it('carries on for a full-speed reading when the edge is the window edge', () => {
    expect(carriesOutside({ dir: 1, factor: 1, beyond: 0 }, true)).toBe(true);
  });

  it('stops for anything slower or still', () => {
    expect(carriesOutside({ dir: 1, factor: 0.6, beyond: 0 }, true)).toBe(false);
    expect(carriesOutside({ dir: 0, factor: 0, beyond: 0 }, true)).toBe(false);
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
    auto.beginDrag({ el: body, axis: 'y', gate: true });
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
    auto.beginDrag({ el: body, axis: 'y', gate: true });
    auto.follow({ x: 600, y: 40 });
    for (let i = 0; i < 30; i += 1) clock.tick();
    auto.leaveWindow();
    expect(auto.state).toBe('outside');
    const before = body.scrollTop;
    clock.tick();
    expect(before - body.scrollTop).toBe(15 + 20 + 40);
  });

  it('leaving the window from inside the top hitbox stops (Esc cannot be told apart, the top edge is not the window edge)', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const body = fakeScroller();
    body.scrollTop = 5000;
    auto.beginDrag({ el: body, axis: 'y', gate: true });
    auto.follow({ x: 600, y: BOX.top + 10 });
    for (let i = 0; i < 30; i += 1) clock.tick();
    auto.leaveWindow();
    const before = body.scrollTop;
    clock.tick();
    expect(body.scrollTop).toBe(before);
  });

  it('leaving the window from the full-speed half of the bottom hitbox carries on (the bottom edge is the window edge)', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const body = fakeScroller();
    auto.beginDrag({ el: body, axis: 'y', gate: true });
    auto.follow({ x: 600, y: 895 });
    for (let i = 0; i < 30; i += 1) clock.tick();
    auto.leaveWindow();
    const before = body.scrollTop;
    clock.tick();
    expect(body.scrollTop).toBeGreaterThan(before);
  });

  it('a pointer reading after leaving brings the session back to tracking', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    auto.beginDrag({ el: fakeScroller(), axis: 'y', gate: true });
    auto.follow({ x: 600, y: 895 });
    auto.leaveWindow();
    auto.follow({ x: 600, y: 490 });
    expect(auto.state).toBe('tracking');
  });

  it('a column drag scrolls the table frame sideways, ungated, and leaves the body alone', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const frame = fakeScroller({ top: 300, bottom: 500, left: 400, right: 1000 });
    auto.beginDrag({ el: frame, axis: 'x', gate: false });
    auto.follow({ x: 1040, y: 296 });
    for (let i = 0; i < 30; i += 1) clock.tick();
    expect(frame.scrollLeft).toBeGreaterThan(0);
    expect(frame.scrollTop).toBe(0);
  });

  it('a press session follows the Chrome formula with no hitbox ramp', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const body = fakeScroller();
    auto.beginPress(body);
    auto.follow({ x: 10, y: BOX.bottom + 30 });
    clock.tick();
    expect(body.scrollTop).toBe(50);
  });

  it('a drag starting while a press session runs replaces it', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const body = fakeScroller();
    auto.beginPress(body);
    auto.beginDrag({ el: body, axis: 'y', gate: true });
    expect(auto.source).toBe('drag');
    expect(clock.pending()).toBeLessThanOrEqual(1);
  });

  it('a press end does not end a drag session', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    auto.beginDrag({ el: fakeScroller(), axis: 'y', gate: true });
    auto.end('press');
    expect(auto.state).toBe('tracking');
  });

  it('the ramp restarts after the pointer leaves the hitbox', () => {
    const clock = fakeClock();
    const auto = new BodyAutoScroll(clock.deps);
    const body = fakeScroller();
    auto.beginDrag({ el: body, axis: 'y', gate: true });
    auto.follow({ x: 600, y: 895 });
    for (let i = 0; i < 40; i += 1) clock.tick();
    auto.follow({ x: 600, y: 490 });
    clock.tick();
    auto.follow({ x: 600, y: 895 });
    const before = body.scrollTop;
    clock.tick();
    expect(body.scrollTop - before).toBe(1);
  });
});
