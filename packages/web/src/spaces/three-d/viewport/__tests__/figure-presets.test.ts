// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Box3, Quaternion, SkinnedMesh, Vector3, type Bone, type Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createPoseRig, type PoseRig } from '@web/spaces/three-d/viewport/pose-rig';
import { POSE_PRESETS } from '@web/spaces/three-d/viewport/pose-presets';

// Tests run from packages/web; the bytes are the committed asset the browser fetches.
const FIGURE_PATH = 'src/spaces/three-d/viewport/assets/figure.glb';
const PRESETS = Object.entries(POSE_PRESETS);
const SIDES = ['left', 'right'] as const;
/** One centimetre on the 1.75 m figure. */
const GROUND_TOLERANCE = 0.01;

let root: Object3D;
let rig: PoseRig;
let restFloor: number;
/** The hips' rotation at rest, before any test poses the shared figure. */
let hipsRest: Quaternion;

/**
 * The lowest point of the figure's skin as posed now, in the figure's own space.
 * @returns The height.
 * @throws {never} Never.
 */
function lowestPoint(): number {
  root.updateMatrixWorld(true);
  const box = new Box3();
  root.traverse((node) => {
    if (!(node instanceof SkinnedMesh)) return;
    node.computeBoundingBox();
    if (node.boundingBox) box.union(node.boundingBox.clone().applyMatrix4(node.matrixWorld));
  });
  return box.min.y;
}

/**
 * A mapped bone of the figure.
 * @param key - Its pose key.
 * @returns The bone.
 * @throws {Error} When the figure does not map it.
 */
function boneOf(key: string): Bone {
  const bone = rig.joints.find((joint) => joint.key === key)?.bone;
  if (!bone) throw new Error(`no ${key}`);
  return bone;
}

/**
 * Where a mapped bone is now.
 * @param key - Its pose key.
 * @returns Its position in the figure's space.
 * @throws {Error} When the figure does not map it.
 */
function at(key: string): Vector3 {
  return boneOf(key).getWorldPosition(new Vector3());
}

/**
 * The box around the head's skin as posed now: every vertex whose strongest weight is the head bone.
 * @returns The box, in the figure's space.
 * @throws {Error} When the figure does not map a head.
 */
function headBox(): Box3 {
  const head = boneOf('h:head');
  const box = new Box3();
  root.traverse((node) => {
    if (!(node instanceof SkinnedMesh)) return;
    const index = node.skeleton.bones.indexOf(head);
    const indices = node.geometry.getAttribute('skinIndex');
    const weights = node.geometry.getAttribute('skinWeight');
    for (let vertex = 0; vertex < indices.count; vertex += 1) {
      let strongest = 0;
      for (let slot = 1; slot < 4; slot += 1) if (weights.getComponent(vertex, slot) > weights.getComponent(vertex, strongest)) strongest = slot;
      if (indices.getComponent(vertex, strongest) === index) box.expandByPoint(node.getVertexPosition(vertex, new Vector3()).applyMatrix4(node.matrixWorld));
    }
  });
  return box;
}

beforeAll(async () => {
  // Through Response, so the buffer belongs to the realm GLTFLoader checks against.
  const bytes = await new Response(Uint8Array.from(readFileSync(FIGURE_PATH))).arrayBuffer();
  const gltf = await new GLTFLoader().parseAsync(bytes, '');
  root = gltf.scene;
  const created = createPoseRig(root);
  if (!created) throw new Error('the figure has no rig');
  rig = created;
  restFloor = lowestPoint();
  hipsRest = boneOf('h:hips').getWorldQuaternion(new Quaternion());
});

describe('presets on the built-in figure (inner#1692)', () => {
  it('stands on the ground at rest', () => {
    expect(Math.abs(restFloor)).toBeLessThan(GROUND_TOLERANCE);
  });

  it.each(PRESETS)('%s keeps the figure on the ground, neither sunk into it nor floating', (_name, pose) => {
    rig.apply(pose);
    expect(Math.abs(lowestPoint() - restFloor)).toBeLessThan(GROUND_TOLERANCE);
  });

  it('sit bends the knees, the hips on the ground and the feet before them', () => {
    rig.apply(POSE_PRESETS.sit);
    root.updateMatrixWorld(true);
    for (const side of SIDES) {
      const hip = at(`h:${side}UpperLeg`);
      const knee = at(`h:${side}LowerLeg`);
      const ankle = at(`h:${side}Foot`);
      const thigh = knee.clone().sub(hip).normalize();
      const shin = ankle.clone().sub(knee).normalize();
      // Bent well past straight, with the knees raised above the hips.
      expect(thigh.angleTo(shin), side).toBeGreaterThan(Math.PI / 3);
      expect(knee.y, side).toBeGreaterThan(hip.y);
      expect(ankle.z, side).toBeGreaterThan(hip.z);
    }
  });

  it.each(PRESETS)('%s keeps both forearms out of the head', (_name, pose) => {
    rig.apply(pose);
    root.updateMatrixWorld(true);
    const box = headBox();
    for (const side of SIDES) {
      const elbow = at(`h:${side}LowerArm`);
      const wrist = at(`h:${side}Hand`);
      for (let step = 0; step <= 20; step += 1) expect(box.containsPoint(elbow.clone().lerp(wrist, step / 20)), `${side} ${step}`).toBe(false);
    }
  });

  it.each(PRESETS)('%s bends no elbow backward', (_name, pose) => {
    rig.apply(pose);
    // Read the arms in the body's own frame, which faces +Z at rest, so lying down does not tilt the test.
    const toBody = boneOf('h:hips').getWorldQuaternion(new Quaternion()).invert().premultiply(hipsRest);
    for (const side of SIDES) {
      const upper = at(`h:${side}LowerArm`).sub(at(`h:${side}UpperArm`)).applyQuaternion(toBody).normalize();
      const fore = at(`h:${side}Hand`).sub(at(`h:${side}LowerArm`)).applyQuaternion(toBody).normalize();
      expect(fore.z, side).toBeGreaterThan(upper.z - 0.02);
    }
  });
});
