// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Part appearance on a scene object (inner#1693, design 4.1): one flat
 * `look.<part>.<field>`-prefixed key per changed field on the stored record,
 * gathered into a `look` object before validation and expanded back on write.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import * as shared from "../index.js";

const VALUES = {
  name: "Figure", model: { kind: "builtin", id: "figure" },
  position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
  locked: false,
};
const CAMERA = {
  ...VALUES, name: "Camera 1", model: { kind: "camera" }, number: 1, focalLength: 35, frame: "16:9",
};
const LIGHT = {
  ...VALUES, name: "Light 1", model: { kind: "light", type: "point" }, number: 1, color: "#ffffff", intensity: 10, castShadow: true,
};
const ASSET_ID = "4b7f3c1e-2d0a-4c6b-9f1e-8a5b2c3d4e5f";
const ID = "0b8c7f1a-3e2d-4a5b-8c9d-0e1f2a3b4c5d";

/**
 * Reads a public export without preventing RED test collection.
 * @param name - The export's name.
 * @returns The exported value.
 * @throws {AssertionError} When the export is missing.
 */
function exported<T>(name: string): T {
  const candidate = (shared as unknown as Record<string, unknown>)[name];
  expect(candidate, `${name} must be exported from shared`).toBeDefined();
  return candidate as T;
}

/**
 * The look schema.
 * @returns SceneLookSchema.
 * @throws {AssertionError} When it is not exported.
 */
function lookSchema(): ZodType {
  return exported<ZodType>("SceneLookSchema");
}

/**
 * Gathers a record's flat look keys.
 * @param record - A stored record's plain values.
 * @returns The record with a `look` value in place of the flat keys.
 * @throws {AssertionError} When gatherSceneLook is not exported.
 */
function gather(record: Record<string, unknown>): Record<string, unknown> {
  return exported<(record: Record<string, unknown>) => Record<string, unknown>>("gatherSceneLook")(record);
}

/**
 * Expands a look into its flat record keys.
 * @param look - A look value.
 * @returns The flat keys.
 * @throws {AssertionError} When expandSceneLook is not exported.
 */
function expand(look: Record<string, unknown>): Record<string, unknown> {
  return exported<(look: Record<string, unknown>) => Record<string, unknown>>("expandSceneLook")(look);
}

/**
 * Validates a whole object record after gathering its look keys.
 * @param record - The stored values including the id.
 * @returns Whether SceneObjectSchema accepts it.
 */
function objectAccepts(record: Record<string, unknown>): boolean {
  return shared.SceneObjectSchema.safeParse(gather(record)).success;
}

describe("scene look keys", () => {
  it("names the record key prefix", () => {
    expect(exported<string>("SCENE_LOOK_KEY_PREFIX")).toBe("look.");
  });

  it("accepts every field at its documented bounds", () => {
    const look = {
      0: {
        color: "#ff0000", roughness: 0, metalness: 1, opacity: 0, transmission: 1,
        emissive: "#000000", emissiveIntensity: 10, map: ASSET_ID,
        mapRepeat: [0.0001, 10000], mapOffset: [-100, 100], mapRotation: -180,
      },
      9999: { roughness: 1, opacity: 1, transmission: 0, emissiveIntensity: 0, mapRotation: 180, mapRepeat: [-10000, -0.0001] },
      d: { map: "none" },
    };
    expect(lookSchema().safeParse(look).success).toBe(true);
  });

  it.each([
    ["a part key over 9999", { 10000: { color: "#ffffff" } }],
    ["a negative part key", { "-1": { color: "#ffffff" } }],
    ["a part key with a leading zero", { "01": { color: "#ffffff" } }],
    ["a letter part key other than d", { e: { color: "#ffffff" } }],
    ["a __proto__ part key", JSON.parse('{"__proto__": {"color": "#ffffff"}}') as unknown],
    ["an unknown field", { 0: { gloss: 0.5 } }],
    ["an upper-case colour", { 0: { color: "#FFFFFF" } }],
    ["a short colour", { 0: { color: "#fff" } }],
    ["roughness above 1", { 0: { roughness: 1.01 } }],
    ["metalness below 0", { 0: { metalness: -0.01 } }],
    ["opacity above 1", { 0: { opacity: 1.5 } }],
    ["transmission below 0", { 0: { transmission: -1 } }],
    ["a glow intensity above 10", { 0: { emissiveIntensity: 10.01 } }],
    ["a non-finite value", { 0: { roughness: Number.NaN } }],
    ["a map that is neither a uuid nor none", { 0: { map: "img.png" } }],
    ["a tiling of 0", { 0: { mapRepeat: [0, 1] } }],
    ["a tiling above 10000", { 0: { mapRepeat: [1, 10000.5] } }],
    ["a mirrored tiling below -10000", { 0: { mapRepeat: [-10000.5, 1] } }],
    ["a mirrored tiling nearer 0 than -0.0001", { 0: { mapRepeat: [-0.00005, 1] } }],
    ["a tiling with one value", { 0: { mapRepeat: [1] } }],
    ["an offset beyond 100", { 0: { mapOffset: [100.5, 0] } }],
    ["a rotation beyond 180", { 0: { mapRotation: 181 } }],
  ])("refuses %s", (_label, look) => {
    expect(lookSchema().safeParse(look).success).toBe(false);
  });

  it("judges a look by its parts, not by how many there are: the 256-part cap is where a command writes", () => {
    const parts = (count: number): Record<string, unknown> =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [String(index), { opacity: 0.5 }]));
    expect(exported<number>("SCENE_LOOK_MAX_PARTS")).toBe(256);
    expect(lookSchema().safeParse(parts(257)).success).toBe(true);
  });
});

describe("gatherSceneLook and expandSceneLook", () => {
  it("stores one flat key per part field", () => {
    expect(expand({ 0: { color: "#112233", mapRepeat: [2, 2] }, d: { map: "none" } })).toEqual({
      "look.0.color": "#112233", "look.0.mapRepeat": [2, 2], "look.d.map": "none",
    });
  });

  it("gathers the flat keys into one look and keeps the other values", () => {
    const record = { ...VALUES, id: ID, "look.0.color": "#112233", "look.0.opacity": 0.5, "look.d.map": "none" };
    expect(gather(record)).toEqual({ ...VALUES, id: ID, look: { 0: { color: "#112233", opacity: 0.5 }, d: { map: "none" } } });
  });

  it("leaves a record without look keys without a look", () => {
    const gathered = gather({ ...VALUES, id: ID });
    expect(gathered).toEqual({ ...VALUES, id: ID });
    expect("look" in gathered).toBe(false);
  });

  it("gathers a __proto__ part as an own key, which the schema then refuses", () => {
    const record = { ...VALUES, id: ID, "look.__proto__.color": "#112233" };
    const gathered = gather(record);
    expect(Object.prototype.hasOwnProperty.call(gathered.look, "__proto__")).toBe(true);
    expect(shared.SceneObjectSchema.safeParse(gathered).success).toBe(false);
  });

  it.each([
    ["a key without a field", "look.0"],
    ["a key with an empty part", "look..color"],
    ["a key with an extra segment", "look.0.color.extra"],
  ])("leaves %s to be refused", (_label, key) => {
    expect(objectAccepts({ ...VALUES, id: ID, [key]: "#112233" })).toBe(false);
  });

  it("round-trips any valid look", () => {
    const part = fc.oneof(fc.integer({ min: 0, max: 9999 }).map(String), fc.constant("d"));
    const fields = fc.record({
      color: fc.constantFrom("#000000", "#ffffff", "#3b6fd8"),
      roughness: fc.double({ min: 0, max: 1, noNaN: true }),
      map: fc.constantFrom(ASSET_ID, "none"),
      mapRepeat: fc.tuple(fc.double({ min: 0.01, max: 100, noNaN: true }), fc.double({ min: 0.01, max: 100, noNaN: true })),
    }, { requiredKeys: ["color"] });
    fc.assert(fc.property(fc.dictionary(part, fields, { maxKeys: 8 }), (look) => {
      const gathered = gather({ ...VALUES, id: ID, ...expand(look) });
      expect(gathered.look ?? {}).toEqual(look);
      expect(lookSchema().safeParse(look).success).toBe(true);
    }));
  });
});

describe("which kinds carry a look", () => {
  it("accepts a look on a built-in model and on an asset model", () => {
    expect(objectAccepts({ ...VALUES, id: ID, "look.0.color": "#112233" })).toBe(true);
    expect(objectAccepts({ ...VALUES, id: ID, model: { kind: "asset", assetId: ASSET_ID }, "look.2.map": ASSET_ID })).toBe(true);
  });

  it("refuses a look on a camera and on a light", () => {
    expect(objectAccepts({ ...CAMERA, id: ID })).toBe(true);
    expect(objectAccepts({ ...CAMERA, id: ID, "look.0.color": "#112233" })).toBe(false);
    expect(objectAccepts({ ...LIGHT, id: ID })).toBe(true);
    expect(objectAccepts({ ...LIGHT, id: ID, "look.0.color": "#112233" })).toBe(false);
  });

  it("keeps an older record without look keys valid", () => {
    expect(shared.SceneObjectSchema.safeParse({ ...VALUES, id: ID }).success).toBe(true);
  });
});
