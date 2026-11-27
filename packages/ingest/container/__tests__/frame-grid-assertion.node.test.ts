// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, expect, it } from "vitest";
import { expectSlot, mad, NOISE } from "./helpers/frame-grid-harness.js";

/**
 * The pre-optimization assertion's independent decision and diagnostic, including its stable nearest-slot tie.
 * @returns The original expected result for the supplied pictures.
 */
function reference(actual: Buffer, oracle: readonly Buffer[], slot: number): { pass: boolean; message: string } {
  const own = mad(actual, oracle[slot]!);
  const nearest = oracle.map((frame, at) => ({ at, distance: mad(actual, frame) }))
    .filter(({ at, distance }) => at === slot || distance >= own || mad(oracle[at]!, oracle[slot]!) > NOISE)
    .sort((a, b) => a.distance - b.distance)[0]!;
  return {
    pass: own <= Math.min(NOISE, nearest.distance + 1e-9),
    message: `comparison: slot ${slot} differs by ${own}; nearest is slot ${nearest.at} at ${nearest.distance}`,
  };
}

/**
 * Compare both decisions and the original failing assertion's nearest-slot explanation.
 * @returns Nothing after the assertions.
 */
function agrees(actual: Buffer, oracle: readonly Buffer[], slot: number): void {
  const expected = reference(actual, oracle, slot);
  if (expected.pass) expect(() => expectSlot(actual, oracle, slot, "comparison")).not.toThrow();
  else expect(() => expectSlot(actual, oracle, slot, "comparison")).toThrow(expected.message);
}

describe("frame-grid slot assertion", () => {
  it("allows exact repeated pictures without changing the original nearest slot", () => {
    const target = Buffer.from([20, 40, 60]);
    const oracle = Array.from({ length: 40 }, () => Buffer.from(target));
    agrees(Buffer.from(target), oracle, 23);
    agrees(Buffer.from([30, 50, 70]), oracle, 23);
  });

  it("rejects conversion noise above four and a closer distinguishable picture", () => {
    expect(() => expectSlot(Buffer.from([5, 5]), [Buffer.from([0, 0])], 0, "noise")).toThrow();
    // Each boundary pixel is equal; exact comparison must still distinguish the middle pixels.
    const target = Buffer.from([0, 20, 20, 0]);
    const other = Buffer.from([0, 30, 30, 0]);
    const actual = Buffer.from([0, 26, 26, 0]);
    expect(mad(actual, target)).toBe(3);
    expect(mad(target, other)).toBe(5);
    expect(() => expectSlot(actual, [target, other, Buffer.from(other)], 0, "wrong slot")).toThrow();
    agrees(actual, [target, other, Buffer.from(other)], 0);
  });

  it("does not merge similar competing pictures whose distances to actual differ", () => {
    const actual = Buffer.from([4]);
    const oracle = [Buffer.from([0]), Buffer.from([10]), Buffer.from([6])];
    expect(() => expectSlot(actual, oracle, 0, "distinct competitors")).toThrow(
      "distinct competitors: slot 0 differs by 4; nearest is slot 2 at 2",
    );
    agrees(actual, oracle, 0);
  });

  it("keeps the original tolerance for near-still pictures that are not byte-identical", () => {
    const target = Buffer.from([10, 10]);
    const nearby = Buffer.from([14, 14]);
    expect(() => expectSlot(Buffer.from(nearby), [nearby, target, Buffer.from(nearby)], 1, "near still")).not.toThrow();
    agrees(Buffer.from(nearby), [nearby, target, Buffer.from(nearby)], 1);
  });

  it("observes oracle changes while the target distance stays inside the noise limit", () => {
    const oracle = [Buffer.from([0]), Buffer.from([0])];
    const actual = Buffer.from([3]);
    expect(() => expectSlot(actual, oracle, 0, "before mutation")).not.toThrow();
    oracle[1]!.fill(5);
    expect(() => expectSlot(actual, oracle, 0, "after mutation")).toThrow();
    agrees(actual, oracle, 0);
    oracle[1] = Buffer.from([0]);
    expect(() => expectSlot(actual, oracle, 0, "after replacement")).not.toThrow();
    oracle[1] = Buffer.from([5]);
    expect(() => expectSlot(actual, oracle, 0, "closer replacement")).toThrow();
    agrees(actual, oracle, 0);
  });

  it("recomputes competing distances when the same actual Buffer changes", () => {
    const oracle = [Buffer.from([0]), Buffer.from([6])];
    const actual = Buffer.from([1]);
    expect(() => expectSlot(actual, oracle, 0, "before actual mutation")).not.toThrow();
    actual.fill(4);
    expect(() => expectSlot(actual, oracle, 0, "after actual mutation")).toThrow();
    agrees(actual, oracle, 0);
  });

  it("preserves unequal-size and empty-picture decisions", () => {
    agrees(Buffer.from([1, 2]), [Buffer.from([1]), Buffer.from([1, 2])], 0);
    agrees(Buffer.alloc(0), [Buffer.alloc(0), Buffer.from([1])], 0);
  });

  it("matches the original decision and diagnostic over deterministic diverse and duplicate pictures", () => {
    let state = 0x51de5;
    for (let sample = 0; sample < 400; sample += 1) {
      const pictures: Buffer[] = [];
      for (let at = 0; at < 6; at += 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const base = state % 256;
        pictures.push(Buffer.from([base, (base + (state >>> 8)) % 256, (state >>> 16) % 256]));
      }
      const oracle = [pictures[0]!, ...pictures, Buffer.from(pictures[0]!), Buffer.from(pictures[2]!)];
      const slot = sample % oracle.length;
      const actual = Buffer.from(oracle[(sample >>> 1) % oracle.length]!);
      actual[1] = (actual[1]! + sample % 11) % 256;
      agrees(actual, oracle, slot);
    }
  });
});
