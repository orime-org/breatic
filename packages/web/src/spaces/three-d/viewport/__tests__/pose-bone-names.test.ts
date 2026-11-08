// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from 'vitest';
import { humanoidBoneOf, type VrmHumanBoneName } from '@web/spaces/three-d/viewport/pose-bone-names';

type Case = readonly [string, VrmHumanBoneName];

/** Every VRM 1.0 humanoid name maps to itself; several end in a letter that is also a side token. */
const VRM_NAMES: readonly VrmHumanBoneName[] = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'jaw', 'leftEye', 'rightEye',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
  'leftThumbMetacarpal', 'leftThumbProximal', 'leftThumbDistal',
  'leftIndexProximal', 'leftIndexIntermediate', 'leftIndexDistal',
  'leftMiddleProximal', 'leftLittleDistal', 'rightLittleDistal', 'rightIndexDistal',
];

/** Mixamo names after GLTFLoader removed the `:` of `mixamorig:`; table per three-vrm `mixamoVRMRigMap`. */
const MIXAMO: readonly Case[] = [
  ['mixamorigHips', 'hips'], ['mixamorigSpine', 'spine'], ['mixamorigSpine1', 'chest'], ['mixamorigSpine2', 'upperChest'],
  ['mixamorigNeck', 'neck'], ['mixamorigHead', 'head'],
  ['mixamorigLeftShoulder', 'leftShoulder'], ['mixamorigLeftArm', 'leftUpperArm'], ['mixamorigLeftForeArm', 'leftLowerArm'], ['mixamorigLeftHand', 'leftHand'],
  ['mixamorigRightShoulder', 'rightShoulder'], ['mixamorigRightArm', 'rightUpperArm'], ['mixamorigRightForeArm', 'rightLowerArm'], ['mixamorigRightHand', 'rightHand'],
  ['mixamorigLeftUpLeg', 'leftUpperLeg'], ['mixamorigLeftLeg', 'leftLowerLeg'], ['mixamorigLeftFoot', 'leftFoot'], ['mixamorigLeftToeBase', 'leftToes'],
  ['mixamorigRightUpLeg', 'rightUpperLeg'], ['mixamorigRightLeg', 'rightLowerLeg'], ['mixamorigRightFoot', 'rightFoot'], ['mixamorigRightToeBase', 'rightToes'],
  ['mixamorigLeftHandThumb1', 'leftThumbMetacarpal'], ['mixamorigLeftHandIndex1', 'leftIndexProximal'], ['mixamorigRightHandMiddle1', 'rightMiddleProximal'],
  // Numbered prefixes (several characters in one file) and an underscore separator.
  ['mixamorig1LeftArm', 'leftUpperArm'], ['mixamorig12RightForeArm', 'rightLowerArm'], ['mixamorig_LeftUpLeg', 'leftUpperLeg'],
  // Mixamo names exported without the prefix.
  ['LeftArm', 'leftUpperArm'], ['Hips', 'hips'],
];

/** Unreal mannequin (UE4 skeleton). */
const UNREAL: readonly Case[] = [
  ['pelvis', 'hips'], ['spine_01', 'spine'], ['spine_02', 'chest'], ['spine_03', 'upperChest'], ['neck_01', 'neck'], ['head', 'head'],
  ['clavicle_l', 'leftShoulder'], ['upperarm_l', 'leftUpperArm'], ['lowerarm_l', 'leftLowerArm'], ['hand_l', 'leftHand'],
  ['clavicle_r', 'rightShoulder'], ['upperarm_r', 'rightUpperArm'], ['lowerarm_r', 'rightLowerArm'], ['hand_r', 'rightHand'],
  ['thigh_l', 'leftUpperLeg'], ['calf_l', 'leftLowerLeg'], ['foot_l', 'leftFoot'], ['ball_l', 'leftToes'],
  ['thigh_r', 'rightUpperLeg'], ['calf_r', 'rightLowerLeg'], ['foot_r', 'rightFoot'], ['ball_r', 'rightToes'],
];

/** Rigify deform bones; GLTFLoader turns `DEF-upper_arm.L` into `DEF-upper_armL`. */
const RIGIFY: readonly Case[] = [
  ['DEF-upper_armL', 'leftUpperArm'], ['DEF-forearmL', 'leftLowerArm'], ['DEF-handL', 'leftHand'],
  ['DEF-upper_armR', 'rightUpperArm'], ['DEF-forearmR', 'rightLowerArm'], ['DEF-handR', 'rightHand'],
  ['DEF-thighL', 'leftUpperLeg'], ['DEF-shinL', 'leftLowerLeg'], ['DEF-footL', 'leftFoot'],
  ['DEF-thighR', 'rightUpperLeg'], ['DEF-shinR', 'rightLowerLeg'], ['DEF-footR', 'rightFoot'],
];

/** Character Creator / ActorCore. */
const CHARACTER_CREATOR: readonly Case[] = [
  ['CC_Base_L_Upperarm', 'leftUpperArm'], ['CC_Base_L_Forearm', 'leftLowerArm'], ['CC_Base_L_Hand', 'leftHand'],
  ['CC_Base_R_Upperarm', 'rightUpperArm'], ['CC_Base_R_Forearm', 'rightLowerArm'], ['CC_Base_R_Hand', 'rightHand'],
  ['CC_Base_L_Thigh', 'leftUpperLeg'], ['CC_Base_L_Calf', 'leftLowerLeg'], ['CC_Base_L_Foot', 'leftFoot'],
  ['CC_Base_R_Thigh', 'rightUpperLeg'], ['CC_Base_R_Calf', 'rightLowerLeg'], ['CC_Base_R_Foot', 'rightFoot'],
  ['CC_Base_Head', 'head'],
];

/** 3ds Max Biped; GLTFLoader turns spaces into `_`, and the raw spaced form must match too. */
const BIPED: readonly Case[] = [
  ['Bip001_Pelvis', 'hips'], ['Bip001_Spine', 'spine'], ['Bip001_Head', 'head'],
  ['Bip001_L_UpperArm', 'leftUpperArm'], ['Bip001_L_Forearm', 'leftLowerArm'], ['Bip001_L_Hand', 'leftHand'],
  ['Bip001_R_UpperArm', 'rightUpperArm'], ['Bip001_R_Forearm', 'rightLowerArm'], ['Bip001_R_Hand', 'rightHand'],
  ['Bip001_L_Thigh', 'leftUpperLeg'], ['Bip001_L_Calf', 'leftLowerLeg'], ['Bip001_L_Foot', 'leftFoot'],
  ['Bip001_R_Thigh', 'rightUpperLeg'], ['Bip001_R_Calf', 'rightLowerLeg'], ['Bip001_R_Foot', 'rightFoot'],
  ['Bip001 L UpperArm', 'leftUpperArm'],
];

/** GDQuest Mannequiny; GLTFLoader turns `upperarm.l` into `upperarml`. */
const MANNEQUINY: readonly Case[] = [
  ['pelvis', 'hips'], ['spine_01', 'spine'], ['spine_02', 'chest'], ['neck_01', 'neck'], ['head', 'head'],
  ['claviclel', 'leftShoulder'], ['upperarml', 'leftUpperArm'], ['lowerarml', 'leftLowerArm'], ['handl', 'leftHand'],
  ['clavicler', 'rightShoulder'], ['upperarmr', 'rightUpperArm'], ['lowerarmr', 'rightLowerArm'], ['handr', 'rightHand'],
  ['thighl', 'leftUpperLeg'], ['calfl', 'leftLowerLeg'], ['footl', 'leftFoot'], ['balll', 'leftToes'],
  ['thighr', 'rightUpperLeg'], ['calfr', 'rightLowerLeg'], ['footr', 'rightFoot'], ['ballr', 'rightToes'],
];

/**
 * Names that are not a main humanoid bone. Twist and split-segment helpers map to null, so they can
 * never take the place of the upper arm, forearm or thigh they sit under.
 */
const NOT_HUMANOID: readonly string[] = [
  '', 'Tail_1', 'hair_01', 'Armature', 'Root', 'root', 'Body', 'Leg_FL', 'Left', 'l', 'mixamorig', 'Bip001',
  'mixamorigHeadTop_End', 'upperarm_twist_01_l', 'lowerarm_twist_01_r', 'thigh_twist_01_l',
  'CC_Base_L_UpperarmTwist01', 'DEF-upper_armL001',
];

describe('humanoidBoneOf (inner#1692)', () => {
  it.each(VRM_NAMES)('maps the VRM 1.0 name %s to itself', (name) => {
    expect(humanoidBoneOf(name)).toBe(name);
  });

  it.each(MIXAMO)('maps Mixamo %s to %s', (name, bone) => {
    expect(humanoidBoneOf(name)).toBe(bone);
  });

  it.each(UNREAL)('maps Unreal mannequin %s to %s', (name, bone) => {
    expect(humanoidBoneOf(name)).toBe(bone);
  });

  it.each(RIGIFY)('maps Rigify %s to %s', (name, bone) => {
    expect(humanoidBoneOf(name)).toBe(bone);
  });

  it.each(CHARACTER_CREATOR)('maps Character Creator %s to %s', (name, bone) => {
    expect(humanoidBoneOf(name)).toBe(bone);
  });

  it('maps a Character Creator hip bone to hips', () => {
    expect([humanoidBoneOf('CC_Base_Hip'), humanoidBoneOf('CC_Base_Pelvis')]).toContain('hips');
  });

  it.each(BIPED)('maps 3ds Max Biped %s to %s', (name, bone) => {
    expect(humanoidBoneOf(name)).toBe(bone);
  });

  it.each(MANNEQUINY)('maps Mannequiny %s to %s', (name, bone) => {
    expect(humanoidBoneOf(name)).toBe(bone);
  });

  it('ignores letter case', () => {
    expect(humanoidBoneOf('MIXAMORIGLEFTFOREARM')).toBe('leftLowerArm');
    expect(humanoidBoneOf('LeftUpperArm')).toBe('leftUpperArm');
  });

  it.each(NOT_HUMANOID)('does not map %j', (name) => {
    expect(humanoidBoneOf(name)).toBeNull();
  });
});
