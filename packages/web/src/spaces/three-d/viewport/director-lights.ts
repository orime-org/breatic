// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { Vector3, type Box3, type Camera } from 'three';
import { compareDirectorRecords } from '@breatic/shared';

/** Why a light row carries a note (inner#1694 design 6.4). */
export type LightNote = 'overLimit' | 'shadowBudget';

/** What one light does in the render. */
export interface LightPlan {
  enabled: boolean;
  castsShadow: boolean;
  note: LightNote | null;
}

/** Which lights shine and cast, and whether the default key light is on. */
export interface LightsPlan {
  defaultKey: boolean;
  lights: Readonly<Record<string, LightPlan>>;
}

/**
 * Decide which lights shine and which cast shadows: the first `maxLights` by number then id shine, and the
 * first of those whose shadow is on cast, up to the shadow slots.
 * @param input - The valid light records.
 * @param limits - The limits.
 * @param limits.maxLights - Most lights that shine.
 * @param limits.shadowSlots - Most lights that cast.
 * @returns The plan.
 */
export function planLights(input: readonly { id: string; number: number; castShadow: boolean }[],
  limits: { maxLights: number; shadowSlots: number }): LightsPlan {
  const lights: Record<string, LightPlan> = {};
  let casting = 0;
  [...input].sort(compareDirectorRecords).forEach((light, index) => {
    const enabled = index < limits.maxLights;
    const castsShadow = enabled && light.castShadow && casting < limits.shadowSlots;
    if (castsShadow) casting += 1;
    lights[light.id] = { enabled, castsShadow,
      note: !enabled ? 'overLimit' : light.castShadow && !castsShadow ? 'shadowBudget' : null };
  });
  return { defaultKey: input.length === 0, lights };
}

/**
 * How many lights can cast: the texture units left after the most sampler-hungry mesh program, less one spare.
 * @param maxTextures - The renderer's texture units.
 * @param programSamplers - The sampler uniform names of each compiled program, one entry per unit.
 * @returns The shadow slots; zero before any program is compiled.
 */
export function shadowSlots(maxTextures: number, programSamplers: readonly (readonly string[])[]): number {
  if (programSamplers.length === 0) return 0;
  const used = Math.max(...programSamplers.map((names) => names.filter((name) => !name.endsWith('ShadowMap')).length));
  return Math.max(0, maxTextures - used - 1);
}

/** WebGL sampler uniform types (three r173 `WebGLUniforms.js` `getSingularSetter`). */
const SAMPLER_TYPES = new Set([0x8b5e, 0x8d66, 0x8dca, 0x8dd2, 0x8b62, 0x8b5f, 0x8dcb, 0x8dd3, 0x8b60, 0x8dcc, 0x8dd4, 0x8dc5,
  0x8dc1, 0x8dcf, 0x8dd7, 0x8dc4]);

/** A uniform as three's `WebGLUniforms` holds it: a single or array uniform, or a struct with its own sequence. */
interface ProgramUniform { id: string | number; type?: number; size?: number; seq?: readonly ProgramUniform[] }

/**
 * Read the sampler uniforms of compiled programs, one name per texture unit.
 * @param programs - `renderer.info.programs`.
 * @returns Each program's sampler names.
 */
export function programSamplers(programs: readonly { getUniforms: () => object }[]): string[][] {
  /**
   * Collect samplers from a uniform sequence.
   * @param seq - The sequence.
   * @param into - Where names go.
   * @returns The same list.
   */
  const collect = (seq: readonly ProgramUniform[], into: string[]): string[] => {
    for (const uniform of seq) {
      if (uniform.seq) collect(uniform.seq, into);
      else if (uniform.type !== undefined && SAMPLER_TYPES.has(uniform.type)) {
        for (let unit = 0; unit < (uniform.size ?? 1); unit += 1) into.push(String(uniform.id));
      }
    }
    return into;
  };
  // three's typings leave out the uniform sequence that `WebGLUniforms` builds (r173 `WebGLUniforms.js`).
  return programs.map((program) => collect((program.getUniforms() as { seq?: readonly ProgramUniform[] }).seq ?? [], []));
}

/** A shadow camera's frustum in its own space. */
export interface ShadowRange { left: number; right: number; top: number; bottom: number; near: number; far: number }

/** A light pointing less than this far down casts no ground shadow worth following. */
const GROUND_DIRECTION_Y = -0.05;

/**
 * The eight corners of a box.
 * @param box - A non-empty box.
 * @returns Its corners.
 */
function corners(box: Box3): Vector3[] {
  return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
}

/**
 * The directional shadow camera's range in its own space (design 3.6): the casters' box, plus where each corner's
 * shadow lands on the ground along the light, at most `reach` box diagonals away; near may be negative.
 * @param camera - The shadow camera, already placed at the light and aimed at its target.
 * @param direction - The light's unit direction.
 * @param box - The casters' bounding box; not empty.
 * @param reach - The farthest ground shadow, in box diagonals.
 * @returns The range.
 */
export function directionalShadowRange(camera: Camera, direction: Vector3, box: Box3, reach: number): ShadowRange {
  const limit = reach * box.max.distanceTo(box.min);
  const points = corners(box);
  if (direction.y < GROUND_DIRECTION_Y) {
    for (const corner of corners(box)) {
      if (corner.y >= 0) points.push(corner.clone().addScaledVector(direction, Math.min(-corner.y / direction.y, limit)));
    }
  }
  const local = points.map((point) => point.applyMatrix4(camera.matrixWorldInverse));
  const xs = local.map((point) => point.x);
  const ys = local.map((point) => point.y);
  const depths = local.map((point) => -point.z);
  return { left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys), near: Math.min(...depths), far: Math.max(...depths) };
}

/**
 * The far plane of a spot or point light's shadow (design 3.6): the farthest of the casters' corners and of where
 * each corner below the light throws its shadow on the ground, at most `reach` box diagonals beyond it.
 * @param lightPosition - The light's world position.
 * @param box - The casters' bounding box; not empty.
 * @param reach - The farthest ground shadow, in box diagonals.
 * @returns The far distance.
 */
export function localShadowFar(lightPosition: Vector3, box: Box3, reach: number): number {
  const limit = reach * box.max.distanceTo(box.min);
  let far = 0;
  for (const corner of corners(box)) {
    far = Math.max(far, lightPosition.distanceTo(corner));
    if (corner.y >= lightPosition.y) continue;
    const ray = corner.clone().sub(lightPosition).normalize();
    const ground = corner.clone().addScaledVector(ray, Math.min(Math.max(-corner.y / ray.y, 0), limit));
    far = Math.max(far, lightPosition.distanceTo(ground));
  }
  return far;
}
