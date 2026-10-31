// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The three numbers a fold is decided and sized by (inner#1567, design 6.2 and 6.4.1).
 *
 * Remaining room is the window less the output reserve less what the provider
 * last reported; with no report there is nothing to check. A fold runs down to
 * the lower of the keep line and the room the window leaves, less the room
 * memory itself takes, and sizes the request by the largest count it holds.
 */

import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";

vi.mock("@server/agent/memory-consolidator.js", () => ({ consolidateWindow: vi.fn() }));

const { foldSize, foldTarget, needsFold } = await import("@server/agent/turn-fold.js");

const WINDOW = 1_000_000;
const MAX_OUTPUT = 65_536;
const RESERVE = 32_768;

describe("foldTarget", () => {
  it("uses the keep line when the window leaves more room than it", () => {
    expect(foldTarget({ keep: 500_000, window: WINDOW, maxOutput: MAX_OUTPUT, reserve: RESERVE })).toBe(467_232);
  });

  it("uses the window less the output reserve when that is smaller than the keep line", () => {
    expect(foldTarget({ keep: 500_000, window: 200_000, maxOutput: MAX_OUTPUT, reserve: RESERVE })).toBe(101_696);
  });

  it("is min(keep, window - maxOutput) - reserve for any inputs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.integer({ min: 0, max: 200_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        (keep, window, maxOutput, reserve) =>
          foldTarget({ keep, window, maxOutput, reserve }) === Math.min(keep, window - maxOutput) - reserve,
      ),
    );
  });
});

describe("needsFold", () => {
  it("folds when the known count leaves exactly no room", () => {
    expect(needsFold({ window: WINDOW, maxOutput: MAX_OUTPUT, known: WINDOW - MAX_OUTPUT })).toBe(true);
  });

  it("folds when the known count is past the room", () => {
    expect(needsFold({ window: WINDOW, maxOutput: MAX_OUTPUT, known: WINDOW - MAX_OUTPUT + 1 })).toBe(true);
  });

  it("sends as is when one token of room is left", () => {
    expect(needsFold({ window: WINDOW, maxOutput: MAX_OUTPUT, known: WINDOW - MAX_OUTPUT - 1 })).toBe(false);
  });

  it("does not check without a known count", () => {
    expect(needsFold({ window: WINDOW, maxOutput: MAX_OUTPUT, known: undefined })).toBe(false);
  });

  it("folds on a small window that a large-window count would pass", () => {
    expect(needsFold({ window: 200_000, maxOutput: MAX_OUTPUT, known: 150_000 })).toBe(true);
  });
});

describe("foldSize", () => {
  it("takes the reported overflow count when it is the largest", () => {
    expect(foldSize({ known: 900_000, reported: 1_048_577, estimate: 700_000 })).toBe(1_048_577);
  });

  it("takes the estimate when it is larger than the known count", () => {
    expect(foldSize({ known: 900_000, estimate: 950_000 })).toBe(950_000);
  });

  it("takes the known count when it is larger than the estimate", () => {
    expect(foldSize({ known: 900_000, estimate: 300_000 })).toBe(900_000);
  });

  it("falls back to the estimate alone", () => {
    expect(foldSize({ estimate: 700_000 })).toBe(700_000);
  });

  it("is the maximum of the values present", () => {
    fc.assert(
      fc.property(
        fc.option(fc.integer({ min: 0, max: 3_000_000 }), { nil: undefined }),
        fc.option(fc.integer({ min: 0, max: 3_000_000 }), { nil: undefined }),
        fc.integer({ min: 0, max: 3_000_000 }),
        (known, reported, estimate) => {
          const expected = Math.max(estimate, known ?? 0, reported ?? 0);
          const input = {
            estimate,
            ...(known === undefined ? {} : { known }),
            ...(reported === undefined ? {} : { reported }),
          };
          return foldSize(input) === expected;
        },
      ),
    );
  });
});
