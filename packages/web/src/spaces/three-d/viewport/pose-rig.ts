// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { Bone, Box3, Matrix4, Quaternion, SkinnedMesh, Vector3, type Object3D } from 'three';
import { SCENE_POSE_HIPS_KEY, SCENE_POSE_KEY_MAX_LENGTH, type ScenePose } from '@breatic/shared';

import { REQUIRED_HUMAN_BONES, humanoidBoneOf, type VrmHumanBoneName } from '@web/spaces/three-d/viewport/pose-bone-names';

/**
 * A character instance's pose, read and written in the stored pose format
 * (inner#1692, design section 3).
 *
 * Humanoid bones take VRM 1.0 normalized rotations: each `h:` value is a
 * rotation relative to the nearest mapped parent, in a frame where the figure
 * stands in a T-pose facing +Z with its left hand on +X. A rig is brought into
 * that frame by its facing (from its legs) and, for each limb segment, by the
 * turn from its rest direction to the T-pose direction, so one value poses
 * every humanoid rig alike; the formula is three-vrm's normalized bones
 * (`raw = P⁻¹ · N · P · B`) with those two corrections. Any other rig takes
 * `n:` rotations relative to each bone's own rest.
 */

/** The bones of one rig, measured at rest in the instance's own space. */
interface RigBone {
  bone: Bone;
  /** The rig bone this one hangs from; null when its parent is not a bone of the rig. */
  parent: RigBone | null;
  /** The parent's rest rotation in instance space when the parent is not a rig bone. */
  outsideParent: Quaternion;
  restLocal: Quaternion;
  restPosition: Vector3;
  restModel: Quaternion;
  restModelPosition: Vector3;
  human: VrmHumanBoneName | null;
  /** The nearest mapped ancestor, for a mapped bone. */
  humanParent: RigBone | null;
  /** The turn from the rest direction to the T-pose direction, in the T-pose frame. */
  correction: Quaternion;
}

export interface PoseRig {
  readonly kind: 'humanoid' | 'other';
  readonly joints: readonly { key: string; bone: Bone }[];
  /**
   * Set every bone from a pose; a missing key leaves its bone at rest. A pose
   * still being dragged (`settled` false) leaves the skinned bounds as they
   * are, since recomputing them visits every vertex; the settled pose brings
   * them up to date.
   */
  apply(pose: ScenePose, settled?: boolean): void;
  /** The pose value a key holds now, or null when the rig has no such key. */
  keyValue(key: string): readonly number[] | null;
  /** Forget the last pose applied, so the next apply sets every bone again. */
  invalidate(): void;
}

const Y_AXIS = new Vector3(0, 1, 0);

/** Each limb segment, the mapped bone its direction points to and its T-pose direction. */
const SEGMENTS: Readonly<Partial<Record<VrmHumanBoneName, { to: VrmHumanBoneName; direction: Vector3 }>>> = {
  leftUpperArm: { to: 'leftLowerArm', direction: new Vector3(1, 0, 0) },
  leftLowerArm: { to: 'leftHand', direction: new Vector3(1, 0, 0) },
  rightUpperArm: { to: 'rightLowerArm', direction: new Vector3(-1, 0, 0) },
  rightLowerArm: { to: 'rightHand', direction: new Vector3(-1, 0, 0) },
  leftUpperLeg: { to: 'leftLowerLeg', direction: new Vector3(0, -1, 0) },
  leftLowerLeg: { to: 'leftFoot', direction: new Vector3(0, -1, 0) },
  rightUpperLeg: { to: 'rightLowerLeg', direction: new Vector3(0, -1, 0) },
  rightLowerLeg: { to: 'rightFoot', direction: new Vector3(0, -1, 0) },
};

/** A hand or foot turns with the segment above it: it has no single child to aim at. */
const INHERITS: Readonly<Partial<Record<VrmHumanBoneName, VrmHumanBoneName>>> = {
  leftHand: 'leftLowerArm', rightHand: 'rightLowerArm', leftFoot: 'leftLowerLeg', rightFoot: 'rightLowerLeg',
};

/**
 * Read a stored rotation as a quaternion.
 * @param value - The stored `[x, y, z, w]`.
 * @returns The quaternion, normalized.
 */
function quaternionOf(value: readonly number[]): Quaternion {
  return new Quaternion(value[0], value[1], value[2], value[3]).normalize();
}

/**
 * Write a quaternion as a stored rotation.
 * @param q - The rotation.
 * @returns The `[x, y, z, w]` tuple, normalized.
 */
function stored(q: Quaternion): readonly number[] {
  const n = q.clone().normalize();
  return [n.x, n.y, n.z, n.w];
}

/**
 * The bones of an instance, parents before children.
 * @param instance - The model instance.
 * @returns Its bones in traversal order.
 */
function bonesOf(instance: Object3D): Bone[] {
  const bones: Bone[] = [];
  instance.traverse((node) => { if (node instanceof Bone) bones.push(node); });
  return bones;
}

/**
 * Measure an instance at rest and build its rig.
 * @param instance - A model instance, still at rest.
 * @returns The rig, or null when the instance has no bones.
 */
export function createPoseRig(instance: Object3D): PoseRig | null {
  const found = bonesOf(instance);
  if (found.length === 0) return null;
  instance.updateMatrixWorld(true);
  const toModel = instance.matrixWorld.clone().invert();
  /**
   * A node's rest position and rotation in instance space.
   * @param node - A node of the instance.
   * @returns Its position and rotation, scale left out.
   */
  const modelOf = (node: Object3D): { position: Vector3; rotation: Quaternion } => {
    const position = new Vector3();
    const rotation = new Quaternion();
    new Matrix4().multiplyMatrices(toModel, node.matrixWorld).decompose(position, rotation, new Vector3());
    return { position, rotation };
  };

  const byBone = new Map<Bone, RigBone>();
  const rig: RigBone[] = found.map((bone) => {
    const model = modelOf(bone);
    const parentNode = bone.parent;
    const entry: RigBone = {
      bone, parent: null,
      outsideParent: parentNode === null || parentNode === instance ? new Quaternion() : modelOf(parentNode).rotation,
      restLocal: bone.quaternion.clone(), restPosition: bone.position.clone(),
      restModel: model.rotation, restModelPosition: model.position,
      human: null, humanParent: null, correction: new Quaternion(),
    };
    byBone.set(bone, entry);
    return entry;
  });
  for (const entry of rig) entry.parent = entry.bone.parent instanceof Bone ? byBone.get(entry.bone.parent) ?? null : null;

  // The first bone to claim a humanoid name keeps it; a second one (a hip under a pelvis) stays unmapped.
  const human = new Map<VrmHumanBoneName, RigBone>();
  for (const entry of rig) {
    const name = humanoidBoneOf(entry.bone.name);
    if (name !== null && !human.has(name)) human.set(name, entry);
  }
  const humanoid = REQUIRED_HUMAN_BONES.every((name) => human.has(name));
  if (humanoid) for (const [name, entry] of human) entry.human = name;
  for (const entry of rig) {
    if (entry.human === null) continue;
    let up = entry.parent;
    while (up !== null && up.human === null) up = up.parent;
    entry.humanParent = up;
  }

  const meshes: SkinnedMesh[] = [];
  instance.traverse((node) => { if (node instanceof SkinnedMesh) meshes.push(node); });

  // Facing: the turn about Y from VRM's left (+X) to this rig's left, read from the legs.
  const facing = new Quaternion();
  let hipHeight = 1;
  if (humanoid) {
    const left = human.get('leftUpperLeg')!.restModelPosition.clone().sub(human.get('rightUpperLeg')!.restModelPosition);
    facing.setFromAxisAngle(Y_AXIS, Math.atan2(-left.z, left.x));
    const unfacing = facing.clone().invert();
    for (const [name, segment] of Object.entries(SEGMENTS) as [VrmHumanBoneName, { to: VrmHumanBoneName; direction: Vector3 }][]) {
      const from = human.get(name);
      const to = human.get(segment.to);
      if (!from || !to) continue;
      const rest = to.restModelPosition.clone().sub(from.restModelPosition).applyQuaternion(unfacing).normalize();
      if (rest.lengthSq() > 0) from.correction.setFromUnitVectors(rest, segment.direction);
    }
    for (const [name, source] of Object.entries(INHERITS) as [VrmHumanBoneName, VrmHumanBoneName][]) {
      const to = human.get(name);
      const from = human.get(source);
      if (to && from) to.correction.copy(from.correction);
    }
    hipHeight = human.get('hips')!.restModelPosition.y - restFloor(toModel, meshes, rig);
    if (!(hipHeight > 0)) hipHeight = 1;
  }
  const unfacing = facing.clone().invert();

  const joints = humanoid
    ? rig.filter((entry) => entry.human !== null).map((entry) => ({ key: `h:${entry.human}`, bone: entry.bone }))
    : rig.filter((entry) => entry.bone.name !== '' && entry.bone.name.length + 2 <= SCENE_POSE_KEY_MAX_LENGTH)
      .map((entry) => ({ key: `n:${entry.bone.name}`, bone: entry.bone }));
  const byKey = new Map(joints.map((joint) => [joint.key, byBone.get(joint.bone)!]));
  const hips = human.get('hips');
  // Instance space to the hips' parent at rest, where the hips position is written. The
  // hips' ancestors are never posed (the hips top the humanoid chain), so rest is now.
  const hipsParent = hips?.bone.parent;
  const toHipsParent = hipsParent ? new Matrix4().multiplyMatrices(toModel, hipsParent.matrixWorld).invert() : new Matrix4();

  /**
   * A mapped bone's normalized global rotation from its rotation in instance space.
   * @param entry - A mapped bone.
   * @param model - Its current rotation in instance space.
   * @returns `G = Y⁻¹ · W · W_rest⁻¹ · Y · C⁻¹`.
   */
  const globalOf = (entry: RigBone, model: Quaternion): Quaternion =>
    unfacing.clone().multiply(model).multiply(entry.restModel.clone().invert()).multiply(facing).multiply(entry.correction.clone().invert());

  /**
   * Every rig bone's current rotation in instance space, from the live local rotations.
   * @returns Rotations by bone.
   */
  const currentModel = (): Map<RigBone, Quaternion> => {
    const model = new Map<RigBone, Quaternion>();
    for (const entry of rig) {
      const parent = entry.parent === null ? entry.outsideParent : model.get(entry.parent)!;
      model.set(entry, parent.clone().multiply(entry.bone.quaternion));
    }
    return model;
  };

  /**
   * Set every bone of the instance from a pose and update its world matrices.
   * @param pose - The pose; a missing key leaves its bone at rest.
   */
  const setBones = (pose: ScenePose): void => {
    const model = new Map<RigBone, Quaternion>();
    const global = new Map<RigBone, Quaternion>();
    for (const entry of rig) {
      const parent = entry.parent === null ? entry.outsideParent : model.get(entry.parent)!;
      const value = humanoid
        ? (entry.human === null ? undefined : pose[`h:${entry.human}`])
        : pose[`n:${entry.bone.name}`];
      let current: Quaternion;
      if (value !== undefined && humanoid) {
        const g = (entry.humanParent === null ? new Quaternion() : global.get(entry.humanParent)!.clone()).multiply(quaternionOf(value));
        // W' = Y · G · C · Y⁻¹ · W_rest
        current = facing.clone().multiply(g).multiply(entry.correction).multiply(unfacing).multiply(entry.restModel);
        entry.bone.quaternion.copy(parent.clone().invert().multiply(current));
      } else {
        entry.bone.quaternion.copy(entry.restLocal);
        if (value !== undefined) entry.bone.quaternion.multiply(quaternionOf(value));
        current = parent.clone().multiply(entry.bone.quaternion);
      }
      model.set(entry, current);
      if (entry.human !== null) global.set(entry, globalOf(entry, current));
      entry.bone.position.copy(entry.restPosition);
    }
    const translation = pose[SCENE_POSE_HIPS_KEY];
    if (humanoid && hips && translation !== undefined) {
      const target = hips.restModelPosition.clone()
        .add(new Vector3(translation[0], translation[1], translation[2]).multiplyScalar(hipHeight).applyQuaternion(facing));
      hips.bone.position.copy(target.applyMatrix4(toHipsParent));
    }
    instance.updateMatrixWorld(true);
  };

  let applied: string | null = null;
  let boundsCurrent = false;

  return {
    kind: humanoid ? 'humanoid' : 'other',
    joints,
    apply(pose, settled = true) {
      const signature = JSON.stringify(Object.entries(pose).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      if (signature !== applied) {
        applied = signature;
        boundsCurrent = false;
        setBones(pose);
      }
      if (!settled || boundsCurrent) return;
      boundsCurrent = true;
      for (const mesh of meshes) {
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
      }
    },
    keyValue(key) {
      const entry = byKey.get(key);
      if (!entry) return null;
      if (!humanoid) return stored(entry.restLocal.clone().invert().multiply(entry.bone.quaternion));
      const model = currentModel();
      const g = globalOf(entry, model.get(entry)!);
      const parentG = entry.humanParent === null ? new Quaternion() : globalOf(entry.humanParent, model.get(entry.humanParent)!);
      return stored(parentG.invert().multiply(g));
    },
    invalidate() {
      applied = null;
    },
  };
}

/**
 * The lowest point of the instance at rest, in instance space.
 * @param toModel - Instance space from world space.
 * @param meshes - Its skinned meshes.
 * @param rig - Its bones, for an instance with no skinned mesh.
 * @returns The floor height.
 */
function restFloor(toModel: Matrix4, meshes: readonly SkinnedMesh[], rig: readonly RigBone[]): number {
  const box = new Box3();
  for (const mesh of meshes) {
    mesh.computeBoundingBox();
    if (mesh.boundingBox) box.union(mesh.boundingBox.clone().applyMatrix4(new Matrix4().multiplyMatrices(toModel, mesh.matrixWorld)));
  }
  if (!box.isEmpty()) return box.min.y;
  return Math.min(...rig.map((entry) => entry.restModelPosition.y));
}

const rigs = new WeakMap<Object3D, PoseRig | null>();

/**
 * The rig of an instance, built on first use while it is still at rest.
 * @param instance - The model instance.
 * @returns The rig, or null when the instance has no bones.
 */
export function poseRigOf(instance: Object3D): PoseRig | null {
  let rig = rigs.get(instance);
  if (rig === undefined) {
    rig = createPoseRig(instance);
    rigs.set(instance, rig);
  }
  return rig;
}

/**
 * Pose an instance; every pose shown goes through here.
 * @param instance - The model instance.
 * @param pose - The pose; absent means rest.
 * @param settled - False for a pose still being dragged, which leaves the skinned bounds for later.
 */
export function applyPose(instance: Object3D, pose: ScenePose | undefined, settled = true): void {
  poseRigOf(instance)?.apply(pose ?? {}, settled);
}
