// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { Quaternion } from 'three';
import { SCENE_POSE_HIPS_KEY, type ScenePose } from '@breatic/shared';

/**
 * The preset poses a humanoid character can take (inner#1692). Each is written
 * in VRM 1.0 normalized rotations: relative to the parent bone, axes aligned
 * with a T-posed figure facing +Z with its left hand on +X, so one table poses
 * every humanoid rig. Only required bones are written, every limb segment of
 * both sides included, and `t:hips` moves the hips in hip heights. A forearm
 * bends forward by turning about -Y on the left and +Y on the right. The hips
 * heights put the built-in figure's lowest point on the ground; a fixed ratio
 * cannot fit every body's thickness.
 */

const IDENTITY = [0, 0, 0, 1] as const;

/**
 * A rotation about one axis, as a stored quaternion.
 * @param axis - The axis.
 * @param degrees - The angle, counter-clockwise looking down the axis.
 * @returns The `[x, y, z, w]` tuple.
 */
function turn(axis: 'x' | 'y' | 'z', degrees: number): readonly number[] {
  const half = (degrees * Math.PI) / 360;
  const s = Math.sin(half);
  return [axis === 'x' ? s : 0, axis === 'y' ? s : 0, axis === 'z' ? s : 0, Math.cos(half)];
}

/**
 * One rotation after another, as a stored quaternion.
 * @param after - The rotation applied second, in the parent's frame.
 * @param first - The rotation applied first.
 * @returns The `[x, y, z, w]` product `after * first`.
 */
function then(after: readonly number[], first: readonly number[]): readonly number[] {
  return new Quaternion().fromArray(after).multiply(new Quaternion().fromArray(first)).toArray();
}

/** Both arms hanging at the sides, the elbows slightly bent. */
const ARMS_DOWN: ScenePose = {
  'h:leftUpperArm': turn('z', -75), 'h:leftLowerArm': turn('y', -10), 'h:leftHand': IDENTITY,
  'h:rightUpperArm': turn('z', 75), 'h:rightLowerArm': turn('y', 10), 'h:rightHand': IDENTITY,
};

/** Both legs straight under the hips. */
const LEGS_STRAIGHT: ScenePose = {
  'h:leftUpperLeg': IDENTITY, 'h:leftLowerLeg': IDENTITY, 'h:leftFoot': IDENTITY,
  'h:rightUpperLeg': IDENTITY, 'h:rightLowerLeg': IDENTITY, 'h:rightFoot': IDENTITY,
};

/** Hips, spine and head upright. */
const UPRIGHT: ScenePose = { 'h:hips': IDENTITY, 'h:spine': IDENTITY, 'h:head': IDENTITY };

/** The presets in the order the inspector shows them. */
export const POSE_PRESET_NAMES = ['stand', 'sit', 'lie', 'walk', 'wave'] as const;

export const POSE_PRESETS: Readonly<Record<(typeof POSE_PRESET_NAMES)[number], ScenePose>> = {
  stand: { ...UPRIGHT, ...ARMS_DOWN, ...LEGS_STRAIGHT },
  // Sitting on the ground, knees raised and feet flat in front, hands resting out to the sides.
  sit: {
    ...UPRIGHT,
    'h:leftUpperArm': turn('z', -45), 'h:leftLowerArm': IDENTITY, 'h:leftHand': IDENTITY,
    'h:rightUpperArm': turn('z', 45), 'h:rightLowerArm': IDENTITY, 'h:rightHand': IDENTITY,
    // Thighs 30 degrees above level: steeper sends them into the belly of a heavier body.
    'h:leftUpperLeg': turn('x', -120), 'h:leftLowerLeg': turn('x', 50), 'h:leftFoot': turn('x', 70),
    'h:rightUpperLeg': turn('x', -120), 'h:rightLowerLeg': turn('x', 50), 'h:rightFoot': turn('x', 70),
    [SCENE_POSE_HIPS_KEY]: [0, -0.904, 0],
  },
  // Lying on the back, arms along the body.
  lie: {
    'h:hips': turn('x', -90), 'h:spine': IDENTITY, 'h:head': IDENTITY,
    ...ARMS_DOWN, ...LEGS_STRAIGHT,
    // The thighs stretch back 5 degrees: at the standing hip angle the seat lifts the heels off the ground.
    'h:leftUpperLeg': turn('x', 5), 'h:rightUpperLeg': turn('x', 5),
    // The arms swing back 12 degrees: hanging at the sides they start above the back, lifting the hands.
    'h:leftUpperArm': then(turn('x', 12), ARMS_DOWN['h:leftUpperArm'] ?? IDENTITY),
    'h:rightUpperArm': then(turn('x', 12), ARMS_DOWN['h:rightUpperArm'] ?? IDENTITY),
    [SCENE_POSE_HIPS_KEY]: [0, -0.863, 0],
  },
  walk: {
    ...UPRIGHT,
    'h:leftUpperArm': turn('z', -75), 'h:leftLowerArm': turn('y', -15), 'h:leftHand': IDENTITY,
    'h:rightUpperArm': turn('z', 75), 'h:rightLowerArm': turn('y', 15), 'h:rightHand': IDENTITY,
    'h:leftUpperLeg': turn('x', -25), 'h:leftLowerLeg': turn('x', 10), 'h:leftFoot': IDENTITY,
    'h:rightUpperLeg': turn('x', 20), 'h:rightLowerLeg': turn('x', 25), 'h:rightFoot': IDENTITY,
    // The bent knees shorten the legs; the hips come down so the feet keep the ground.
    [SCENE_POSE_HIPS_KEY]: [0, -0.032, 0],
  },
  // The right hand raised above the head with the elbow out to the side, so the forearm
  // stays clear of a wide head as well as a narrow one.
  wave: {
    ...UPRIGHT, ...LEGS_STRAIGHT,
    'h:leftUpperArm': turn('z', -75), 'h:leftLowerArm': turn('y', -10), 'h:leftHand': IDENTITY,
    'h:rightUpperArm': turn('z', -45), 'h:rightLowerArm': turn('z', -45), 'h:rightHand': IDENTITY,
  },
};
