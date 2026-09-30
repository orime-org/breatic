// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reference-to-video, read off the real config.
 *
 * The reference pool is split by type (design §13): each model declares an
 * `images`, `videos` and `audios` pool for the kinds its upstream takes, each
 * capped at the upstream's own maxItems, and says in `source_groups` that at
 * least one of them has to carry something.
 */

import { initCore } from "@breatic/core";
import { describe, it, expect, beforeAll } from "vitest";

import { getFullModelConfig, type FullModelEntry } from "../model-catalog.js";

beforeAll(() => {
  initCore(process.env);
});

/** Each ref model, the caps its upstream publishes per pool, and its group. */
const REF_MODELS: ReadonlyArray<readonly [string, Readonly<Record<string, number>>]> = [
  ["minimax-h3-reference-to-video", { images: 9, videos: 3, audios: 3 }],
  ["gemini-omni-1.1-flash-reference-to-video", { images: 10, videos: 3 }],
  ["wan-3.0-reference-to-video", { images: 10, videos: 5, audios: 5 }],
  ["happyhorse-1.1-reference-to-video", { images: 9 }],
];

const ACCEPTS: Readonly<Record<string, string>> = { images: "image", videos: "video", audios: "audio" };

/**
 * The video bucket's entry for a model name.
 * @param name - Model id as the catalog spells it.
 * @returns The full config entry.
 * @throws {Error} When the catalog has no such video model.
 */
function videoEntry(name: string): FullModelEntry {
  const found = getFullModelConfig("video").models.find((m) => m.name === name);
  if (!found) throw new Error(`no video model named ${name}`);
  return found;
}

describe("reference-to-video config wiring", () => {
  it.each(REF_MODELS)("%s declares the ref mode", (name) => {
    expect(videoEntry(name).mode).toBe("ref");
  });

  it.each(REF_MODELS)("%s caps each pool where its upstream does", (name, caps) => {
    const params = videoEntry(name).params ?? {};
    for (const [pool, cap] of Object.entries(caps)) {
      expect(params[pool], `${name}.${pool}`).toMatchObject({
        fill: "pool",
        type: "list",
        max_items: cap,
        accepts: ACCEPTS[pool],
      });
    }
    const pools = Object.entries(params)
      .filter(([, spec]) => spec.fill === "pool")
      .map(([key]) => key)
      .sort();
    expect(pools).toEqual(Object.keys(caps).sort());
  });

  it.each(REF_MODELS.filter(([, caps]) => Object.keys(caps).length > 1))(
    "%s needs at least one pool filled",
    (name, caps) => {
      expect(videoEntry(name).source_groups).toEqual([
        { mode: "ref", any_of: ["images", "videos", "audios"].filter((p) => p in caps) },
      ]);
    },
  );
});
