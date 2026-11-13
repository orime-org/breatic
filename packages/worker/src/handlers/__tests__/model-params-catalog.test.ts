// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the shipped catalog lets through to provider for two models whose declarations decide it: the talking-head
 * model takes its two sources and nothing else (#1935), and a Mureka V9.5 Song run composed from a melody carries
 * only the lyrics, the melody and the setting itself (breatic#1393), which provider keeps off the wire.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { initCore } from "@breatic/core";
import { paramsToSend } from "@breatic/shared";

import { entryOf, validateModelParams } from "@worker/handlers/model-params.js";

beforeAll(() => {
  initCore({ DATABASE_URL: "postgres://localhost:5432/breatic_test" });
});

describe("the shipped catalog", () => {
  it("keeps the talking-head model to its two sources", () => {
    const [, cleaned] = validateModelParams("video", "omnihuman-1.5", {
      image: "https://cdn/portrait.png",
      audio: "https://cdn/speech.mp3",
      stray: "x",
    });
    expect(cleaned).toEqual({ image: "https://cdn/portrait.png", audio: "https://cdn/speech.mp3" });
  });

  it("lays a melody-composed Mureka run out as the lyrics, the melody and the setting", () => {
    const [, cleaned] = validateModelParams("audio", "mureka-v9.5-generate-song", {
      compose_from: "melody",
      lyrics: "la",
      melody: "https://cdn/m.mp3",
      song: "https://cdn/s.mp3",
    });
    const entry = entryOf("audio", "mureka-v9.5-generate-song") as unknown as Parameters<typeof paramsToSend>[0];
    expect(paramsToSend(entry, cleaned, "lo-fi").params).toEqual({ compose_from: "melody", lyrics: "la", melody: "https://cdn/m.mp3" });
  });
});
