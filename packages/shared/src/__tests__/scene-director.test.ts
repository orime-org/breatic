// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import * as shared from "../index.js";

const ID = "11111111-1111-4111-8111-111111111111";
const POSE = { position: [0, 1, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false };
const CAMERA = { id: ID, name: "Camera 1", model: { kind: "camera" }, ...POSE, number: 1, focalLength: 35, frame: "16:9" };
const LIGHT = { id: ID, name: "Spotlight 1", model: { kind: "light", type: "spot" }, ...POSE, number: 1, color: "#ffffff", intensity: 2, castShadow: true, angle: 30 };

/**
 * Returns a required public export without preventing RED test collection.
 * @throws {AssertionError} When the export is missing.
 */
function exported(name: string): unknown {
  const value = (shared as unknown as Record<string, unknown>)[name];
  expect(value, `${name} must be exported from shared`).toBeDefined();
  return value;
}

/** The scene object schema. */
function objectSchema(): ZodType {
  return exported("SceneObjectSchema") as ZodType;
}

describe("director console object kinds (inner#1694 design 4.1, 4.2)", () => {
  it("accepts a camera and the three light types as scene models", () => {
    const model = exported("SceneModelSchema") as ZodType;
    expect(model.safeParse({ kind: "camera" }).success).toBe(true);
    for (const type of ["directional", "point", "spot"]) expect(model.safeParse({ kind: "light", type }).success).toBe(true);
    expect(model.safeParse({ kind: "light", type: "area" }).success).toBe(false);
  });

  it("accepts a camera record with its number, focal length and frame", () => {
    expect(objectSchema().safeParse(CAMERA).success).toBe(true);
    expect(objectSchema().safeParse({ ...CAMERA, frame: "Free", freeRatio: 2 }).success).toBe(true);
  });

  it("accepts a light record with its colour, intensity, shadow switch and spot angle", () => {
    expect(objectSchema().safeParse(LIGHT).success).toBe(true);
    const { angle: _angle, ...point } = LIGHT;
    expect(objectSchema().safeParse({ ...point, model: { kind: "light", type: "point" } }).success).toBe(true);
  });

  it.each([
    ["no number", { ...CAMERA, number: undefined }],
    ["a zero number", { ...CAMERA, number: 0 }],
    ["a fractional number", { ...CAMERA, number: 1.5 }],
    ["a focal length under 8 mm", { ...CAMERA, focalLength: 7 }],
    ["a focal length over 300 mm", { ...CAMERA, focalLength: 301 }],
    ["an unknown frame", { ...CAMERA, frame: "21:9" }],
    ["a free ratio under 0.2", { ...CAMERA, frame: "Free", freeRatio: 0.19 }],
    ["a free ratio over 5", { ...CAMERA, frame: "Free", freeRatio: 5.01 }],
    ["a light key", { ...CAMERA, intensity: 2 }],
    ["a scale other than one", { ...CAMERA, scale: [2, 2, 2] }],
    ["a pose", { ...CAMERA, pose: { "t:hips": [0, 0, 0] } }],
  ])("rejects a camera with %s", (_label, record) => {
    expect(objectSchema().safeParse(record).success).toBe(false);
  });

  it.each([
    ["no number", { ...LIGHT, number: undefined }],
    ["a colour that is not #rrggbb", { ...LIGHT, color: "white" }],
    ["a negative intensity", { ...LIGHT, intensity: -1 }],
    ["a spot angle under 5 degrees", { ...LIGHT, angle: 4 }],
    ["a spot angle over 80 degrees", { ...LIGHT, angle: 81 }],
    ["an angle on a point light", { ...LIGHT, model: { kind: "light", type: "point" } }],
    ["a camera key", { ...LIGHT, focalLength: 35 }],
    ["a scale other than one", { ...LIGHT, scale: [1, 2, 1] }],
  ])("rejects a light with %s", (_label, record) => {
    expect(objectSchema().safeParse(record).success).toBe(false);
  });

  it("rejects director keys on a builtin or asset object", () => {
    const figure = { id: ID, name: "Figure", model: { kind: "builtin", id: "figure" }, ...POSE };
    expect(objectSchema().safeParse(figure).success).toBe(true);
    expect(objectSchema().safeParse({ ...figure, number: 1 }).success).toBe(false);
    expect(objectSchema().safeParse({ ...figure, focalLength: 35 }).success).toBe(false);
    expect(objectSchema().safeParse({ ...figure, intensity: 1 }).success).toBe(false);
  });

  it("caps a directional light at intensity 20", () => {
    const sun = { ...LIGHT, model: { kind: "light", type: "directional" }, angle: undefined };
    expect(objectSchema().safeParse({ ...sun, intensity: 20 }).success).toBe(true);
    expect(objectSchema().safeParse({ ...sun, intensity: 20.01 }).success).toBe(false);
  });
});

describe("shared frame list and free ratio bounds (design 4.2)", () => {
  it("exports the viewfinder frames with 16:9 as the default", () => {
    expect(exported("VIEWFINDER_RATIOS")).toEqual(["Free", "16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"]);
    expect(exported("DEFAULT_VIEWFINDER_RATIO")).toBe("16:9");
  });

  it("exports the free ratio bounds the schema and the frame geometry share", () => {
    expect(exported("SCENE_FREE_RATIO_MIN")).toBe(0.2);
    expect(exported("SCENE_FREE_RATIO_MAX")).toBe(5);
  });
});
