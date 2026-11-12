// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The 3D catalog the repository ships (inner#1691, design 2.1 and 2.3): the
 * three Tripo H3.1 entries, what each takes, the forced values they share,
 * and that the panel's copy of the catalog keeps every new declaration.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resolveParams, sanitizeModelCatalog } from "@breatic/shared";

import { estimateModelCredits, getFullModelConfig, getModelCatalog, MODALITIES } from "../model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

const T23D = "tripo-h3.1-t23d";
const I23D = "tripo-h3.1-i23d";
const MULTIVIEW = "tripo-h3.1-multiview";

/** The settings only an image entry declares. */
const IMAGE_ONLY = ["texture_alignment", "orientation", "enable_image_autofix"];

/** The forced values every entry declares, in this order. */
const FORCES = [
  { id: "low_poly_skips_parts", when: { flag_on: "smart_low_poly" }, set: { generate_parts: false }, lock: true },
  { id: "parts_geometry_only", when: { flag_on: "generate_parts" }, set: { texture: false, pbr: false }, lock: true },
  { id: "pbr_needs_texture", when: { flag_on: "pbr" }, set: { texture: true }, lock: true },
  {
    id: "fast_uses_v35",
    when: { flag_on: "texture", equals: { texture_quality: "fast" } },
    set: { texture_version: "v3.5" },
    lock: true,
  },
];

/** The rigging step every entry declares (inner#1692, design 6.1). */
const RIG_STEP = {
  endpoint: "tripo3d/rig",
  at: "after",
  for_param: "rig_skeleton",
  optional: true,
  pricing: { base_price: 300_000, formula: "", discount_rate: 100 },
};

/** Each entry's sources and its default generation price in US cents (Standard texture with PBR). */
const DEFAULT_RUNS: readonly { name: string; params: Record<string, unknown>; cents: number }[] = [
  { name: T23D, params: {}, cents: 24 },
  { name: I23D, params: { image: "i" }, cents: 36 },
  { name: MULTIVIEW, params: { images: ["a", "b"] }, cents: 36 },
];

/**
 * One 3D entry as the yaml declares it.
 * @param name - The entry name.
 * @returns The entry.
 * @throws {Error} When the 3D catalog has no such entry.
 */
function declared(name: string): ReturnType<typeof getFullModelConfig>["models"][number] {
  const found = getFullModelConfig("three_d").models.find((m) => m.name === name);
  if (!found) throw new Error(`no 3D entry named ${name}`);
  return found;
}

describe("the 3D model catalog", () => {
  beforeEach(useFullCatalog);
  afterAll(restoreProcessEnv);

  it("holds exactly the three Tripo H3.1 entries", () => {
    expect(getFullModelConfig("three_d").models.map((m) => m.name).sort()).toEqual([I23D, MULTIVIEW, T23D].sort());
  });

  it("carries no Hunyuan3D or Meshy entry in any modality", () => {
    const stale = MODALITIES.flatMap((modality) =>
      getFullModelConfig(modality)
        .models.map((m) => m.name)
        .filter((name) => /hunyuan3d|meshy/i.test(name)),
    );
    expect(stale).toEqual([]);
  });

  it("gives each entry its mode, variant and WaveSpeed endpoint", () => {
    expect(
      [T23D, I23D, MULTIVIEW].map((name) => {
        const m = declared(name);
        return {
          name,
          display_name: m.display_name,
          mode: m.mode,
          variant: m.variant,
          endpoint: m.providers?.find((p) => p.name === "wavespeed")?.model_id,
        };
      }),
    ).toEqual([
      { name: T23D, display_name: "Tripo H3.1", mode: "t23d", variant: undefined, endpoint: "tripo3d/h3.1/text-to-3d" },
      { name: I23D, display_name: "Tripo H3.1", mode: "i23d", variant: "Single image", endpoint: "tripo3d/h3.1/image-to-3d" },
      {
        name: MULTIVIEW,
        display_name: "Tripo H3.1",
        mode: "i23d",
        variant: "Multi-view",
        endpoint: "tripo3d/h3.1/multiview-to-3d",
      },
    ]);
  });

  it("caps the text-to-3D prompt at 1024 and its negative prompt at 255", () => {
    const m = declared(T23D);
    expect(m.takes_prompt).toBe(true);
    expect(m.prompt_max_length).toBe(1024);
    expect(m.params?.negative_prompt).toMatchObject({ type: "text", max_length: 255, fill: "panel" });
  });

  it("takes one image on the single-image entry and two to four on the multi-view entry, no prompt on either", () => {
    const single = declared(I23D);
    const multi = declared(MULTIVIEW);
    expect([single.takes_prompt, multi.takes_prompt]).toEqual([false, false]);
    expect(single.params?.image).toMatchObject({ fill: "canvas", accepts: "image" });
    expect(single.params?.images).toBeUndefined();
    expect(multi.params?.images).toMatchObject({ fill: "canvas", accepts: "image", type: "list", min_items: 2, max_items: 4 });
    expect(multi.params?.image).toBeUndefined();
  });

  it("declares the image-only settings on the image entries alone", () => {
    expect(
      [T23D, I23D, MULTIVIEW].map((name) => IMAGE_ONLY.filter((param) => declared(name).params?.[param] !== undefined)),
    ).toEqual([[], IMAGE_ONLY, IMAGE_ONLY]);
  });

  it("gives every entry the same four forced values, in order", () => {
    for (const name of [T23D, I23D, MULTIVIEW]) {
      expect(declared(name).forces, name).toEqual(FORCES);
    }
  });

  // Tripo: generate_parts is "Not compatible with smart_low_poly; smart_low_poly takes precedence and parts are NOT produced".
  it("turns separate parts off under smart low-poly and leaves the texture the user chose", () => {
    for (const name of [T23D, I23D, MULTIVIEW]) {
      const resolved = resolveParams(declared(name), { smart_low_poly: true, generate_parts: true, texture: true });
      expect([resolved.generate_parts, resolved.texture], name).toEqual([false, true]);
    }
  });

  it("ships forced values, the prompt cap and the new declarations to the panel intact", () => {
    const wire = sanitizeModelCatalog(JSON.parse(JSON.stringify(getModelCatalog())));
    expect(wire.three_d.map((m) => m.name).sort()).toEqual([I23D, MULTIVIEW, T23D].sort());
    for (const entry of wire.three_d) {
      expect(entry.forces, entry.name).toEqual(FORCES);
      expect(entry.params.delight?.when, entry.name).toEqual({ flag_on: "texture", equals: { texture_version: "v3.5" } });
      expect(entry.params.face_limit, entry.name).toMatchObject({
        type: "integer",
        min: 48,
        max: 1_500_000,
        bounds: [
          { when: { flag_on: "smart_low_poly" }, min: 500, max: 20_000 },
          { when: { equals: { geometry_quality: "detailed" } }, max: 2_000_000 },
        ],
      });
      expect([entry.params.model_seed?.type, entry.params.model_seed?.min, entry.params.model_seed?.max], entry.name).toEqual([
        "integer",
        0,
        2_147_483_647,
      ]);
    }
    const t23d = wire.three_d.find((m) => m.name === T23D);
    expect(t23d?.prompt_max_length).toBe(1024);
    expect(t23d?.params.negative_prompt?.max_length).toBe(255);
  });
});

describe("rigging a generated 3D model (inner#1692)", () => {
  beforeEach(useFullCatalog);
  afterAll(restoreProcessEnv);

  it("declares the rig toggle on every entry, off by default and set in the panel", () => {
    for (const name of [T23D, I23D, MULTIVIEW]) {
      expect(declared(name).params?.rig_skeleton, name).toMatchObject({
        label: "Rig skeleton",
        default: false,
        values: [true, false],
        fill: "panel",
      });
    }
  });

  it("declares exactly one extra step on every entry: the optional rig after generation", () => {
    for (const name of [T23D, I23D, MULTIVIEW]) {
      expect(declared(name).extra_steps, name).toEqual([RIG_STEP]);
    }
  });

  it("ships the rig toggle and the optional rig step to the panel intact", () => {
    const wire = sanitizeModelCatalog(JSON.parse(JSON.stringify(getModelCatalog())));
    expect(wire.three_d).toHaveLength(3);
    for (const entry of wire.three_d) {
      expect(entry.extra_steps, entry.name).toEqual([RIG_STEP]);
      expect(entry.params.rig_skeleton, entry.name).toMatchObject({ default: false, values: [true, false], fill: "panel" });
    }
  });

  it("prices the rig on top of the generation when the toggle is on, and leaves it out when off", async () => {
    const multiplier = getModelCatalog().credit_multiplier;
    for (const run of DEFAULT_RUNS) {
      const off = await estimateModelCredits(run.name, { params: { ...run.params, rig_skeleton: false } });
      const unset = await estimateModelCredits(run.name, { params: run.params });
      const on = await estimateModelCredits(run.name, { params: { ...run.params, rig_skeleton: true } });
      expect(off, run.name).toEqual({ credits: expect.closeTo(run.cents * multiplier, 6) as number, bound: "exact" });
      expect(unset, run.name).toEqual(off);
      expect(on, run.name).toEqual({ credits: expect.closeTo((run.cents + 30) * multiplier, 6) as number, bound: "exact" });
    }
  });
});
