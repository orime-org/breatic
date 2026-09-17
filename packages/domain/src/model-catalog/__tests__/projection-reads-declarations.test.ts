// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The answer about a parameter follows its declaration (#269).
 *
 * Both fixtures below declare a fill that disagrees with the panel tables the
 * projection reads today, which is the only way to tell the two sources
 * apart: on the real catalog they agree by construction, so a comparison
 * between them can never fail.
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

  it("reports no control for a parameter that declares none, whatever the panel table says", async () => {
    // `aspect_ratio` is in PANEL_PARAM_CONTROLS.video, so the tables call it a
    // control; the declaration says otherwise and the declaration wins.
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

  it("reports a control for a parameter that declares one, whatever the panel table says", async () => {
    // `cfg_scale` is in no panel table, so the tables would call it reachable
    // by nothing.
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
});
