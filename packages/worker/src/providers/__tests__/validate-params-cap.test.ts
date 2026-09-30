// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `validateParams` and the cap on a capped list param (#1928).
 *
 * This is the last of the three gates on that number. The panel refuses to
 * pick past it and the server refuses to enqueue past it; here the list is
 * truncated instead, with only a log line, so the run goes upstream carrying
 * fewer items than the user picked. That is the degraded result the
 * pre-enqueue gate exists to prevent — the two have to be judging the same
 * number, or a submission the server let through gets quietly cut here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const getFullModelConfig = vi.fn();

// The truncation branch logs before it cuts, and the real logger refuses to
// exist before `initCore` has run.
vi.mock("@breatic/core", () => ({
  logger: { warn: (): undefined => undefined, info: (): undefined => undefined },
}));

vi.mock("@breatic/domain", () => ({
  getFullModelConfig: (modality: string): unknown =>
    getFullModelConfig(modality),
  resolveActiveProvider: (): unknown => undefined,
}));

const { validateParams } = await import("@worker/providers/shared.js");

/** A one-model catalog whose `images` list is capped at four. */
function catalogWithCap(): unknown {
  return {
    models: [
      {
        name: "capped-model",
        params: {
          images: { description: "Reference image URLs", type: "list", max_items: 4, default: null },
        },
      },
    ],
  };
}

beforeEach(() => {
  getFullModelConfig.mockReset();
  getFullModelConfig.mockReturnValue(catalogWithCap());
});

describe("validateParams and a capped list param", () => {
  it("truncates a list past the cap to the cap", () => {
    const [, cleaned] = validateParams("video", "capped-model", {
      images: ["a", "b", "c", "d", "e", "f"],
    });
    expect(cleaned.images).toEqual(["a", "b", "c", "d"]);
  });

  it("leaves a list within the cap alone", () => {
    const [, cleaned] = validateParams("video", "capped-model", { images: ["a", "b"] });
    expect(cleaned.images).toEqual(["a", "b"]);
  });
});
