// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The answer about a parameter follows its declaration (#269).
 *
 * Each fixture below declares a fill the real catalog has no model for, so
 * what comes back can only have come from the declaration. Run against the
 * shipped catalog these would say nothing: every model there is declared the
 * way the panel already draws it, so an answer matching the panel would match
 * whichever of the two the projection had read.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * A filesystem serving one video model and the mode declarations.
 * @param params - The parameter block of that model, already indented.
 * @returns A `node:fs` double over those two files.
 */
function fsWith(params: string[]): Record<string, unknown> {
  const modes = [
    "video:",
    "  modes:",
    "    t2v:",
    "      label: text-to-video",
    "    i2v:",
    "      label: image-to-video",
    "      sources: [image]",
  ].join("\n");
  const model = [
    "models:",
    '  - name: "fixture"',
    '    mode: ["t2v", "i2v"]',
    "    takes_prompt: true",
    "    providers:",
    '      - name: "wavespeed"',
    '        model_id: "fixture/model"',
    "        priority: 1",
    "    params:",
    ...params,
  ].join("\n");
  const providers = ["wavespeed:", "  api_key_env: WAVESPEED_API_KEY"].join("\n");
  const named = (path: unknown, file: string): boolean => String(path).endsWith(file);
  return {
    // Only the video bucket holds the fixture: served for every modality it
    // would put a video mode under `image`, which the loader rightly refuses.
    readdirSync: (path: string) => (String(path).endsWith("/video") ? ["fixture.yaml"] : []),
    existsSync: (path: string) =>
      named(path, "modes.yaml") || named(path, "providers.yaml"),
    readFileSync: (path: string) =>
      named(path, "modes.yaml") ? modes : named(path, "providers.yaml") ? providers : model,
  };
}

/**
 * What the projection says about one parameter of the fixture model.
 * @param params - The parameter block to load.
 * @param param - The parameter to read back.
 * @returns Its projected shape.
 */
async function projected(params: string[], param: string): Promise<Record<string, unknown>> {
  vi.resetModules();
  vi.doMock("node:fs", () => fsWith(params));
  const { initCore } = await import("@breatic/core");
  initCore({ ...process.env, WAVESPEED_API_KEY: "test-key" });
  const mod = await import("../mode-catalog.js");
  const answer = mod.modelsForMode("video", "t2v");
  if (!answer.available) throw new Error("the fixture mode is not available");
  const model = answer.models[0];
  if (!model) throw new Error("the fixture model is not in the answer");
  return (model.params[param] ?? {}) as Record<string, unknown>;
}

describe("the projection", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("reports no control for a parameter that declares none", async () => {
    // Every video model in the shipped catalog gives `aspect_ratio` a control,
    // and the panel draws one for it. This fixture declares it has none.
    const info = await projected(
      [
        "      aspect_ratio:",
        '        description: "Output aspect ratio"',
        "        default: null",
        "        fill: none",
        '        note: "this fixture does not mount it"',
      ],
      "aspect_ratio",
    );

    expect(info.noControl).toBe(true);
  });

  it("draws no control gated on a slot this mode has no slot for", async () => {
    // The switch is only meaningful beside the video it applies to, and the
    // fixture's t2v mode offers no video slot.
    const info = await projected(
      [
        "      video:",
        '        description: "Driving video"',
        "        default: null",
        "        fill: canvas",
        "        accepts: video",
        "        modes: [i2v]",
        "      keep_original_sound:",
        '        description: "Keep the source audio"',
        "        default: true",
        "        fill: panel",
        "        when: { source: video }",
      ],
      "keep_original_sound",
    );

    expect(info.noControl).toBe(true);
  });

  it("reports a control for a parameter that declares one", async () => {
    // No video model in the shipped catalog declares `cfg_scale`, and no
    // panel draws one for it. This fixture says it has a control.
    const info = await projected(
      [
        "      cfg_scale:",
        '        description: "Guidance strength"',
        "        default: 0.5",
        "        fill: panel",
      ],
      "cfg_scale",
    );

    expect(info.noControl).toBeUndefined();
  });

  it("marks a pool by the fill it declares, under whatever name it uses", async () => {
    // The reference pool travels as `images` in this repository, and a guard
    // in web holds every pool to that spelling. Reading the name here would
    // make the projection depend on that guard living in another package: the
    // declaration says `pool`, so the answer says pool.
    const info = await projected(
      [
        "      reference_frames:",
        '        description: "Pictures the run draws on"',
        '        type: "list"',
        "        max_items: 4",
        "        default: null",
        "        fill: pool",
        "        accepts: image",
      ],
      "reference_frames",
    );

    expect(info.fromReferencePool).toBe(true);
  });
});
