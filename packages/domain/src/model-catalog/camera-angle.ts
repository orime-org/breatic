// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The three params a model declares as one camera pose (inner#830), checked
 * against the grid the upstream rounds every angle to.
 */

import { CAMERA_ANGLE_GRID, type CameraAngleAxis, type CameraAngleParams } from "@breatic/shared";

/** The part of a catalog entry this check reads. */
interface CameraAngleCandidate {
  /** Model name as authored in yaml, named in the error. */
  name: string;
  /** What the model declares, unchecked. */
  camera_angle?: unknown;
  /** The model's params, unchecked. */
  params?: Record<string, unknown>;
}

const AXES: readonly CameraAngleAxis[] = ["azimuth", "elevation", "distance"];

/**
 * The values a declared range walks, or null when it is not a stepped range.
 * @param spec - One param's declaration, read for its min, max and step.
 * @returns min, min + step, … up to max.
 */
function walk(spec: Readonly<Record<string, unknown>>): number[] | null {
  const { min, max, step } = spec;
  if (typeof min !== "number" || typeof max !== "number" || typeof step !== "number" || step <= 0) return null;
  const out: number[] = [];
  for (let v = min; v <= max; v += step) out.push(v);
  return out;
}

/**
 * Why one axis's param is wrong for the grid, or null when it is right.
 * @param axis - The axis the param stands for.
 * @param paramName - The param the model names for it.
 * @param spec - That param's declaration, or undefined when the model has none.
 * @returns The reason.
 */
function wrongAxis(axis: CameraAngleAxis, paramName: string, spec: unknown): string | null {
  if (spec === undefined || spec === null || typeof spec !== "object") {
    return `declares camera_angle ${axis} '${paramName}', which is not one of its params`;
  }
  const declared = spec as Record<string, unknown>;
  if (declared.fill !== "panel" || typeof declared.label !== "string") {
    return `declares camera_angle ${axis} '${paramName}', which is not a labelled panel param`;
  }
  const grid: readonly number[] = CAMERA_ANGLE_GRID[axis];
  const walked = walk(declared);
  if (walked === null || walked.join() !== grid.join()) {
    return `declares camera_angle ${axis} '${paramName}' whose range does not walk exactly ${grid.join(", ")}`;
  }
  if (typeof declared.default !== "number" || !grid.includes(declared.default)) {
    return `declares camera_angle ${axis} '${paramName}' with a default off the grid`;
  }
  return null;
}

/**
 * Assert that every model in one modality that declares a camera pose names
 * three of its own labelled panel ranges, each walking exactly its axis's
 * grid and defaulting onto it.
 * @param modality - The modality being loaded, named in the error.
 * @param models - The models parsed out of that modality's yaml files.
 * @throws {Error} when a model declares a pose the panel could not draw on the grid.
 */
export function assertCameraAngle(modality: string, models: readonly CameraAngleCandidate[]): void {
  for (const model of models) {
    if (model.camera_angle === undefined) continue;
    const declared: unknown = model.camera_angle;
    for (const axis of AXES) {
      const paramName = declared !== null && typeof declared === "object" ? (declared as Record<string, unknown>)[axis] : undefined;
      if (typeof paramName !== "string") {
        throw new Error(
          `config/models/${modality}: ${model.name} declares camera_angle without a param name for each of ${AXES.join(", ")}`,
        );
      }
      const reason = wrongAxis(axis, paramName, model.params?.[paramName]);
      if (reason !== null) throw new Error(`config/models/${modality}: ${model.name} ${reason}`);
    }
  }
}

/**
 * The declaration as the wire ships it.
 * @param declared - What the model declares; checked by {@link assertCameraAngle}.
 * @returns The three param names, or undefined when the model declares none.
 */
export function shipCameraAngle(declared: CameraAngleParams | undefined): CameraAngleParams | undefined {
  return declared === undefined
    ? undefined
    : { azimuth: declared.azimuth, elevation: declared.elevation, distance: declared.distance };
}
