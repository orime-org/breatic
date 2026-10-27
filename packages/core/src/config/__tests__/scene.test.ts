// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import { getSceneConfig, sceneConfigSchema } from "@core/config/scene.js";

const IMPORT_DEFAULTS = {
  max_input_bytes: 67108864,
  max_expanded_bytes: 268435456,
  max_artifact_bytes: 268435456,
  max_files: 4096,
  max_entry_json_bytes: 4194304,
  decoder_worker_limit: 1,
  max_texture_edge: 8192,
  max_texture_bytes: 268435456,
};
const IMPORT_FIELDS = Object.keys(IMPORT_DEFAULTS) as (keyof typeof IMPORT_DEFAULTS)[];

describe("3D scene runtime configuration", () => {
  it("loads the shipped uniform-scale sensitivity and caches a frozen value", () => {
    const config = getSceneConfig();
    expect(config).toEqual({ scale_sensitivity: 0.01, import: IMPORT_DEFAULTS });
    expect(getSceneConfig()).toBe(config);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("uses the approved default when the YAML field is absent", () => {
    expect(sceneConfigSchema.parse({})).toEqual({ scale_sensitivity: 0.01, import: IMPORT_DEFAULTS });
  });

  it.each([0.001, 0.01, 0.1, 1])("accepts a positive sensitivity of %s", (value) => {
    expect(sceneConfigSchema.parse({ scale_sensitivity: value })).toEqual({ scale_sensitivity: value, import: IMPORT_DEFAULTS });
  });

  it.each([0, -0.01, NaN, Infinity, -Infinity, "0.01", null])(
    "rejects a non-positive or non-finite sensitivity of %s",
    (value) => {
      expect(() => sceneConfigSchema.parse({ scale_sensitivity: value })).toThrow();
    },
  );
});

describe("scene model import budgets", () => {
  it("uses the same approved defaults for an omitted or empty import section", () => {
    expect(sceneConfigSchema.parse({}).import).toEqual(IMPORT_DEFAULTS);
    expect(sceneConfigSchema.parse({ import: {} }).import).toEqual(IMPORT_DEFAULTS);
  });

  it("preserves every configured budget and the scale sensitivity", () => {
    const configured = {
      max_input_bytes: 33554432,
      max_expanded_bytes: 134217728,
      max_artifact_bytes: 150994944,
      max_files: 2048,
      max_entry_json_bytes: 2097152,
      decoder_worker_limit: 2,
      max_texture_edge: 4096,
      max_texture_bytes: 100663296,
    };

    expect(sceneConfigSchema.parse({ scale_sensitivity: 0.025, import: configured })).toEqual({
      scale_sensitivity: 0.025, import: configured,
    });
  });

  it.each(IMPORT_FIELDS)("overrides %s while retaining the other defaults", (field) => {
    expect(sceneConfigSchema.parse({ import: { [field]: 7 } }).import).toEqual({
      ...IMPORT_DEFAULTS, [field]: 7,
    });
  });

  it.each(IMPORT_FIELDS)("rejects invalid values for %s", (field) => {
    for (const value of [0, -1, 0.5, NaN, Infinity, -Infinity, "1", null, false, [], {}]) {
      const result = sceneConfigSchema.safeParse({ import: { [field]: value } });

      expect(result.success, `Invalid ${field} was accepted: ${String(value)}`).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(["import", field]);
    }
  });

  it.each([
    { label: "null", value: null },
    { label: "an array", value: [] },
    { label: "a string", value: "import" },
    { label: "a boolean", value: false },
    { label: "a number", value: 1 },
  ])("rejects an import section written as $label", ({ value }) => {
    expect(sceneConfigSchema.safeParse({ import: value }).success).toBe(false);
  });
});
