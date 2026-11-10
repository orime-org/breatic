// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which VRM 1.0 humanoid bone a rig's node stands for (inner#1692). Rigs name
 * their bones by their own convention (Mixamo, Unreal, Rigify, Character
 * Creator, 3ds Max Biped, VRoid, VRM itself), and GLTFLoader cleans the names; the
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

/** Rigify's deform prefix: its torso is one numbered chain, read by {@link RIGIFY_TORSO}. */
const RIGIFY = /^def/u;

/** Rigify's torso, `DEF-spine` (the pelvis) to `DEF-spine.006` (the head); `.005` is the upper neck. */
const RIGIFY_TORSO: Readonly<Record<string, Unsided>> = {
  spine: 'hips', spine001: 'spine', spine002: 'chest', spine003: 'upperChest', spine004: 'neck', spine006: 'head',
};

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
 * Numbered finger names under their VRM names, the first thumb joint being VRM 1.0's metacarpal:
 * Mixamo's `HandThumb1`, VRoid's `Thumb1`, Character Creator's `Mid1` and `Pinky1`, Unreal's and
 * Mannequiny's `thumb_01`, and 3ds Max Biped's `Finger0`, `Finger01`, `Finger02` from thumb to little finger.
 * @returns Cleaned names to sided suffixes.
 */
function fingerNames(): Record<string, Sided> {
  const fingers = [['thumb', ['thumb'], 'Thumb'], ['index', ['index'], 'Index'], ['middle', ['middle', 'mid'], 'Middle'],
    ['ring', ['ring'], 'Ring'], ['pinky', ['little', 'pinky'], 'Little']] as const;
  const names: Record<string, Sided> = {};
  fingers.forEach(([word, numbered, vrm], finger) => {
    const joints = vrm === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
    joints.forEach((joint, index) => {
      const bone = `${vrm}${joint}` as Sided;
      names[`hand${word}${index + 1}`] = bone;
      for (const alias of numbered) names[`${alias}${index + 1}`] = bone;
      names[`${word}0${index + 1}`] = bone;
      names[`finger${finger}${index === 0 ? '' : index}`] = bone;
    });
  });
  return names;
}

/** VRoid's names, which `tripo3d/rig` writes for a VRM rig: `J_Bip_C_Hips`, `J_Bip_L_UpperArm`. */
const VROID = /^jbip([clr])(.+)$/u;

/**
 * Every way a cleaned name can split into a side token and the rest, most likely first.
 * @param name - Lower-case letters and digits only.
 * @returns The candidate splits; a name ending in `l` or `r` (`lshoulder`) also offers its leading letter.
 */
function sideSplits(name: string): { side: 'left' | 'right'; rest: string }[] {
  const splits: { side: 'left' | 'right'; rest: string }[] = [];
  for (const side of ['left', 'right'] as const) {
    if (name.startsWith(side)) splits.push({ side, rest: name.slice(side.length) });
    if (name.endsWith(side)) splits.push({ side, rest: name.slice(0, -side.length) });
  }
  // One-letter tokens: the end first, so `lowerarml` keeps its own leading `l`.
  for (const [letter, side] of [['l', 'left'], ['r', 'right']] as const) if (name.endsWith(letter)) splits.push({ side, rest: name.slice(0, -1) });
  for (const [letter, side] of [['l', 'left'], ['r', 'right']] as const) if (name.startsWith(letter)) splits.push({ side, rest: name.slice(1) });
  return splits;
}

/**
 * The VRM 1.0 humanoid bone a node name stands for.
 * @param name - The node name, as GLTFLoader cleaned it or as written.
 * @returns The humanoid bone, or null for a bone that is not one (a twist bone, a tail, a helper).
 */
export function humanoidBoneOf(name: string): VrmHumanBoneName | null {
  const lowered = name.toLowerCase().replace(/[^a-z0-9]/gu, '');
  const cleaned = lowered.replace(PREFIX, '');
  if (cleaned === '') return null;
  if (RIGIFY.test(lowered) && Object.hasOwn(RIGIFY_TORSO, cleaned)) return RIGIFY_TORSO[cleaned];
  const vroid = VROID.exec(cleaned);
  if (vroid) {
    const [, side, rest] = vroid;
    if (side === 'c') return UNSIDED_NAMES[rest] ?? null;
    const suffix = SIDED_NAMES[rest];
    return suffix === undefined ? null : `${side === 'l' ? 'left' : 'right'}${suffix}`;
  }
  const unsided = UNSIDED_NAMES[cleaned];
  if (unsided !== undefined) return unsided;
  for (const split of sideSplits(cleaned)) {
    const suffix = SIDED_NAMES[split.rest];
    if (suffix !== undefined) return `${split.side}${suffix}`;
  }
  return null;
}
