// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Qwen Image Multiple Angles declares its three camera params as one pose,
 * and the declaration has to match the grid the upstream rounds to.
 *
 * Read off the real config where the point is what the real files say.
 */

import { CAMERA_ANGLE_GRID } from "@breatic/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { assertCameraAngle } from "../camera-angle.js";
import { getFullModelConfig, getModelCatalog } from "../model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

const QWEN = "qwen-image-edit-multiple-angles";

/** The three params a valid declaration names, laid out on the grid. */
const ON_GRID = {
  horizontal_angle: { label: "Horizontal angle", default: 0, min: 0, max: 315, step: 45, fill: "panel" },
  vertical_angle: { label: "Vertical angle", default: 0, min: -30, max: 60, step: 30, fill: "panel" },
  distance: { label: "Distance", default: 1, min: 0, max: 2, step: 1, fill: "panel" },
};

const DECLARED = { azimuth: "horizontal_angle", elevation: "vertical_angle", distance: "distance" };

describe("what the Qwen multiple-angles entry declares", () => {
  it("names its three params as one camera pose", () => {
    const model = getFullModelConfig("image").models.find((m) => m.name === QWEN);
    expect(model?.camera_angle).toEqual(DECLARED);
  });

  it("lays the three params out exactly on the grid the upstream rounds to", () => {
    const params = getFullModelConfig("image").models.find((m) => m.name === QWEN)?.params ?? {};
    expect(params.horizontal_angle).toMatchObject({ min: 0, max: 315, step: 45 });
    expect(params.vertical_angle).toMatchObject({ min: -30, max: 60, step: 30 });
    expect(params.distance).toMatchObject({ min: 0, max: 2, step: 1 });
  });

  it("says in each description what its values mean, with 90 as the subject's own right", () => {
    const params = getFullModelConfig("image").models.find((m) => m.name === QWEN)?.params ?? {};
    expect(params.horizontal_angle?.description).toMatch(/90 the subject's own right side/);
    expect(params.horizontal_angle?.description).toMatch(/270 the subject's own left side/);
    expect(params.vertical_angle?.description).toMatch(/-30 low angle/);
    expect(params.vertical_angle?.description).toMatch(/60 high angle/);
    expect(params.distance?.description).toMatch(/0 close-up, 1 medium shot, 2 wide shot/);
  });
});

describe("the loader's check", () => {
  /**
   * Runs the check over one model declaring this pose over these params.
   * @param cameraAngle - What the model declares.
   * @param params - The model's params.
   * @returns Nothing; throws when refused.
   */
  const check = (cameraAngle: unknown, params: Record<string, unknown> = ON_GRID): void =>
    assertCameraAngle("image", [{ name: "m", camera_angle: cameraAngle, params }]);

  it("accepts a model without one and a model whose three params sit on the grid", () => {
    expect(() => check(undefined)).not.toThrow();
    expect(() => check(DECLARED)).not.toThrow();
  });

  it("refuses a declaration naming a param the model does not have", () => {
    expect(() => check({ ...DECLARED, distance: "zoom" })).toThrow(
      /config\/models\/image: m declares camera_angle distance 'zoom'/,
    );
  });

  it("refuses a param that is not a labelled panel range", () => {
    expect(() =>
      check(DECLARED, { ...ON_GRID, distance: { ...ON_GRID.distance, fill: "none" } }),
    ).toThrow(/distance/);
    expect(() =>
      check(DECLARED, { ...ON_GRID, distance: { default: 1, min: 0, max: 2, step: 1, fill: "panel" } }),
    ).toThrow(/distance/);
  });

  it("refuses a range that does not walk exactly the grid's values", () => {
    expect(() =>
      check(DECLARED, { ...ON_GRID, horizontal_angle: { ...ON_GRID.horizontal_angle, max: 359, step: 1 } }),
    ).toThrow(/horizontal_angle.*0, 45, 90, 135, 180, 225, 270, 315/);
  });

  it("refuses a default off the grid", () => {
    expect(() =>
      check(DECLARED, { ...ON_GRID, vertical_angle: { ...ON_GRID.vertical_angle, default: 10 } }),
    ).toThrow(/vertical_angle.*default/);
  });

  it("refuses a declaration that is not three names", () => {
    expect(() => check({ azimuth: "horizontal_angle" })).toThrow(/camera_angle/);
  });
});

describe("what the wire carries", () => {
  beforeEach(useFullCatalog);
  afterAll(restoreProcessEnv);

  it("ships the declaration on the Qwen entry and on no other", () => {
    const image = getModelCatalog().image;
    expect(image.find((m) => m.name === QWEN)?.camera_angle).toEqual(DECLARED);
    expect(image.filter((m) => m.camera_angle !== undefined).map((m) => m.name)).toEqual([QWEN]);
  });

  it("keeps the grid the wire ships in step with the shared one", () => {
    const params = getModelCatalog().image.find((m) => m.name === QWEN)?.params ?? {};
    const walk = (spec: { min?: number; max?: number; step?: number } | undefined): number[] => {
      const out: number[] = [];
      for (let v = spec?.min ?? 0; v <= (spec?.max ?? -1); v += spec?.step ?? 1) out.push(v);
      return out;
    };
    expect(walk(params.horizontal_angle)).toEqual([...CAMERA_ANGLE_GRID.azimuth]);
    expect(walk(params.vertical_angle)).toEqual([...CAMERA_ANGLE_GRID.elevation]);
    expect(walk(params.distance)).toEqual([...CAMERA_ANGLE_GRID.distance]);
  });
});
