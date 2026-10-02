// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #113 A2: the strip stands on the middle of the row's FIRST line.
 *
 * The geometry is a browser's to produce, so what is pinned here is the
 * arithmetic on top of it — with the numbers taken from a real browser on
 * 2026-09-17, so a change to either side of the subtraction turns this red.
 * The measurements themselves are in
 * `engineering/demo/2026-09-17-strip-box.probe.spec.ts`.
 */

import { describe, it, expect } from 'vitest';

import type { MiddlewareState } from '@floating-ui/react';

import {
  stripPlacement,
  stripOffsetFromRowTop,
} from '@web/spaces/document/document-strip-alignment';

/** The strip's measured height: one 24px handle in a flex wrapper. */
const STRIP = 24;

describe('where the strip stands', () => {
  it('centres on the first line of a level-one heading', () => {
    // Measured: container top 96, first line 96 → 125.19 (29px of text).
    expect(
      stripOffsetFromRowTop({ top: 96, height: 29 }, 96, STRIP),
    ).toBeCloseTo(96 + 14.5 - 12 - 96, 5);
  });

  it('counts the space above a block, which is not the carrier’s', () => {
    // Measured on a level-two heading: the carrier lands on the container's
    // top edge at 173.69 while the words start at 207.69, 34px below, because
    // the space above the block is a margin on the content element.
    const offset = stripOffsetFromRowTop(
      { top: 207.69, height: 24 },
      173.69,
      STRIP,
    );
    expect(offset).toBeCloseTo(207.69 + 12 - 12 - 173.69, 2);
    // And it is that gap that the reader saw as the strip standing too high:
    // without it the strip would be a whole heading's margin above the words.
    expect(offset).toBeGreaterThan(30);
  });

  it('takes the first line of a wrapped row, not the middle of the row', () => {
    // Measured: a paragraph wrapping onto three lines of 19px text at 22.5px
    // pitch. The first line's box is the one that decides.
    const firstLine = { top: 482, height: 19 };
    const wholeRow = { top: 482, height: 19 + 22.5 * 2 };
    expect(stripOffsetFromRowTop(firstLine, 482, STRIP)).toBeLessThan(
      stripOffsetFromRowTop(wholeRow, 482, STRIP),
    );
    expect(stripOffsetFromRowTop(firstLine, 482, STRIP)).toBeCloseTo(
      482 + 9.5 - 12 - 482,
      5,
    );
  });

  it('leaves a row with nothing to measure where it was placed', () => {
    expect(stripOffsetFromRowTop(undefined, 400, STRIP)).toBe(0);
    // A collapsed line reports a box of no height; centring on it would lift
    // the strip by half its own.
    expect(stripOffsetFromRowTop({ top: 400, height: 0 }, 400, STRIP)).toBe(0);
  });

  it('replaces the library’s table of per-type offsets', () => {
    // The table is 39 / 27 / 18.5 for headings against a 30px strip — see the
    // module's own comment. The one middleware left moves the carrier
    // sideways only, so it stays on the container's top edge for the strip to
    // measure from.
    const { middleware } = stripPlacement(() => undefined).useFloatingOptions;
    expect(middleware.map((m) => m.name)).toEqual(['bodyEdge']);
  });
});

/**
 * Runs the placement's middleware for a carrier floating-ui put at `x`
 * against a row container whose left edge is `rowLeft`.
 * @param bodyLeft - The left edge of the body's root block group.
 * @param rowLeft - The row container's left edge.
 * @param x - Where floating-ui placed the carrier.
 * @returns The carrier's x after the middleware.
 */
async function placeAt(bodyLeft: number, rowLeft: number, x: number): Promise<number | undefined> {
  const body = document.createElement('div');
  const root = document.createElement('div');
  body.appendChild(root);
  root.getBoundingClientRect = (): DOMRect => ({ left: bodyLeft }) as DOMRect;
  const [edge] = stripPlacement(() => body).useFloatingOptions.middleware;
  const state = { x, rects: { reference: { x: rowLeft } } } as unknown as MiddlewareState;
  const result = await edge!.fn(state);
  return result.x;
}

describe('the strip stays on the body\'s left edge (#1097 A13)', () => {
  it('puts a nested row\'s carrier where a top-level row\'s goes', async () => {
    // Body at 400, row indented to 448 (two levels), strip 24 wide: the
    // library's left-start put the carrier at 424.
    expect(await placeAt(400, 448, 424)).toBe(376);
  });

  it('leaves a top-level row\'s carrier where it is', async () => {
    expect(await placeAt(400, 400, 376)).toBe(376);
  });

  it('leaves the carrier alone while there is no body to measure', async () => {
    const [edge] = stripPlacement(() => undefined).useFloatingOptions.middleware;
    const state = { x: 424, rects: { reference: { x: 448 } } } as unknown as MiddlewareState;
    expect((await edge!.fn(state)).x).toBeUndefined();
  });
});
