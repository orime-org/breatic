// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The one flow every caller runs a run's settings through (inner#1691, design
 * 2.3): fill the declared defaults, apply the model's forced values until
 * nothing changes, drop what a condition switches off; and the rule check the
 * panel, the submit endpoint and the agent tool share.
 *
 * The fixtures are the Tripo H3.1 entries the design declares, written here
 * rather than read from the catalog so the rules under test are the ones the
 * design states.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { checkParamCombination, resolveParams, type ModelEntry } from "@shared/index.js";

/** The forced values every Tripo H3.1 entry declares, in this order. */
const FORCES = [
  { id: "parts_geometry_only", when: { flag_on: "generate_parts" }, set: { texture: false, pbr: false }, lock: true },
  { id: "pbr_needs_texture", when: { flag_on: "pbr" }, set: { texture: true }, lock: true },
  {
    id: "fast_uses_v35",
    when: { flag_on: "texture", equals: { texture_quality: "fast" } },
    set: { texture_version: "v3.5" },
    lock: true,
  },
] as const;

/** The settings all three entries declare. */
const COMMON_PARAMS = {
  texture: { description: "", label: "Texture", fill: "panel", values: [true, false], default: true },
  pbr: { description: "", label: "PBR", fill: "panel", values: [true, false], default: true },
  texture_quality: {
    description: "",
    label: "Texture quality",
    fill: "panel",
    values: ["standard", "fast", "detailed", "extreme"],
    value_labels: { standard: "Standard", fast: "Fast", detailed: "Detailed", extreme: "Extreme" },
    default: "standard",
    when: { flag_on: "texture" },
  },
  texture_version: {
    description: "",
    label: "Texture version",
    fill: "panel",
    values: ["v3.0", "v3.5"],
    default: "v3.0",
    when: { flag_on: "texture" },
  },
  delight: {
    description: "",
    label: "Delight",
    fill: "panel",
    values: [true, false],
    default: true,
    when: { flag_on: "texture", equals: { texture_version: "v3.5" } },
  },
  geometry_quality: {
    description: "",
    label: "Geometry quality",
    fill: "panel",
    values: ["standard", "detailed"],
    default: "standard",
  },
  smart_low_poly: { description: "", label: "Smart low-poly", fill: "panel", values: [true, false], default: false },
  generate_parts: { description: "", label: "Generate parts", fill: "panel", values: [true, false], default: false },
  face_limit: {
    description: "",
    label: "Face limit",
    fill: "panel",
    type: "integer",
    min: 1,
    max: 1_500_000,
    bounds: [
      { when: { flag_on: "smart_low_poly" }, min: 500, max: 20_000 },
      { when: { equals: { geometry_quality: "detailed" } }, max: 2_000_000 },
    ],
    default: null,
  },
  auto_size: {
    description: "",
    label: "Auto size",
    fill: "panel",
    values: [true, false],
    default: false,
    when: { flag_on: "texture" },
  },
  export_uv: { description: "", label: "Export UV", fill: "panel", values: [true, false], default: true },
  model_seed: { description: "", label: "Model seed", fill: "panel", type: "integer", min: 0, max: 2_147_483_647, default: null },
  texture_seed: { description: "", label: "Texture seed", fill: "panel", type: "integer", min: 0, max: 2_147_483_647, default: null },
} as const;

/**
 * One Tripo H3.1 entry around the given params.
 * @param name - The entry name.
 * @param mode - Its mode.
 * @param params - Its params.
 * @param over - Entry-level overrides.
 * @returns The entry, as the catalog ships it.
 */
function tripo(
  name: string,
  mode: string,
  params: Record<string, unknown>,
  over: Record<string, unknown> = {},
): ModelEntry {
  return {
    name,
    display_name: "Tripo H3.1",
    modality: "three_d",
    mode,
    description: "",
    guide: "",
    tier: "recommended",
    generation_time: 120,
    params,
    availability: { upstreams: [{ upstream: "wavespeed", weight: 1, configured: true, envVar: "WAVESPEED_API_KEY" }] },
    takes_prompt: false,
    forces: FORCES,
    ...over,
  } as unknown as ModelEntry;
}

/** The text-to-3D entry of design 2.3. */
const T23D = tripo(
  "tripo-h3.1-t23d",
  "t23d",
  {
    ...COMMON_PARAMS,
    negative_prompt: {
      description: "",
      label: "Negative prompt",
      fill: "panel",
      type: "text",
      max_length: 255,
      default: null,
    },
  },
  { takes_prompt: true, prompt_max_length: 1024 },
);

/** The single-image entry of design 2.3. */
const I23D = tripo("tripo-h3.1-i23d", "i23d", {
  image: { description: "", fill: "canvas", accepts: "image", default: null },
  ...COMMON_PARAMS,
  texture_alignment: {
    description: "",
    label: "Texture alignment",
    fill: "panel",
    values: ["original_image", "geometry"],
    default: "original_image",
  },
  orientation: {
    description: "",
    label: "Orientation",
    fill: "panel",
    values: ["default", "align_image"],
    default: "default",
    when: { flag_on: "texture" },
  },
  enable_image_autofix: { description: "", label: "Image autofix", fill: "panel", values: [true, false], default: false },
});

const FRONT = "https://cdn.example.invalid/front.png";

describe("resolveParams", () => {
  it("fills every declared default and drops what a condition switches off", () => {
    const { negative_prompt: _left, ...rest } = resolveParams(T23D, {});
    expect(rest).toEqual({
      texture: true,
      pbr: true,
      texture_quality: "standard",
      texture_version: "v3.0",
      geometry_quality: "standard",
      smart_low_poly: false,
      generate_parts: false,
      auto_size: false,
      export_uv: true,
    });
  });

  it("turns texture and PBR off when parts are generated with PBR on", () => {
    expect(resolveParams(T23D, { generate_parts: true, pbr: true, texture: true })).toEqual({
      texture: false,
      pbr: false,
      geometry_quality: "standard",
      smart_low_poly: false,
      generate_parts: true,
      export_uv: true,
    });
  });

  it("turns texture on when PBR is on and texture is off", () => {
    const resolved = resolveParams(T23D, { pbr: true, texture: false });
    expect([resolved.texture, resolved.pbr]).toEqual([true, true]);
  });

  it("uses texture version v3.5 when texture quality is Fast", () => {
    const resolved = resolveParams(T23D, { texture: true, texture_quality: "fast", texture_version: "v3.0" });
    expect(resolved.texture_version).toBe("v3.5");
    expect(resolved.texture_quality).toBe("fast");
  });

  it("drops the texture settings when texture is off", () => {
    expect(
      resolveParams(I23D, {
        image: FRONT,
        texture: false,
        pbr: false,
        texture_quality: "extreme",
        texture_version: "v3.5",
        delight: true,
        orientation: "align_image",
        auto_size: true,
      }),
    ).toEqual({
      image: FRONT,
      texture: false,
      pbr: false,
      geometry_quality: "standard",
      smart_low_poly: false,
      generate_parts: false,
      texture_alignment: "original_image",
      enable_image_autofix: false,
      export_uv: true,
    });
  });

  it("keeps delight only while texture is on at version v3.5", () => {
    const keeps = (params: Record<string, unknown>): boolean => "delight" in resolveParams(T23D, params);
    expect([
      keeps({ texture: true, texture_version: "v3.5", delight: false }),
      keeps({ texture: true, texture_version: "v3.0", delight: true }),
      keeps({ texture: false, pbr: false, texture_version: "v3.5", delight: true }),
    ]).toEqual([true, false, false]);
    expect(resolveParams(T23D, { texture: true, texture_version: "v3.5", delight: false }).delight).toBe(false);
  });

  it.each([
    ["an empty string", ""],
    ["null", null],
  ])("leaves a blank integer out when it is %s", (_case, blank) => {
    const resolved = resolveParams(T23D, { face_limit: blank, model_seed: blank, texture_seed: blank });
    expect(["face_limit", "model_seed", "texture_seed"].filter((key) => key in resolved)).toEqual([]);
  });

  it("leaves an integer out when it is not given, and keeps one that is", () => {
    const resolved = resolveParams(T23D, { face_limit: 5000 });
    expect(resolved.face_limit).toBe(5000);
    expect(["model_seed", "texture_seed"].filter((key) => key in resolved)).toEqual([]);
  });
});

/** Every switch and choice the forced values read or write, each possibly left out. */
const settings = fc.record(
  {
    texture: fc.boolean(),
    pbr: fc.boolean(),
    texture_quality: fc.constantFrom("standard", "fast", "detailed", "extreme"),
    texture_version: fc.constantFrom("v3.0", "v3.5"),
    delight: fc.boolean(),
    geometry_quality: fc.constantFrom("standard", "detailed"),
    smart_low_poly: fc.boolean(),
    generate_parts: fc.boolean(),
    auto_size: fc.boolean(),
    export_uv: fc.boolean(),
  },
  { requiredKeys: [] },
);

/**
 * Whether a forced value's condition holds on a set of params.
 * @param when - The condition as the catalog declares it.
 * @param when.flag_on - A switch that has to be on.
 * @param when.equals - Params that have to hold these values.
 * @param params - The params to read.
 * @returns True when every part holds.
 */
function holds(
  when: { readonly flag_on?: string; readonly equals?: Readonly<Record<string, unknown>> },
  params: Record<string, unknown>,
): boolean {
  if (when.flag_on !== undefined && params[when.flag_on] !== true) return false;
  return Object.entries(when.equals ?? {}).every(([key, value]) => params[key] === value);
}

describe("resolveParams, over every combination of the forced settings", () => {
  it("gives the same result when its result is resolved again", () => {
    fc.assert(
      fc.property(settings, (input) => {
        const once = resolveParams(T23D, input);
        expect(resolveParams(T23D, once)).toEqual(once);
      }),
    );
  });

  it("leaves no forced value whose condition holds unapplied", () => {
    fc.assert(
      fc.property(settings, (input) => {
        const resolved = resolveParams(T23D, input);
        for (const force of FORCES) {
          if (!holds(force.when, resolved)) continue;
          for (const [key, value] of Object.entries(force.set)) {
            expect(resolved[key], `${force.id} sets ${key}`).toBe(value);
          }
        }
      }),
    );
  });

  it("gives a result the rule check finds nothing wrong with", () => {
    fc.assert(
      fc.property(settings, (input) => {
        expect(checkParamCombination(T23D, resolveParams(T23D, input))).toEqual([]);
      }),
    );
  });
});

describe("checkParamCombination", () => {
  it("holds the face limit to 500 to 20000 under smart low-poly", () => {
    const found = checkParamCombination(T23D, { smart_low_poly: true, face_limit: 30_000 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ param: "face_limit", rule: "bounds", min: 500, max: 20_000 });
  });

  it("falls back to the param's own floor of 1 under detailed geometry", () => {
    const found = checkParamCombination(T23D, { geometry_quality: "detailed", face_limit: 0 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ param: "face_limit", rule: "bounds", min: 1, max: 2_000_000 });
  });

  it("takes 1800000 faces under detailed geometry and refuses them under standard", () => {
    expect(checkParamCombination(T23D, { geometry_quality: "detailed", face_limit: 1_800_000 })).toEqual([]);
    const found = checkParamCombination(T23D, { geometry_quality: "standard", face_limit: 1_800_000 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ param: "face_limit", rule: "bounds", min: 1, max: 1_500_000 });
  });

  it("refuses a seed below 0 or above 2147483647", () => {
    const found = checkParamCombination(T23D, { model_seed: -1, texture_seed: 2_147_483_648 });
    expect(found.map((v) => [v.param, v.rule])).toEqual([
      ["model_seed", "bounds"],
      ["texture_seed", "bounds"],
    ]);
  });

  it("refuses a face limit that is not a whole number", () => {
    const found = checkParamCombination(T23D, { face_limit: 1.5 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ param: "face_limit", rule: "integer" });
  });

  it("refuses a choice the param does not offer", () => {
    const found = checkParamCombination(T23D, { texture_quality: "ultra" });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ param: "texture_quality", rule: "values" });
  });

  it("measures the negative prompt after cleaning", () => {
    expect(checkParamCombination(T23D, { negative_prompt: `<b>${"x".repeat(255)}</b>` })).toEqual([]);
    const found = checkParamCombination(T23D, { negative_prompt: `<b>${"x".repeat(256)}</b>` });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ param: "negative_prompt", rule: "max_length" });
  });

  it("refuses a text setting given anything but text", () => {
    for (const value of [5, true]) {
      expect(checkParamCombination(T23D, { negative_prompt: value })).toEqual([{ param: "negative_prompt", rule: "text", value }]);
    }
  });

  it("refuses a prompt longer than 1024 characters after cleaning", () => {
    expect(checkParamCombination(T23D, { prompt: `<p>${"x".repeat(1024)}</p>` })).toEqual([]);
    const found = checkParamCombination(T23D, { prompt: "x".repeat(1025) });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ param: "prompt", rule: "prompt_max_length" });
  });

  it("names pbr_needs_texture when texture is turned off and PBR is left at its default", () => {
    const found = checkParamCombination(T23D, { texture: false });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ param: "texture", rule: "forced" });
    expect(Object.values(found[0] ?? {})).toContain("pbr_needs_texture");
  });

  it("names parts_geometry_only when texture is asked for with parts", () => {
    const found = checkParamCombination(T23D, { generate_parts: true, texture: true });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ param: "texture", rule: "forced" });
    expect(Object.values(found[0] ?? {})).toContain("parts_geometry_only");
  });

  it("finds nothing wrong with a result of resolveParams checked as it is", () => {
    for (const input of [
      {},
      { generate_parts: true, pbr: true },
      { texture: true, texture_quality: "fast" },
      { smart_low_poly: true, face_limit: 20_000, model_seed: 0, texture_seed: 2_147_483_647 },
    ]) {
      expect(checkParamCombination(T23D, resolveParams(T23D, input))).toEqual([]);
    }
    expect(checkParamCombination(I23D, resolveParams(I23D, { image: FRONT, texture: false, pbr: false }))).toEqual([]);
  });
});
