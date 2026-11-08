// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which VRM 1.0 humanoid bone a rig's node stands for (inner#1692). Rigs name
 * their bones by their own convention (Mixamo, Unreal, Rigify, Character
 * Creator, 3ds Max Biped, VRM itself), and GLTFLoader cleans the names; the
 * name is lowered, stripped of separators and known prefixes, its side read
 * from a left or right token at either end, and the rest looked up. UniVRM's
 * bone guesser and Unity's Avatar auto-mapping match names the same way.
 * The Mixamo names follow three-vrm's `mixamoVRMRigMap.js` (MIT, pixiv Inc.).
 */

const SIDED = [
  'Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot', 'Toes', 'Eye',
  'ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal',
  'IndexProximal', 'IndexIntermediate', 'IndexDistal',
  'MiddleProximal', 'MiddleIntermediate', 'MiddleDistal',
  'RingProximal', 'RingIntermediate', 'RingDistal',
  'LittleProximal', 'LittleIntermediate', 'LittleDistal',
] as const;
type Unsided = 'hips' | 'spine' | 'chest' | 'upperChest' | 'neck' | 'head' | 'jaw';
type Sided = (typeof SIDED)[number];
export type VrmHumanBoneName = Unsided | `left${Sided}` | `right${Sided}`;

/** The bones every humanoid rig has; without them a rig is posed by node name. */
export const REQUIRED_HUMAN_BONES: readonly VrmHumanBoneName[] = [
  'hips', 'spine', 'head',
  'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
];

/** Prefixes a convention puts before every bone name, after cleaning. */
const PREFIX = /^(?:mixamorig\d*|def|ccbase|bip\d+|armature)/u;

/** A cleaned name without its side, to its VRM name or sided suffix. */
const UNSIDED_NAMES: Readonly<Record<string, Unsided>> = {
  hips: 'hips', hip: 'hips', pelvis: 'hips',
  spine: 'spine', spine01: 'spine',
  chest: 'chest', spine1: 'chest', spine02: 'chest',
  upperchest: 'upperChest', spine2: 'upperChest', spine03: 'upperChest',
  neck: 'neck', neck01: 'neck',
  head: 'head',
  jaw: 'jaw',
};

const SIDED_NAMES: Readonly<Record<string, Sided>> = {
  shoulder: 'Shoulder', clavicle: 'Shoulder',
  upperarm: 'UpperArm', arm: 'UpperArm',
  lowerarm: 'LowerArm', forearm: 'LowerArm',
  hand: 'Hand',
  upperleg: 'UpperLeg', upleg: 'UpperLeg', thigh: 'UpperLeg',
  lowerleg: 'LowerLeg', leg: 'LowerLeg', calf: 'LowerLeg', shin: 'LowerLeg',
  foot: 'Foot',
  toes: 'Toes', toebase: 'Toes', toe: 'Toes', ball: 'Toes',
  eye: 'Eye',
  ...Object.fromEntries(SIDED.map((suffix) => [suffix.toLowerCase(), suffix])),
  ...fingerNames(),
};

/**
 * Mixamo's numbered finger names (`HandThumb1`) under their VRM names.
 * @returns Cleaned names to sided suffixes.
 */
function fingerNames(): Record<string, Sided> {
  const fingers = { thumb: 'Thumb', index: 'Index', middle: 'Middle', ring: 'Ring', pinky: 'Little' } as const;
  const names: Record<string, Sided> = {};
  for (const [mixamo, vrm] of Object.entries(fingers)) {
    const joints = vrm === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
    joints.forEach((joint, index) => { names[`hand${mixamo}${index + 1}`] = `${vrm}${joint}` as Sided; });
  }
  return names;
}

/**
 * The side a cleaned name carries and the name without it.
 * @param name - Lower-case letters and digits only.
 * @returns The side and the rest, or null when no side token is found.
 */
function splitSide(name: string): { side: 'left' | 'right'; rest: string } | null {
  for (const side of ['left', 'right'] as const) {
    if (name.startsWith(side)) return { side, rest: name.slice(side.length) };
    if (name.endsWith(side)) return { side, rest: name.slice(0, -side.length) };
  }
  // One-letter tokens: the end first, so `lowerarml` keeps its own leading `l`.
  if (name.endsWith('l')) return { side: 'left', rest: name.slice(0, -1) };
  if (name.endsWith('r')) return { side: 'right', rest: name.slice(0, -1) };
  if (name.startsWith('l')) return { side: 'left', rest: name.slice(1) };
  if (name.startsWith('r')) return { side: 'right', rest: name.slice(1) };
  return null;
}

/**
 * The VRM 1.0 humanoid bone a node name stands for.
 * @param name - The node name, as GLTFLoader cleaned it or as written.
 * @returns The humanoid bone, or null for a bone that is not one (a twist bone, a tail, a helper).
 */
export function humanoidBoneOf(name: string): VrmHumanBoneName | null {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]/gu, '').replace(PREFIX, '');
  if (cleaned === '') return null;
  const unsided = UNSIDED_NAMES[cleaned];
  if (unsided !== undefined) return unsided;
  const split = splitSide(cleaned);
  if (split === null) return null;
  const suffix = SIDED_NAMES[split.rest];
  return suffix === undefined ? null : `${split.side}${suffix}`;
}
