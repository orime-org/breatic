// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import {
  Bone, Box3, BoxGeometry, BufferGeometry, DoubleSide, Euler, Float32BufferAttribute, Group, Matrix4, Mesh,
  MeshBasicMaterial, Object3D, Quaternion, Raycaster, Skeleton, SkinnedMesh, Sphere, Uint16BufferAttribute, Vector3,
} from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { SCENE_POSE_KEY_MAX_LENGTH, type ScenePose } from '@breatic/shared';
import { createPoseRig, type PoseRig } from '@web/spaces/three-d/viewport/pose-rig';
import { POSE_PRESETS } from '@web/spaces/three-d/viewport/pose-presets';

const ONE_DEGREE = Math.PI / 180;
const STRIP_WIDTH = 0.03;
const X_AXIS = new Vector3(1, 0, 0);
const Y_AXIS = new Vector3(0, 1, 0);
const Z_AXIS = new Vector3(0, 0, 1);
const SIDES = ['left', 'right'] as const;
const PRESETS = Object.entries(POSE_PRESETS) as readonly (readonly [string, ScenePose])[];

type Vec = readonly [number, number, number];
type Side = typeof SIDES[number];
type Scheme = 'vrm' | 'mixamo' | 'unreal' | 'mannequiny' | 'biped' | 'rigify';
type BodyPart = 'hips' | 'spine' | 'chest' | 'neck' | 'head';
type LimbPart = 'Shoulder' | 'UpperArm' | 'LowerArm' | 'Hand' | 'HandTip' | 'UpperLeg' | 'LowerLeg' | 'Foot' | 'Toes';

/** One joint of a synthetic rig: its role in these tests, its parent role, rest position in model-root space and node name. */
interface Joint {
  readonly role: string;
  parent: string | null;
  readonly at: Vector3;
  readonly name: string;
}

/** A synthetic skinned character built in code. */
interface Figure {
  readonly root: Group;
  readonly mesh: SkinnedMesh;
  readonly bones: ReadonlyMap<string, Bone>;
  /** The rotation from a VRM-facing model (front +Z, left hand +X) to this model's authored facing. */
  readonly facing: Quaternion;
  /** The rest bounding-box bottom in model-root space. */
  readonly floor: number;
  /** Rest hips height above {@link floor}. */
  readonly hipHeight: number;
}

/** How to vary the canonical T-pose figure. */
interface FigureOptions {
  readonly label?: string;
  readonly scheme?: Scheme;
  readonly arms?: 'T' | 'A';
  readonly facing?: 'posZ' | 'negZ';
  /** Insert unmapped bones between spine and chest and between the left shoulder and upper arm. */
  readonly helpers?: boolean;
  /** Put the bones under an `Armature` node rotated 90 degrees about X and scaled 0.01. */
  readonly armature?: boolean;
  readonly omit?: readonly string[];
  readonly extras?: readonly { readonly name: string; readonly parent: string; readonly at: Vec }[];
  /** World rest rotation per joint, in joint order; random roll that keeps the rest geometry. */
  readonly roll?: readonly Quaternion[];
}

/** A VRM T-pose: front +Z, left hand +X, Y up, metres. */
const BODY: readonly (readonly [BodyPart, BodyPart | null, Vec])[] = [
  ['hips', null, [0, 1, 0]],
  ['spine', 'hips', [0, 1.1, 0]],
  ['chest', 'spine', [0, 1.25, 0]],
  ['neck', 'chest', [0, 1.5, 0]],
  ['head', 'neck', [0, 1.6, 0]],
];

/** Left-side limbs; the right side mirrors X. */
const LIMB: readonly (readonly [LimbPart, LimbPart | 'chest' | 'hips', Vec])[] = [
  ['Shoulder', 'chest', [0.05, 1.45, 0]],
  ['UpperArm', 'Shoulder', [0.18, 1.45, 0]],
  ['LowerArm', 'UpperArm', [0.45, 1.45, 0]],
  ['Hand', 'LowerArm', [0.7, 1.45, 0]],
  ['HandTip', 'Hand', [0.8, 1.45, 0]],
  ['UpperLeg', 'hips', [0.1, 0.95, 0]],
  ['LowerLeg', 'UpperLeg', [0.1, 0.52, 0]],
  ['Foot', 'LowerLeg', [0.1, 0.1, 0]],
  ['Toes', 'Foot', [0.1, 0.02, 0.14]],
];

const BODY_NAMES: Readonly<Record<Scheme, Readonly<Record<BodyPart, string>>>> = {
  vrm: { hips: 'hips', spine: 'spine', chest: 'chest', neck: 'neck', head: 'head' },
  mixamo: { hips: 'mixamorigHips', spine: 'mixamorigSpine', chest: 'mixamorigSpine1', neck: 'mixamorigNeck', head: 'mixamorigHead' },
  unreal: { hips: 'pelvis', spine: 'spine_01', chest: 'spine_02', neck: 'neck_01', head: 'head' },
  mannequiny: { hips: 'pelvis', spine: 'spine_01', chest: 'spine_02', neck: 'neck_01', head: 'head' },
  biped: { hips: 'Bip001_Pelvis', spine: 'Bip001_Spine', chest: 'Bip001_Spine1', neck: 'Bip001_Neck', head: 'Bip001_Head' },
  rigify: { hips: 'DEF-spine', spine: 'DEF-spine001', chest: 'DEF-spine002', neck: 'DEF-spine004', head: 'DEF-spine006' },
};

const MIXAMO_PARTS: Readonly<Record<LimbPart, string>> = {
  Shoulder: 'Shoulder', UpperArm: 'Arm', LowerArm: 'ForeArm', Hand: 'Hand', HandTip: 'HandMiddle1',
  UpperLeg: 'UpLeg', LowerLeg: 'Leg', Foot: 'Foot', Toes: 'ToeBase',
};

const UNREAL_PARTS: Readonly<Record<LimbPart, string>> = {
  Shoulder: 'clavicle', UpperArm: 'upperarm', LowerArm: 'lowerarm', Hand: 'hand', HandTip: 'middle_01',
  UpperLeg: 'thigh', LowerLeg: 'calf', Foot: 'foot', Toes: 'ball',
};

const RIGIFY_PARTS: Readonly<Record<LimbPart, string>> = {
  Shoulder: 'shoulder', UpperArm: 'upper_arm', LowerArm: 'forearm', Hand: 'hand', HandTip: 'f_middle01',
  UpperLeg: 'thigh', LowerLeg: 'shin', Foot: 'foot', Toes: 'toe',
};

const BIPED_PARTS: Readonly<Record<LimbPart, string>> = {
  Shoulder: 'Clavicle', UpperArm: 'UpperArm', LowerArm: 'Forearm', Hand: 'Hand', HandTip: 'Finger2',
  UpperLeg: 'Thigh', LowerLeg: 'Calf', Foot: 'Foot', Toes: 'Toe0',
};

/** The required humanoid keys: hips, spine, head and the six limb segments of each side. */
const REQUIRED_KEYS = ['h:hips', 'h:spine', 'h:head', ...SIDES.flatMap((side) =>
  ['UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot'].map((part) => `h:${side}${part}`))];

/** Every humanoid key the full VRM-named figure maps. */
const FULL_VRM_KEYS = ['h:hips', 'h:spine', 'h:chest', 'h:neck', 'h:head', ...SIDES.flatMap((side) =>
  ['Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'MiddleProximal', 'UpperLeg', 'LowerLeg', 'Foot', 'Toes']
    .map((part) => `h:${side}${part}`))];

/** Limb segments measured by the invariance property: bone role to the child joint role. */
const SEGMENTS = SIDES.flatMap((side) => ([
  ['UpperArm', 'LowerArm'], ['LowerArm', 'Hand'], ['Hand', 'HandTip'],
  ['UpperLeg', 'LowerLeg'], ['LowerLeg', 'Foot'], ['Foot', 'Toes'],
] as const).map(([from, to]) => [`${side}${from}`, `${side}${to}`] as const));

/** The six rigs the design names; every one has the same world rest geometry up to facing and arm angle. */
const VARIANTS: readonly FigureOptions[] = [
  { label: 'T-pose' },
  { label: 'A-pose', arms: 'A' },
  { label: 'facing -Z', facing: 'negZ' },
  { label: 'unmapped intermediate bones', helpers: true },
  { label: 'rotated and scaled Armature parent', armature: true, scheme: 'mixamo' },
  { label: 'missing optional bones', omit: ['chest', 'neck', 'leftShoulder', 'rightShoulder'] },
];

/** A fixed, non-trivial bone roll for deterministic cases. */
const FIXED_ROLL = Array.from({ length: 40 }, (_, index) => new Quaternion().setFromEuler(new Euler(index * 0.7, index * 1.3, index * 0.4)));

const coordinate = fc.double({ min: -1, max: 1, noNaN: true });
const unitQuaternion = fc.tuple(coordinate, coordinate, coordinate, coordinate)
  .filter((value) => Math.hypot(...value) > 0.1)
  .map((value) => {
    const length = Math.hypot(...value);
    return value.map((part) => part / length);
  });
const rollArbitrary = fc.array(unitQuaternion.map(([x, y, z, w]) => new Quaternion(x, y, z, w)), { minLength: 40, maxLength: 40 });

/**
 * Name a limb joint in one naming scheme, as GLTFLoader leaves it.
 * @throws {never} Never.
 */
function limbName(scheme: Scheme, side: Side, part: LimbPart): string {
  switch (scheme) {
    case 'vrm': return `${side}${part === 'HandTip' ? 'MiddleProximal' : part}`;
    case 'mixamo': return `mixamorig${side === 'left' ? 'Left' : 'Right'}${MIXAMO_PARTS[part]}`;
    case 'unreal': return `${UNREAL_PARTS[part]}_${side[0]}`;
    case 'mannequiny': return part === 'HandTip' ? '' : `${UNREAL_PARTS[part]}${side[0]}`;
    case 'biped': return `Bip001_${side === 'left' ? 'L' : 'R'}_${BIPED_PARTS[part]}`;
    case 'rigify': return `DEF-${RIGIFY_PARTS[part]}${side === 'left' ? 'L' : 'R'}`;
  }
}

/**
 * The canonical T-pose joints, parents before children.
 * @throws {never} Never.
 */
function layout(scheme: Scheme): Joint[] {
  const joints: Joint[] = BODY.map(([part, parent, at]) => ({ role: part, parent, at: new Vector3(...at), name: BODY_NAMES[scheme][part] }));
  for (const side of SIDES) {
    for (const [part, parent, at] of LIMB) {
      joints.push({
        role: `${side}${part}`,
        parent: parent === 'chest' || parent === 'hips' ? parent : `${side}${parent}`,
        at: new Vector3(side === 'left' ? at[0] : -at[0], at[1], at[2]),
        name: limbName(scheme, side, part),
      });
    }
  }
  return joints;
}

/**
 * Insert an unmapped joint between a parent and one of its children.
 * @throws {Error} When the child is missing.
 */
function insertBetween(joints: Joint[], parent: string, child: string, role: string, at: Vec): void {
  const index = joints.findIndex((joint) => joint.role === child);
  if (index < 0) throw new Error(`no ${child}`);
  joints.splice(index, 0, { role, parent, at: new Vector3(...at), name: role === 'helperSpine' ? 'HelperSpine' : 'HelperArm' });
  joints[index + 1].parent = role;
}

/**
 * Push a cross of two thin quads from `a` to `b`, all weighted to one bone.
 * @throws {never} Never.
 */
function pushStrip(push: (points: readonly Vector3[], bone: number) => void, a: Vector3, b: Vector3, bone: number): void {
  const axis = b.clone().sub(a).normalize();
  const u = new Vector3().crossVectors(axis, Math.abs(axis.y) < 0.9 ? Y_AXIS : X_AXIS).normalize().multiplyScalar(STRIP_WIDTH);
  const v = new Vector3().crossVectors(axis, u).normalize().multiplyScalar(STRIP_WIDTH);
  for (const across of [u, v]) {
    const a1 = a.clone().add(across);
    const a2 = a.clone().sub(across);
    const b1 = b.clone().add(across);
    const b2 = b.clone().sub(across);
    push([a1, a2, b1], bone);
    push([a2, b2, b1], bone);
  }
}

/**
 * A skinned body: a strip along every bone segment, weighted to the segment's bone, plus a triangle at each leaf joint.
 * @throws {never} Never.
 */
function skinnedBody(joints: readonly Joint[]): SkinnedMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const weights: number[] = [];
  /**
   * Append one triangle skinned fully to one bone.
   * @throws {never} Never.
   */
  const push = (points: readonly Vector3[], bone: number): void => {
    for (const point of points) {
      positions.push(point.x, point.y, point.z);
      indices.push(bone, 0, 0, 0);
      weights.push(1, 0, 0, 0);
    }
  };
  joints.forEach((joint, index) => {
    const parent = joints.findIndex((other) => other.role === joint.parent);
    if (parent >= 0) pushStrip(push, joints[parent].at, joint.at, parent);
    if (!joints.some((other) => other.parent === joint.role)) {
      push([joint.at, joint.at.clone().add(new Vector3(STRIP_WIDTH, 0, 0)), joint.at.clone().add(new Vector3(0, STRIP_WIDTH, 0))], index);
    }
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
  return new SkinnedMesh(geometry, new MeshBasicMaterial({ side: DoubleSide }));
}

/**
 * Build bones whose world rest transforms are exactly the given positions and rotations, then bind a body to them.
 * @throws {Error} When a parent joint is missing.
 */
function assemble(joints: readonly Joint[], options: { armature?: boolean; roll?: readonly Quaternion[]; facing?: Quaternion }): Figure {
  const facing = options.facing ?? new Quaternion();
  const root = new Group();
  root.name = 'model';
  let container: Object3D = root;
  let unit = 1;
  if (options.armature) {
    const armature = new Object3D();
    armature.name = 'Armature';
    armature.quaternion.setFromAxisAngle(X_AXIS, Math.PI / 2);
    armature.scale.setScalar(0.01);
    root.add(armature);
    container = armature;
    unit = 0.01;
  }
  root.updateMatrixWorld(true);
  const bones = new Map<string, Bone>();
  const list: Bone[] = [];
  joints.forEach((joint, index) => {
    const bone = new Bone();
    bone.name = joint.name;
    const parent = joint.parent === null ? container : bones.get(joint.parent);
    if (!parent) throw new Error(`no parent ${joint.parent}`);
    const rotation = facing.clone().multiply(options.roll?.[index] ?? new Quaternion());
    const world = new Matrix4().compose(joint.at, rotation, new Vector3(unit, unit, unit));
    new Matrix4().copy(parent.matrixWorld).invert().multiply(world).decompose(bone.position, bone.quaternion, bone.scale);
    parent.add(bone);
    bone.updateMatrixWorld(true);
    bones.set(joint.role, bone);
    list.push(bone);
  });
  const mesh = skinnedBody(joints);
  mesh.name = 'body';
  root.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(new Skeleton(list));
  mesh.computeBoundingBox();
  const floor = mesh.boundingBox?.min.y ?? 0;
  const hips = bones.get('hips');
  const hipHeight = hips ? hips.getWorldPosition(new Vector3()).y - floor : 0;
  return { root, mesh, bones, facing, floor, hipHeight };
}

/**
 * Build one variant of the synthetic character.
 * @throws {Error} When an option names a missing joint.
 */
function buildFigure(options: FigureOptions = {}): Figure {
  let joints = layout(options.scheme ?? 'vrm');
  if (options.helpers) {
    insertBetween(joints, 'spine', 'chest', 'helperSpine', [0, 1.18, 0]);
    insertBetween(joints, 'leftShoulder', 'leftUpperArm', 'helperArm', [0.12, 1.45, 0]);
  }
  for (const extra of options.extras ?? []) joints.push({ role: `extra:${extra.name}`, parent: extra.parent, at: new Vector3(...extra.at), name: extra.name });
  for (const role of options.omit ?? []) {
    const gone = joints.find((joint) => joint.role === role);
    if (!gone) throw new Error(`no ${role}`);
    for (const joint of joints) if (joint.parent === role) joint.parent = gone.parent;
    joints = joints.filter((joint) => joint !== gone);
  }
  if (options.arms === 'A') {
    for (const side of SIDES) {
      const pivot = joints.find((joint) => joint.role === `${side}UpperArm`)?.at.clone() ?? new Vector3();
      const turn = new Quaternion().setFromAxisAngle(Z_AXIS, side === 'left' ? -Math.PI / 4 : Math.PI / 4);
      for (const joint of joints) {
        if ([`${side}LowerArm`, `${side}Hand`, `${side}HandTip`].includes(joint.role)) joint.at.sub(pivot).applyQuaternion(turn).add(pivot);
      }
    }
  }
  const facing = options.facing === 'negZ' ? new Quaternion().setFromAxisAngle(Y_AXIS, Math.PI) : new Quaternion();
  for (const joint of joints) joint.at.applyQuaternion(facing);
  return assemble(joints, { armature: options.armature, roll: options.roll, facing });
}

/**
 * A plain chain of bones up +Y, for rigs that are not humanoid.
 * @throws {never} Never.
 */
function buildChain(names: readonly string[]): Figure {
  return assemble(names.map((name, index) => ({
    role: `c${index}`, parent: index === 0 ? null : `c${index - 1}`, at: new Vector3(0, 0.2 * index, 0), name,
  })), {});
}

/**
 * Create a rig and require it to exist.
 * @throws {Error} When the instance has no rig.
 */
function rigOf(root: Object3D): PoseRig {
  const rig = createPoseRig(root);
  if (!rig) throw new Error('expected a pose rig');
  return rig;
}

/**
 * A joint's position in model-root space (every figure's root sits at the origin unless a test moves it).
 * @throws {Error} When the role is missing.
 */
function worldOf(figure: Figure, role: string): Vector3 {
  const bone = figure.bones.get(role);
  if (!bone) throw new Error(`no ${role}`);
  return bone.getWorldPosition(new Vector3());
}

/**
 * Each measured limb segment's direction, expressed in the model's own facing frame.
 * @throws {Error} When a segment joint is missing.
 */
function segmentDirections(figure: Figure): Map<string, Vector3> {
  figure.root.updateMatrixWorld(true);
  const toFacing = figure.facing.clone().invert();
  return new Map(SEGMENTS.map(([from, to]) => [from, worldOf(figure, to).sub(worldOf(figure, from)).normalize().applyQuaternion(toFacing)]));
}

/**
 * Hips height above the rest floor, in rest hip heights.
 * @throws {Error} When the figure has no hips.
 */
function hipRatio(figure: Figure): number {
  return (worldOf(figure, 'hips').y - figure.floor) / figure.hipHeight;
}

/**
 * The posed skinned bounds of a figure, computed here independently of the rig.
 * @throws {never} Never.
 */
function posedBounds(figure: Figure): Box3 {
  figure.root.updateMatrixWorld(true);
  figure.mesh.computeBoundingBox();
  return figure.mesh.boundingBox?.clone() ?? new Box3();
}

/**
 * Assert two quaternion tuples are the same rotation, regardless of sign.
 * @throws {Error} When they differ.
 */
function expectSameRotation(actual: readonly number[], expected: readonly number[], label: string): void {
  expect(actual, label).toHaveLength(4);
  expect(Math.abs(Math.hypot(...actual) - 1), label).toBeLessThan(1e-6);
  const sign = actual.reduce((sum, part, index) => sum + part * expected[index], 0) < 0 ? -1 : 1;
  for (let index = 0; index < 4; index += 1) expect(Math.abs(actual[index] - sign * expected[index]), label).toBeLessThan(1e-6);
}

/**
 * Deep-copy a pose so equality is by value, not identity.
 * @throws {never} Never.
 */
function copyOf(pose: ScenePose): ScenePose {
  return Object.fromEntries(Object.entries(pose).map(([key, value]) => [key, [...value]]));
}

/**
 * Whether an object sits under a root.
 * @throws {never} Never.
 */
function isInside(object: Object3D, root: Object3D): boolean {
  for (let node: Object3D | null = object; node; node = node.parent) if (node === root) return true;
  return false;
}

/**
 * Every bone under a root, in traversal order.
 * @throws {never} Never.
 */
function bonesUnder(root: Object3D): Bone[] {
  const bones: Bone[] = [];
  root.traverse((node) => {
    if (node instanceof Bone) bones.push(node);
  });
  return bones;
}

describe('createPoseRig: what a rig is (inner#1692)', () => {
  it('returns null for a model without bones', () => {
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
    expect(createPoseRig(root)).toBeNull();
  });

  it.each(['vrm', 'mixamo', 'unreal', 'mannequiny', 'biped', 'rigify'] as const)('recognises a %s-named skeleton as humanoid', (scheme) => {
    const figure = buildFigure({ scheme });
    const rig = rigOf(figure.root);
    expect(rig.kind).toBe('humanoid');
    const keys = rig.joints.map((joint) => joint.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => key.startsWith('h:'))).toBe(true);
    for (const key of REQUIRED_KEYS) expect(keys, key).toContain(key);
    expect(rig.joints.find((joint) => joint.key === 'h:leftUpperArm')?.bone.name).toBe(limbName(scheme, 'left', 'UpperArm'));
  });

  it.each(['vrm', 'mixamo'] as const)('lists exactly the mapped bones of a full %s skeleton', (scheme) => {
    const keys = rigOf(buildFigure({ scheme }).root).joints.map((joint) => joint.key);
    expect([...keys].sort()).toEqual([...FULL_VRM_KEYS].sort());
  });

  it('leaves unmapped bones out of a humanoid rig', () => {
    const figure = buildFigure({ helpers: true, extras: [{ name: 'upperarm_twist_01_l', parent: 'leftUpperArm', at: [0.3, 1.45, 0] }] });
    const rig = rigOf(figure.root);
    expect([...rig.joints.map((joint) => joint.key)].sort()).toEqual([...FULL_VRM_KEYS].sort());
    for (const joint of rig.joints) expect(joint.key).toBe(`h:${joint.bone.name}`);
  });

  it('keeps the main upper arm when a twist bone sits under it', () => {
    const figure = buildFigure({ scheme: 'unreal', extras: [{ name: 'upperarm_twist_01_l', parent: 'leftUpperArm', at: [0.3, 1.45, 0] }] });
    expect(rigOf(figure.root).joints.find((joint) => joint.key === 'h:leftUpperArm')?.bone.name).toBe('upperarm_l');
  });

  it('lists only the bones present when optional bones are missing', () => {
    const figure = buildFigure({ omit: ['chest', 'neck', 'leftShoulder', 'rightShoulder'] });
    const keys = rigOf(figure.root).joints.map((joint) => joint.key);
    expect([...keys].sort()).toEqual(FULL_VRM_KEYS.filter((key) => !['h:chest', 'h:neck', 'h:leftShoulder', 'h:rightShoulder'].includes(key)).sort());
  });

  it('treats a skeleton missing a required bone as another rig keyed by node name', () => {
    const figure = buildFigure({ omit: ['leftFoot'] });
    const rig = rigOf(figure.root);
    expect(rig.kind).toBe('other');
    const expected = [...figure.bones.values()].map((bone) => `n:${bone.name}`);
    expect([...rig.joints.map((joint) => joint.key)].sort()).toEqual(expected.sort());
  });

  it('keys a non-humanoid rig by node name and skips unnamed and over-long bones', () => {
    const fits = 'x'.repeat(SCENE_POSE_KEY_MAX_LENGTH - 2);
    const tooLong = 'y'.repeat(SCENE_POSE_KEY_MAX_LENGTH - 1);
    const figure = buildChain(['Body', 'Tail_1', '', 'Tail_2', fits, tooLong, 'Leg_FL']);
    const rig = rigOf(figure.root);
    expect(rig.kind).toBe('other');
    expect([...rig.joints.map((joint) => joint.key)].sort()).toEqual(['n:Body', 'n:Tail_1', 'n:Tail_2', `n:${fits}`, 'n:Leg_FL'].sort());
    for (const joint of rig.joints) expect(joint.key).toBe(`n:${joint.bone.name}`);
  });

  it('reads no value for the hips translation, which no joint drags', () => {
    expect(rigOf(buildFigure().root).keyValue('t:hips')).toBeNull();
  });

  it('reads no value for a key the rig does not have', () => {
    const rig = rigOf(buildFigure().root);
    expect(rig.keyValue('h:notABone')).toBeNull();
    expect(rig.keyValue('n:hips')).toBeNull();
  });
});

describe('PoseRig.apply: retargeting invariants (inner#1692)', () => {
  it('poses every limb segment the same way on every rest pose, facing, hierarchy and bone roll', () => {
    const reference = buildFigure();
    const referenceRig = rigOf(reference.root);
    const expected = new Map(PRESETS.map(([name, pose]) => {
      referenceRig.apply(pose);
      return [name, { directions: segmentDirections(reference), hips: hipRatio(reference) }] as const;
    }));
    for (const [name, pose] of PRESETS) {
      // Hip translation is in hip heights, measured from the rest bounding-box bottom.
      expect(Math.abs((expected.get(name)?.hips ?? Number.NaN) - (1 + (pose['t:hips']?.[1] ?? 0))), name).toBeLessThan(1e-4);
    }
    fc.assert(fc.property(rollArbitrary, (roll) => {
      for (const variant of VARIANTS) {
        const figure = buildFigure({ ...variant, roll });
        const rig = rigOf(figure.root);
        expect(rig.kind, variant.label).toBe('humanoid');
        for (const [name, pose] of PRESETS) {
          rig.apply(pose);
          const want = expected.get(name);
          if (!want) throw new Error(name);
          for (const [segment, direction] of segmentDirections(figure)) {
            const angle = direction.angleTo(want.directions.get(segment) ?? new Vector3());
            expect(angle, `${variant.label} / ${name} / ${segment}`).toBeLessThan(ONE_DEGREE);
          }
          expect(Math.abs(hipRatio(figure) - want.hips), `${variant.label} / ${name} / hips`).toBeLessThan(1e-3);
        }
      }
    }), { numRuns: 15 });
  });

  it('round-trips random rotations through apply and keyValue, with or without a hips translation', () => {
    const figures: readonly FigureOptions[] = [...VARIANTS, { label: 'partial humanoid', omit: ['leftFoot'] }];
    const vector = fc.tuple(coordinate, coordinate, coordinate);
    fc.assert(fc.property(
      rollArbitrary,
      fc.integer({ min: 0, max: figures.length - 1 }),
      fc.array(fc.tuple(fc.nat(), unitQuaternion), { minLength: 1, maxLength: 12 }),
      fc.option(vector, { nil: undefined }),
      (roll, which, picks, hips) => {
        const figure = buildFigure({ ...figures[which], roll });
        const rig = rigOf(figure.root);
        const keys = rig.joints.map((joint) => joint.key);
        const pose: Record<string, readonly number[]> = {};
        for (const [index, rotation] of picks) pose[keys[index % keys.length]] = rotation;
        if (hips && rig.kind === 'humanoid') pose['t:hips'] = hips;
        rig.apply(pose);
        for (const [key, value] of Object.entries(pose)) {
          // Joints only turn; the hips translation is written by presets and never read back.
          if (key === 't:hips') continue;
          const read = rig.keyValue(key);
          expect(read, key).not.toBeNull();
          expectSameRotation(read ?? [], value, `${figures[which].label} ${key}`);
        }
      },
    ), { numRuns: 60 });
  });

  it('returns every bone to rest when a key is missing', () => {
    const figure = buildFigure({ roll: FIXED_ROLL, armature: true, scheme: 'mixamo' });
    const rest = [...figure.bones.values()].map((bone) => ({ bone, quaternion: bone.quaternion.clone(), position: bone.position.clone() }));
    const rig = rigOf(figure.root);
    rig.apply(POSE_PRESETS.sit);
    rig.apply({});
    for (const { bone, quaternion, position } of rest) {
      expect(bone.quaternion.angleTo(quaternion), bone.name).toBeLessThan(1e-6);
      expect(bone.position.distanceTo(position), bone.name).toBeLessThan(1e-6);
    }
  });

  it('measures rest in model-root space, so the object transform does not change the pose', () => {
    const plain = buildFigure({ roll: FIXED_ROLL });
    const placed = buildFigure({ roll: FIXED_ROLL });
    placed.root.position.set(3, 2, -1);
    placed.root.quaternion.setFromEuler(new Euler(0.4, 1.1, -0.3));
    placed.root.scale.setScalar(2.5);
    placed.root.updateMatrixWorld(true);
    const plainRig = rigOf(plain.root);
    const placedRig = rigOf(placed.root);
    for (const [name, pose] of PRESETS) {
      plainRig.apply(pose);
      placedRig.apply(pose);
      for (const [role, bone] of plain.bones) {
        const other = placed.bones.get(role);
        if (!other) throw new Error(role);
        expect(bone.quaternion.angleTo(other.quaternion), `${name} ${role}`).toBeLessThan(1e-6);
        expect(bone.position.distanceTo(other.position), `${name} ${role}`).toBeLessThan(1e-6);
      }
    }
  });

  it('keeps the pose in model space when the object moves after the rig was measured', () => {
    const plain = buildFigure({ roll: FIXED_ROLL });
    const moved = buildFigure({ roll: FIXED_ROLL });
    const plainRig = rigOf(plain.root);
    // The viewport measures a fresh instance at rest and only then places it.
    const movedRig = rigOf(moved.root);
    moved.root.position.set(1.6, 0, -2);
    moved.root.quaternion.setFromEuler(new Euler(0, 0.9, 0));
    moved.root.scale.setScalar(1.5);
    moved.root.updateMatrixWorld(true);
    for (const [name, pose] of PRESETS) {
      plainRig.apply(pose);
      movedRig.apply(pose);
      for (const [role, bone] of plain.bones) {
        const other = moved.bones.get(role);
        if (!other) throw new Error(role);
        expect(bone.quaternion.angleTo(other.quaternion), `${name} ${role}`).toBeLessThan(1e-6);
        expect(bone.position.distanceTo(other.position), `${name} ${role}`).toBeLessThan(1e-6);
      }
    }
  });

  it('poses two SkeletonUtils clones independently', () => {
    const source = buildFigure({ roll: FIXED_ROLL });
    const first = clone(source.root);
    const second = clone(source.root);
    const firstRig = rigOf(first);
    const secondRig = rigOf(second);
    for (const joint of firstRig.joints) expect(isInside(joint.bone, first)).toBe(true);
    for (const joint of secondRig.joints) expect(isInside(joint.bone, second)).toBe(true);
    const secondRest = bonesUnder(second).map((bone) => bone.quaternion.clone());
    firstRig.apply(POSE_PRESETS.wave);
    bonesUnder(second).forEach((bone, index) => expect(bone.quaternion.equals(secondRest[index])).toBe(true));
    expect(bonesUnder(first).some((bone, index) => bone.quaternion.angleTo(secondRest[index]) > 1e-3)).toBe(true);
    const firstWave = bonesUnder(first).map((bone) => bone.quaternion.clone());
    secondRig.apply(POSE_PRESETS.sit);
    bonesUnder(first).forEach((bone, index) => expect(bone.quaternion.equals(firstWave[index])).toBe(true));
  });
});

describe('pose presets on a character (inner#1692)', () => {
  it('stand hangs both arms and keeps the hips and feet in place', () => {
    const figure = buildFigure();
    rigOf(figure.root).apply(POSE_PRESETS.stand);
    for (const side of SIDES) {
      expect(worldOf(figure, `${side}Hand`).y, side).toBeLessThan(worldOf(figure, `${side}UpperArm`).y - 0.3);
      expect(Math.abs(worldOf(figure, `${side}Foot`).y - 0.1), side).toBeLessThan(0.05);
    }
    expect(Math.abs(hipRatio(figure) - 1)).toBeLessThan(0.05);
  });

  it('sit puts the hips near the ground without sinking below it', () => {
    const figure = buildFigure();
    rigOf(figure.root).apply(POSE_PRESETS.sit);
    expect(hipRatio(figure)).toBeLessThan(0.4);
    expect(posedBounds(figure).min.y).toBeGreaterThan(figure.floor - 0.1 * figure.hipHeight);
  });

  it('lie lays the body flat on the ground', () => {
    const figure = buildFigure();
    rigOf(figure.root).apply(POSE_PRESETS.lie);
    const bounds = posedBounds(figure);
    expect(bounds.max.y - bounds.min.y).toBeLessThan(0.5 * figure.hipHeight);
    expect(Math.abs(bounds.min.y - figure.floor)).toBeLessThan(0.2 * figure.hipHeight);
  });

  it('walk puts one foot ahead of the other', () => {
    const figure = buildFigure();
    rigOf(figure.root).apply(POSE_PRESETS.walk);
    expect(Math.abs(worldOf(figure, 'leftFoot').z - worldOf(figure, 'rightFoot').z)).toBeGreaterThan(0.1 * figure.hipHeight);
  });

  it('wave raises a hand above the head', () => {
    const figure = buildFigure();
    rigOf(figure.root).apply(POSE_PRESETS.wave);
    const highest = Math.max(worldOf(figure, 'leftHand').y, worldOf(figure, 'rightHand').y);
    expect(highest).toBeGreaterThan(worldOf(figure, 'head').y);
  });
});

describe('PoseRig.apply: skinned bounds (inner#1692)', () => {
  it('recomputes the bounds of every skinned mesh, so raycasts find the moved limb', () => {
    const figure = buildFigure();
    const second = new SkinnedMesh(figure.mesh.geometry, figure.mesh.material);
    figure.root.add(second);
    second.bind(figure.mesh.skeleton, figure.mesh.bindMatrix);
    const rig = rigOf(figure.root);
    for (const mesh of [figure.mesh, second]) {
      // A stale cache far from the body: only a recompute lets a ray reach the posed limb.
      mesh.boundingSphere = new Sphere(new Vector3(0, 100, 0), 0.001);
      mesh.boundingBox = new Box3(new Vector3(0, 100, 0), new Vector3(0.001, 100.001, 0.001));
    }
    rig.apply(POSE_PRESETS.lie);
    figure.root.updateMatrixWorld(true);
    const elbow = worldOf(figure, 'leftLowerArm');
    const wrist = worldOf(figure, 'leftHand');
    const target = elbow.clone().lerp(wrist, 0.3);
    const axis = wrist.clone().sub(elbow).normalize();
    const across = new Vector3().crossVectors(axis, Math.abs(axis.y) < 0.9 ? Y_AXIS : X_AXIS).normalize();
    const raycaster = new Raycaster(target.clone().addScaledVector(across, 5), across.clone().negate());
    for (const mesh of [figure.mesh, second]) {
      expect(mesh.boundingSphere?.containsPoint(target)).toBe(true);
      expect(mesh.boundingBox?.containsPoint(target)).toBe(true);
      expect(raycaster.intersectObject(mesh, false).length).toBeGreaterThan(0);
    }
  });

  it('skips recomputing bounds for an equal pose until invalidated', () => {
    const figure = buildFigure();
    const rig = rigOf(figure.root);
    rig.apply(POSE_PRESETS.sit);
    const sphere = vi.spyOn(figure.mesh, 'computeBoundingSphere');
    const box = vi.spyOn(figure.mesh, 'computeBoundingBox');
    rig.apply(copyOf(POSE_PRESETS.sit));
    expect(sphere).not.toHaveBeenCalled();
    expect(box).not.toHaveBeenCalled();
    rig.invalidate();
    rig.apply(copyOf(POSE_PRESETS.sit));
    expect(sphere).toHaveBeenCalled();
    expect(box).toHaveBeenCalled();
    sphere.mockClear();
    rig.apply(POSE_PRESETS.walk);
    expect(sphere).toHaveBeenCalled();
  });

  it('leaves the bounds alone while a pose is still being dragged and recomputes them once it settles', () => {
    const figure = buildFigure();
    const rig = rigOf(figure.root);
    rig.apply(POSE_PRESETS.stand);
    const sphere = vi.spyOn(figure.mesh, 'computeBoundingSphere');
    const box = vi.spyOn(figure.mesh, 'computeBoundingBox');
    // Wave raises the right hand.
    const hand = figure.bones.get('rightHand');
    if (!hand) throw new Error('no hand');
    const before = hand.getWorldPosition(new Vector3());
    rig.apply(POSE_PRESETS.wave, false);
    // The bones follow the preview at once; only the bounds wait.
    expect(hand.getWorldPosition(new Vector3()).distanceTo(before)).toBeGreaterThan(0.1);
    rig.apply(POSE_PRESETS.walk, false);
    expect(sphere).not.toHaveBeenCalled();
    expect(box).not.toHaveBeenCalled();
    // The committed value equals the last preview, and still brings the bounds up to date.
    rig.apply(copyOf(POSE_PRESETS.walk));
    expect(sphere).toHaveBeenCalledTimes(1);
    expect(box).toHaveBeenCalledTimes(1);
    rig.apply(copyOf(POSE_PRESETS.walk));
    expect(sphere).toHaveBeenCalledTimes(1);
  });

  it('puts the document pose back after a local bone change once invalidated', () => {
    const figure = buildFigure({ roll: FIXED_ROLL });
    const rig = rigOf(figure.root);
    rig.apply(POSE_PRESETS.sit);
    const arm = figure.bones.get('leftUpperArm');
    if (!arm) throw new Error('no arm');
    const posed = arm.quaternion.clone();
    arm.quaternion.premultiply(new Quaternion().setFromAxisAngle(Z_AXIS, 0.8));
    rig.invalidate();
    rig.apply(copyOf(POSE_PRESETS.sit));
    expect(arm.quaternion.angleTo(posed)).toBeLessThan(1e-6);
  });
});
