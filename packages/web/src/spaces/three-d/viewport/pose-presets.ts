// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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

export const POSE_PRESETS: Readonly<Record<'stand' | 'sit' | 'lie' | 'walk' | 'wave', ScenePose>> = {
  stand: { ...UPRIGHT, ...ARMS_DOWN, ...LEGS_STRAIGHT },
  // Sitting on the ground: thighs forward, hands resting out to the sides.
  sit: {
    ...UPRIGHT,
    'h:leftUpperArm': turn('z', -45), 'h:leftLowerArm': IDENTITY, 'h:leftHand': IDENTITY,
    'h:rightUpperArm': turn('z', 45), 'h:rightLowerArm': IDENTITY, 'h:rightHand': IDENTITY,
    'h:leftUpperLeg': turn('x', -90), 'h:leftLowerLeg': IDENTITY, 'h:leftFoot': IDENTITY,
    'h:rightUpperLeg': turn('x', -90), 'h:rightLowerLeg': IDENTITY, 'h:rightFoot': IDENTITY,
    [SCENE_POSE_HIPS_KEY]: [0, -0.885, 0],
  },
  // Lying on the back, arms along the body.
  lie: {
    'h:hips': turn('x', -90), 'h:spine': IDENTITY, 'h:head': IDENTITY,
    ...ARMS_DOWN, ...LEGS_STRAIGHT,
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
  // The right hand raised above the head.
  wave: {
    ...UPRIGHT, ...LEGS_STRAIGHT,
    'h:leftUpperArm': turn('z', -75), 'h:leftLowerArm': turn('y', -10), 'h:leftHand': IDENTITY,
    'h:rightUpperArm': turn('z', -100), 'h:rightLowerArm': turn('z', -20), 'h:rightHand': IDENTITY,
  },
};
