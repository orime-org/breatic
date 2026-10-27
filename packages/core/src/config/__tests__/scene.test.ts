// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import { getSceneConfig, sceneConfigSchema } from "@core/config/scene.js";

describe("3D scene runtime configuration", () => {
  it("loads the shipped uniform-scale sensitivity and caches a frozen value", () => {
    const config = getSceneConfig();
    expect(config).toEqual({ scale_sensitivity: 0.01 });
    expect(getSceneConfig()).toBe(config);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("uses the approved default when the YAML field is absent", () => {
    expect(sceneConfigSchema.parse({})).toEqual({ scale_sensitivity: 0.01 });
  });

  it.each([0.001, 0.01, 0.1, 1])("accepts a positive sensitivity of %s", (value) => {
    expect(sceneConfigSchema.parse({ scale_sensitivity: value })).toEqual({ scale_sensitivity: value });
  });

  it.each([0, -0.01, NaN, Infinity, -Infinity, "0.01", null])(
    "rejects a non-positive or non-finite sensitivity of %s",
    (value) => {
      expect(() => sceneConfigSchema.parse({ scale_sensitivity: value })).toThrow();
    },
  );
});
