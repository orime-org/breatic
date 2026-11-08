// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Character poses on a scene object (inner#1692, design 2.1): one flat
 * `pose.`-prefixed key per bone on the stored record, gathered into a `pose`
 * object before validation and expanded back into flat keys on write.
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
const QUARTER_TURN = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
const IDENTITY = [0, 0, 0, 1];

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
 * The pose schema.
 * @returns ScenePoseSchema.
 * @throws {AssertionError} When it is not exported.
 */
function poseSchema(): ZodType {
  return exported<ZodType>("ScenePoseSchema");
}

/**
 * The object values schema.
 * @returns SceneObjectValuesSchema.
 * @throws {AssertionError} When it is not exported.
 */
function valuesSchema(): ZodType {
  return exported<ZodType>("SceneObjectValuesSchema");
}

type Gather = (record: Readonly<Record<string, unknown>>) => Record<string, unknown>;
type Expand = (pose: Record<string, unknown>) => Record<string, unknown>;

/**
 * Builds a pose with `count` distinct humanoid keys.
 * @param count - How many keys.
 * @returns The pose.
 */
function poseOf(count: number): Record<string, unknown> {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`h:bone${i}`, IDENTITY]));
}

describe("scene pose constants", () => {
  it("names the prefix, the key cap and the key length cap", () => {
    expect(exported<string>("SCENE_POSE_KEY_PREFIX")).toBe("pose.");
    expect(exported<number>("SCENE_POSE_MAX_KEYS")).toBe(256);
    expect(exported<number>("SCENE_POSE_KEY_MAX_LENGTH")).toBe(128);
  });
});

describe("ScenePoseSchema", () => {
  it("accepts humanoid and node rotations and the hips translation, values unchanged", () => {
    const pose = { "h:leftUpperArm": QUARTER_TURN, "n:tail_01": IDENTITY, "t:hips": [0, -0.5, 0.25] };
    expect(poseSchema().parse(pose)).toEqual(pose);
  });

  it.each([
    ["h:a", true],
    ["n:a", true],
    ["h:", false],
    ["n:", false],
    [`h:${"a".repeat(126)}`, true],
    [`h:${"a".repeat(127)}`, false],
    [`n:${"a".repeat(126)}`, true],
    [`n:${"a".repeat(127)}`, false],
  ] as [string, boolean][])("judges the rotation key %s by its length: accepted %s", (key, accepted) => {
    expect(poseSchema().safeParse({ [key]: IDENTITY }).success).toBe(accepted);
  });

  it.each([
    "hips", "x:hips", "H:leftUpperArm", "t:spine", "t:hips2", "t:", "pose.h:leftUpperArm", "",
    ":leftUpperArm", "h", "__proto__", "constructor",
  ])("rejects the key %j", (key) => {
    const value = key.startsWith("t:") ? [0, 0, 0] : IDENTITY;
    expect(poseSchema().safeParse(JSON.parse(JSON.stringify({ [key]: value }))).success).toBe(false);
  });

  it.each([
    ["h:leftUpperArm", [0, 0, 0, 2]],
    ["h:leftUpperArm", [0, 0, 0, 0]],
    ["h:leftUpperArm", [0, 0, 1]],
    ["h:leftUpperArm", [0, 0, 0, 1, 0]],
    ["h:leftUpperArm", [Number.NaN, 0, 0, 1]],
    ["h:leftUpperArm", "0,0,0,1"],
    ["n:tail", [0, 0, 0, 2]],
    ["n:tail", [0, 0, 0]],
    ["t:hips", [0, 0, 0, 1]],
    ["t:hips", [0, 0]],
    ["t:hips", [0, Number.POSITIVE_INFINITY, 0]],
    ["t:hips", { x: 0, y: 0, z: 0 }],
    ["t:hips", null],
  ] as [string, unknown][])("rejects the value of %s shaped %j", (key, value) => {
    expect(poseSchema().safeParse({ [key]: value }).success).toBe(false);
  });

  it("accepts the 256th key and rejects the 257th", () => {
    expect(poseSchema().safeParse(poseOf(256)).success).toBe(true);
    expect(poseSchema().safeParse(poseOf(257)).success).toBe(false);
  });

  it("rejects a whole pose when one of its keys is invalid", () => {
    expect(poseSchema().safeParse({ "h:leftUpperArm": IDENTITY, "q:other": IDENTITY }).success).toBe(false);
  });

  it.each([null, [], "h:leftUpperArm", 1])("rejects a pose that is not a record: %j", (pose) => {
    expect(poseSchema().safeParse(pose).success).toBe(false);
  });
});

describe("SceneObjectValuesSchema with a pose", () => {
  it("accepts values with a valid pose and returns it intact", () => {
    const values = { ...VALUES, pose: { "h:leftUpperArm": QUARTER_TURN, "t:hips": [0, 0, 0] } };
    expect(valuesSchema().parse(values)).toEqual(values);
  });

  it("still accepts values without a pose, adding none", () => {
    const parsed = valuesSchema().parse(VALUES) as Record<string, unknown>;
    expect(parsed).toEqual(VALUES);
    expect("pose" in parsed).toBe(false);
  });

  it.each([
    { pose: { "h:leftUpperArm": [0, 0, 0, 2] } },
    { pose: { "x:leftUpperArm": IDENTITY } },
    { pose: poseOf(257) },
    { pose: "none" },
  ])("rejects values with an invalid pose %#", (invalid) => {
    expect(valuesSchema().safeParse({ ...VALUES, ...invalid }).success).toBe(false);
  });

  it("stays strict: a flat pose key or an unknown key is rejected", () => {
    expect(valuesSchema().safeParse({ ...VALUES, "pose.h:leftUpperArm": IDENTITY }).success).toBe(false);
    expect(valuesSchema().safeParse({ ...VALUES, poses: {} }).success).toBe(false);
  });
});

describe("gatherScenePose", () => {
  it("leaves a record without pose keys as an equal copy with no pose field", () => {
    const record = { ...VALUES };
    const gathered = exported<Gather>("gatherScenePose")(record);
    expect(gathered).toEqual(VALUES);
    expect(gathered).not.toBe(record);
    expect(Object.prototype.hasOwnProperty.call(gathered, "pose")).toBe(false);
  });

  it("moves every pose key, prefix stripped, into one pose object and keeps the rest", () => {
    const record = {
      ...VALUES,
      "pose.h:leftUpperArm": QUARTER_TURN,
      "pose.n:tail": IDENTITY,
      "pose.t:hips": [0, -0.5, 0],
    };
    const gathered = exported<Gather>("gatherScenePose")(record);
    expect(gathered).toEqual({
      ...VALUES,
      pose: { "h:leftUpperArm": QUARTER_TURN, "n:tail": IDENTITY, "t:hips": [0, -0.5, 0] },
    });
    expect(Object.keys(gathered).filter((key) => key.startsWith("pose."))).toEqual([]);
  });

  it("does not change the record it reads", () => {
    const record = { ...VALUES, "pose.h:leftUpperArm": QUARTER_TURN };
    const before = structuredClone(record);
    exported<Gather>("gatherScenePose")(record);
    expect(record).toEqual(before);
  });

  it("collects only keys that start with the exact prefix", () => {
    const record = { "Pose.h:a": 1, "posed.h:a": 2, "xpose.h:a": 3, "pose.h:a": IDENTITY };
    expect(exported<Gather>("gatherScenePose")(record)).toEqual({
      "Pose.h:a": 1, "posed.h:a": 2, "xpose.h:a": 3, pose: { "h:a": IDENTITY },
    });
  });

  it("collects an invalid pose key as it is, so validation rejects the record instead of hiding it", () => {
    const gathered = exported<Gather>("gatherScenePose")({ ...VALUES, "pose.q:x": IDENTITY });
    expect(gathered).toEqual({ ...VALUES, pose: { "q:x": IDENTITY } });
    expect(valuesSchema().safeParse(gathered).success).toBe(false);
  });

  it("yields values the object schema accepts when the stored pose is valid", () => {
    const gathered = exported<Gather>("gatherScenePose")({ ...VALUES, "pose.h:leftUpperArm": QUARTER_TURN });
    expect(valuesSchema().safeParse(gathered).success).toBe(true);
  });
});

describe("expandScenePose", () => {
  it("writes each pose entry as one flat prefixed key", () => {
    const pose = { "h:leftUpperArm": QUARTER_TURN, "n:tail": IDENTITY, "t:hips": [0, 1, 0] };
    expect(exported<Expand>("expandScenePose")(pose)).toEqual({
      "pose.h:leftUpperArm": QUARTER_TURN,
      "pose.n:tail": IDENTITY,
      "pose.t:hips": [0, 1, 0],
    });
  });

  it("writes nothing for an empty pose", () => {
    expect(exported<Expand>("expandScenePose")({})).toEqual({});
  });
});

/** A pose key a stored record can hold. */
const poseKey = fc.oneof(
  fc.constant("t:hips"),
  fc.tuple(fc.constantFrom("h:", "n:"), fc.string({ minLength: 1, maxLength: 126 })).map(([tag, name]) => tag + name),
);
/** Any tuple; gather and expand carry values without reading them. */
const poseValue = fc.oneof(
  fc.tuple(fc.double(), fc.double(), fc.double()),
  fc.tuple(fc.double(), fc.double(), fc.double(), fc.double()),
);
/** A record key that is neither a pose key nor the gathered field. */
const otherKey = fc.string().filter((key) => !key.startsWith("pose.") && key !== "pose" && key !== "__proto__");

describe("gather and expand round trip", () => {
  it("gathering an expanded pose beside other fields gives back the pose and the fields", () => {
    const gather = exported<Gather>("gatherScenePose");
    const expand = exported<Expand>("expandScenePose");
    fc.assert(
      fc.property(
        fc.dictionary(otherKey, fc.jsonValue(), { maxKeys: 8 }),
        fc.dictionary(poseKey, poseValue, { minKeys: 1, maxKeys: 16 }),
        (rest, pose) => {
          const flat = { ...rest, ...expand(pose) };
          const gathered = gather(flat);
          expect(gathered).toEqual({ ...rest, pose });
          const { pose: back, ...fields } = gathered;
          expect({ ...fields, ...expand(back as Record<string, unknown>) }).toEqual(flat);
        },
      ),
    );
  });

  it("a record without pose keys gathers to an equal record with no pose field", () => {
    const gather = exported<Gather>("gatherScenePose");
    fc.assert(
      fc.property(fc.dictionary(otherKey, fc.jsonValue(), { maxKeys: 8 }), (rest) => {
        const gathered = gather(rest);
        expect(gathered).toEqual(rest);
        expect(Object.prototype.hasOwnProperty.call(gathered, "pose")).toBe(false);
      }),
    );
  });
});
