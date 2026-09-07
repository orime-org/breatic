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
 *
 * The cap a model states may move with another param it carries: seven
 * reference images alone, four alongside a reference video.
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

/** A one-model catalog whose `images` cap moves with `video`. */
function catalogWithConditionalCap(): unknown {
  return {
    models: [
      {
        name: "kling-o3-pro-ref",
        params: {
          images: {
            description: "Reference image URLs (1-7, or 1-4 with a video)",
            type: "list",
            max_items: 7,
            max_items_when_present: { video: 4 },
            default: null,
          },
          video: { description: "Reference video URL", default: null },
        },
      },
    ],
  };
}

beforeEach(() => {
  getFullModelConfig.mockReset();
  getFullModelConfig.mockReturnValue(catalogWithConditionalCap());
});

describe("validateParams and a cap that moves with another param", () => {
  it("keeps all seven images when no reference video came along", () => {
    const [, cleaned] = validateParams("video", "kling-o3-pro-ref", {
      images: ["a", "b", "c", "d", "e", "f", "g"],
      video: null,
    });
    expect(cleaned.images).toHaveLength(7);
  });

  it("truncates to four once a reference video came along", () => {
    const [, cleaned] = validateParams("video", "kling-o3-pro-ref", {
      images: ["a", "b", "c", "d", "e", "f", "g"],
      video: "https://cdn.example/clip.mp4",
    });
    expect(cleaned.images).toEqual(["a", "b", "c", "d"]);
  });

  it("leaves four images alone alongside a reference video", () => {
    const [, cleaned] = validateParams("video", "kling-o3-pro-ref", {
      images: ["a", "b", "c", "d"],
      video: "https://cdn.example/clip.mp4",
    });
    expect(cleaned.images).toEqual(["a", "b", "c", "d"]);
  });

  it("reads an empty video string as no video, so the plain cap holds", () => {
    const [, cleaned] = validateParams("video", "kling-o3-pro-ref", {
      images: ["a", "b", "c", "d", "e", "f", "g"],
      video: "",
    });
    expect(cleaned.images).toHaveLength(7);
  });
});
