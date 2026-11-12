// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What may wire into a node's input (`canConnect`), the one rule the canvas
 * and the agent both read. inner#1825 lets video and image wire into an audio
 * node, as the scoring, foley and mood-from-picture models read them; every
 * other row stays as it was.
 */

import { describe, expect, it } from "vitest";

import { canConnect } from "@shared/types/canvas-node";

/** Each whitelisted target and the sources it takes, after inner#1825. */
const TAKES: Record<string, readonly string[]> = {
  image: ["image", "text"],
  video: ["text", "video", "audio", "image"],
  text: ["text", "video", "audio", "image"],
  audio: ["text", "audio", "video", "image"],
};

const SOURCES = ["text", "image", "video", "audio", "3d", "web", "annotation", "group"];

describe("canConnect, audio taking video and image (inner#1825)", () => {
  it("lets a video or an image wire into an audio node", () => {
    expect(canConnect("video", "audio")).toBe(true);
    expect(canConnect("image", "audio")).toBe(true);
  });

  it("answers every source on every whitelisted target as the whitelist gives it, audio's two new rows included", () => {
    for (const [target, takes] of Object.entries(TAKES)) {
      for (const source of SOURCES) {
        expect(canConnect(source, target), `${source} → ${target}`).toBe(takes.includes(source));
      }
    }
  });
});
