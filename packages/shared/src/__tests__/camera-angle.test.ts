// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import {
  CAMERA_ANGLE_GRID,
  DEFAULT_CAMERA_ANGLE,
  nearestCameraAngle,
  stepCameraAngle,
} from "../camera-angle.js";
import { modelCatalogSchema } from "../types/model-catalog.js";

describe("the camera-angle grid", () => {
  it("holds the 8 azimuths, 4 elevations and 3 distances the upstream rounds to", () => {
    expect(CAMERA_ANGLE_GRID.azimuth).toEqual([0, 45, 90, 135, 180, 225, 270, 315]);
    expect(CAMERA_ANGLE_GRID.elevation).toEqual([-30, 0, 30, 60]);
    expect(CAMERA_ANGLE_GRID.distance).toEqual([0, 1, 2]);
  });

  it("defaults to the front, at eye level, at the medium distance", () => {
    expect(DEFAULT_CAMERA_ANGLE).toEqual({ azimuth: 0, elevation: 0, distance: 1 });
  });
});

describe("nearestCameraAngle", () => {
  it("keeps a pose that is already on the grid", () => {
    expect(nearestCameraAngle({ azimuth: 135, elevation: 30, distance: 2 })).toEqual({
      azimuth: 135,
      elevation: 30,
      distance: 2,
    });
  });

  it("wraps the azimuth round 360, so just short of a full turn is the front", () => {
    expect(nearestCameraAngle({ azimuth: 350, elevation: 0, distance: 1 }).azimuth).toBe(0);
    expect(nearestCameraAngle({ azimuth: -20, elevation: 0, distance: 1 }).azimuth).toBe(0);
    expect(nearestCameraAngle({ azimuth: 650, elevation: 0, distance: 1 }).azimuth).toBe(270);
  });

  it("takes the nearest elevation and distance, clamped to the grid's ends", () => {
    expect(nearestCameraAngle({ azimuth: 0, elevation: 14, distance: 1 }).elevation).toBe(0);
    expect(nearestCameraAngle({ azimuth: 0, elevation: 16, distance: 1 }).elevation).toBe(30);
    expect(nearestCameraAngle({ azimuth: 0, elevation: 90, distance: 1 }).elevation).toBe(60);
    expect(nearestCameraAngle({ azimuth: 0, elevation: -80, distance: 1 }).elevation).toBe(-30);
    expect(nearestCameraAngle({ azimuth: 0, elevation: 0, distance: 1.6 }).distance).toBe(2);
    expect(nearestCameraAngle({ azimuth: 0, elevation: 0, distance: -1 }).distance).toBe(0);
  });

  it("breaks a tie toward the lower value, so the same input always lands on the same pose", () => {
    expect(nearestCameraAngle({ azimuth: 22.5, elevation: 15, distance: 0.5 })).toEqual({
      azimuth: 0,
      elevation: 0,
      distance: 0,
    });
  });
});

describe("stepCameraAngle", () => {
  it("cycles the azimuth round the circle in both directions", () => {
    expect(stepCameraAngle(DEFAULT_CAMERA_ANGLE, "azimuth", 1).azimuth).toBe(45);
    expect(stepCameraAngle(DEFAULT_CAMERA_ANGLE, "azimuth", -1).azimuth).toBe(315);
    expect(stepCameraAngle({ azimuth: 315, elevation: 0, distance: 1 }, "azimuth", 1).azimuth).toBe(0);
  });

  it("stops the elevation and the distance at the ends of the grid", () => {
    expect(stepCameraAngle({ azimuth: 0, elevation: 60, distance: 1 }, "elevation", 1).elevation).toBe(60);
    expect(stepCameraAngle({ azimuth: 0, elevation: -30, distance: 1 }, "elevation", -1).elevation).toBe(-30);
    expect(stepCameraAngle({ azimuth: 0, elevation: 0, distance: 2 }, "distance", 1).distance).toBe(2);
    expect(stepCameraAngle({ azimuth: 0, elevation: 0, distance: 0 }, "distance", -1).distance).toBe(0);
  });

  it("changes only the axis it is asked to", () => {
    expect(stepCameraAngle({ azimuth: 90, elevation: 30, distance: 0 }, "elevation", -1)).toEqual({
      azimuth: 90,
      elevation: 0,
      distance: 0,
    });
  });
});

describe("the catalog schema's camera_angle", () => {
  /**
   * Parses a catalog holding one image model, so only camera_angle varies.
   * @param cameraAngle - What the entry carries.
   * @returns The parsed entry.
   */
  const parse = (cameraAngle: unknown): Record<string, unknown> => {
    const catalog = modelCatalogSchema.parse({
      image: [
        {
          name: "m",
          display_name: "M",
          modality: "image",
          mode: "i2i",
          description: "",
          guide: "",
          tier: "optional",
          generation_time: 60,
          params: {},
          providers: [],
          takes_prompt: true,
          camera_angle: cameraAngle,
        },
      ],
    });
    return catalog.image[0] as unknown as Record<string, unknown>;
  };

  it("carries the three param names through", () => {
    const declared = { azimuth: "horizontal_angle", elevation: "vertical_angle", distance: "distance" };
    expect(parse(declared).camera_angle).toEqual(declared);
  });

  it("drops a malformed declaration rather than the model", () => {
    expect(parse({ azimuth: "horizontal_angle" }).camera_angle).toBeUndefined();
    expect(parse(undefined).camera_angle).toBeUndefined();
  });
});
