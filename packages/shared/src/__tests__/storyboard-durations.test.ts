// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How a Kling storyboard's shot durations move when the reader edits it.
 *
 * The upstream fails any run whose shot durations do not add up to the
 * top-level duration (probed 2026-09-30), so every single-user edit keeps
 * "each shot at least 1 second and the sum equals the total" whenever there
 * are no more shots than seconds.
 */

import { describe, it, expect } from "vitest";
import {
  addShot,
  enterCustom,
  removeShot,
  retotal,
  stepShot,
} from "@shared/storyboard-durations.js";

const sum = (ds: readonly number[]): number => ds.reduce((a, b) => a + b, 0);

describe("entering the multi-shot mode", () => {
  it("starts two shots splitting the total, the longer one last", () => {
    expect(enterCustom([], 5)).toEqual([2, 3]);
    expect(enterCustom([], 4)).toEqual([2, 2]);
  });

  it("keeps existing shots when they already add up", () => {
    expect(enterCustom([1, 2, 2], 5)).toEqual([1, 2, 2]);
  });

  it("re-splits existing shots in proportion when the total changed meanwhile", () => {
    const next = enterCustom([4, 4, 2], 5);
    expect(sum(next)).toBe(5);
    expect(next.every((d) => d >= 1)).toBe(true);
  });

  it("leaves shots untouched when there are more shots than seconds", () => {
    expect(enterCustom([1, 2, 2, 2, 2, 1], 3)).toEqual([1, 2, 2, 2, 2, 1]);
  });
});

describe("adding a shot", () => {
  it("takes the new shot's seconds from the longest shots", () => {
    expect(addShot([2, 3], 5, 6)).toEqual([2, 2, 1]);
    expect(addShot([5, 5], 10, 6)).toEqual([3, 4, 3]);
  });

  it("is refused at the shot cap", () => {
    expect(addShot([1, 1, 1, 1, 1, 1], 10, 6)).toBeNull();
  });

  it('re-splits a list whose seconds drifted, so every shot keeps at least 1 second', () => {
    // Two collaborators each removing a shot leave none; concurrent steps can
    // leave seconds that no longer add up to the total.
    expect(addShot([], 5, 6)).toEqual([5]);
    const drifted = addShot([1, 1], 5, 6);
    expect(drifted).toHaveLength(3);
    expect(drifted?.every((d) => d >= 1)).toBe(true);
    expect(drifted?.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it("is refused when every shot is already at one second", () => {
    expect(addShot([1, 1, 1], 3, 6)).toBeNull();
  });
});

describe("stepping one shot by a second", () => {
  it("takes a second from the next shot", () => {
    expect(stepShot([2, 3], 0, 1)).toEqual([3, 2]);
  });

  it("skips next shots already at one second, then looks backwards", () => {
    expect(stepShot([3, 1, 1], 1, 1)).toEqual([2, 2, 1]);
    expect(stepShot([2, 2, 1], 2, 1)).toEqual([2, 1, 2]);
  });

  it("gives a second to the next shot, the last one to the previous", () => {
    expect(stepShot([3, 2], 0, -1)).toEqual([2, 3]);
    expect(stepShot([3, 2], 1, -1)).toEqual([4, 1]);
  });

  it("cannot take a shot below one second", () => {
    expect(stepShot([1, 4], 0, -1)).toBeNull();
  });

  it("cannot grow a shot when every other shot is at one second", () => {
    expect(stepShot([3, 1, 1], 0, 1)).toBeNull();
  });
});

describe("removing a shot", () => {
  it("gives its seconds to the previous shot", () => {
    expect(removeShot([2, 2, 1], 2, 5)).toEqual([2, 3]);
  });

  it("gives the first shot's seconds to the new first shot", () => {
    expect(removeShot([2, 2, 1], 0, 5)).toEqual([4, 1]);
  });

  it("refuses to remove the last remaining shot", () => {
    expect(removeShot([5], 0, 5)).toBeNull();
  });

  it("re-splits to the total once there are no more shots than seconds", () => {
    // Six shots under a 3 s total: removing three leaves three, which fit.
    let ds: number[] = [1, 2, 2, 2, 2, 1];
    for (let i = 0; i < 3; i++) ds = removeShot(ds, ds.length - 1, 3) ?? ds;
    expect(ds).toEqual([1, 1, 1]);
  });
});

describe("changing the total", () => {
  it("re-splits in proportion, each shot at least one second", () => {
    expect(retotal([2, 2, 1], 10)).toEqual([4, 4, 2]);
    const down = retotal([4, 4, 2], 4);
    expect(sum(down)).toBe(4);
    expect(down.every((d) => d >= 1)).toBe(true);
  });

  it("leaves shots untouched when there would be more shots than seconds", () => {
    expect(retotal([4, 4, 2], 2)).toEqual([4, 4, 2]);
  });

  it("keeps every result summing to the total for all small cases", () => {
    for (let n = 1; n <= 6; n++) {
      for (let from = n; from <= 15; from++) {
        for (let to = n; to <= 15; to++) {
          const start = enterCustom(Array.from({ length: n }, () => 1), from);
          const next = retotal(start, to);
          expect(sum(next)).toBe(to);
          expect(next.every((d) => d >= 1)).toBe(true);
        }
      }
    }
  });
});
