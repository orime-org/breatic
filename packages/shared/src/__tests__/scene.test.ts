// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import * as shared from "../index.js";

const ID = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";
const VALUES = {
  name: "Figure", model: { kind: "builtin", id: "figure" },
  position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
  locked: false, exists: true,
};

/**
 * Returns a required public schema without preventing RED test collection.
 * @throws {AssertionError} When the required schema is not exported.
 */
function schema(name: string): ZodType {
  const candidate = (shared as unknown as Record<string, unknown>)[name] as ZodType | undefined;
  expect(typeof candidate?.safeParse, `${name} must be exported from shared`).toBe("function");
  return candidate as ZodType;
}

describe("scene value schemas", () => {
  it("declares exactly the six complete-value editable fields", () => {
    expect((shared as unknown as Record<string, unknown>).SCENE_EDITABLE_FIELDS).toEqual([
      "name", "position", "rotation", "scale", "locked", "exists",
    ]);
  });

  it("accepts a finite position tuple without changing its values", () => {
    expect(schema("SceneVectorSchema").parse([-2.5, 0, 7])).toEqual([-2.5, 0, 7]);
  });

  it.each([[0, 0], [0, 0, 0, 0], [Infinity, 0, 0], [0, NaN, 0], [0, 0, -Infinity], ["0", 0, 0]].map((position) => ({ position })))(
    "rejects an incomplete or nonfinite position $position", ({ position }) => {
      expect(schema("SceneVectorSchema").safeParse(position).success).toBe(false);
    },
  );

  it.each([[0, 0, 0, 1], [0, 1, 0, 0], [0.5, 0.5, 0.5, 0.5]].map((rotation) => ({ rotation })))(
    "accepts a normalized XYZW rotation $rotation", ({ rotation }) => {
      expect(schema("SceneRotationSchema").parse(rotation)).toEqual(rotation);
    },
  );

  it.each([[0, 0, 0, 0], [0, 0, 0, 2], [0, 0, 1], [0, 0, 0, 1, 0], [Infinity, 0, 0, 1], [0, NaN, 0, 1]].map((rotation) => ({ rotation })))(
    "rejects a nonunit or malformed rotation $rotation", ({ rotation }) => {
      expect(schema("SceneRotationSchema").safeParse(rotation).success).toBe(false);
    },
  );

  it("accepts three independently positive scale values", () => {
    expect(schema("SceneScaleSchema").parse([0.25, 2, 3])).toEqual([0.25, 2, 3]);
  });

  it.each([[0, 1, 1], [1, -1, 1], [1, 1, Infinity], [1, NaN, 1], [1, 1], [1, 1, 1, 1]].map((scale) => ({ scale })))(
    "rejects a nonpositive or malformed scale $scale", ({ scale }) => {
      expect(schema("SceneScaleSchema").safeParse(scale).success).toBe(false);
    },
  );

  it.each([{ kind: "builtin", id: "figure" }, { kind: "builtin", id: "box" }, { kind: "asset", assetId: ASSET }])(
    "accepts a stable model reference %j", (model) => {
      expect(schema("SceneModelSchema").parse(model)).toEqual(model);
    },
  );

  it.each([{ kind: "asset", assetId: "" }, { kind: "asset", assetId: "not-a-uuid" }, { kind: "asset" }, { kind: "url", url: "https://example.com/model.glb" }])(
    "rejects a model without a supported stable identity %j", (model) => {
      expect(schema("SceneModelSchema").safeParse(model).success).toBe(false);
    },
  );

  it("accepts complete values separately from an object identity", () => {
    expect(schema("SceneObjectValuesSchema").parse(VALUES)).toEqual(VALUES);
    expect(schema("SceneObjectSchema").parse({ id: ID, ...VALUES })).toEqual({ id: ID, ...VALUES });
  });

  it.each([
    { id: "not-a-uuid" }, { name: "" }, { name: "   " }, { model: {} },
    { position: [0, 0] }, { rotation: [0, 0, 0, 0] }, { scale: [1, 0, 1] },
    { locked: "false" }, { exists: "true" },
  ])("rejects an invalid object field %j", (invalid) => {
    expect(schema("SceneObjectSchema").safeParse({ id: ID, ...VALUES, ...invalid }).success).toBe(false);
  });

  it.each(["name", "model", "position", "rotation", "scale", "locked", "exists"])(
    "requires the complete %s field", (field) => {
      const incomplete: Record<string, unknown> = { ...VALUES };
      delete incomplete[field];
      expect(schema("SceneObjectValuesSchema").safeParse(incomplete).success).toBe(false);
    },
  );
});
