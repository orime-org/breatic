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
 * The skin of some mapped bones as posed now: every vertex whose strongest weight is one of them.
 * @param keys - The bones' pose keys.
 * @returns The vertices, in the figure's space.
 * @throws {Error} When the figure does not map one of them.
 */
function skinOf(keys: readonly string[]): Vector3[] {
  const bones = new Set(keys.map(boneOf));
  const points: Vector3[] = [];
  root.traverse((node) => {
    if (!(node instanceof SkinnedMesh)) return;
    const indices = node.geometry.getAttribute('skinIndex');
    const weights = node.geometry.getAttribute('skinWeight');
    for (let vertex = 0; vertex < indices.count; vertex += 1) {
      let strongest = 0;
      for (let slot = 1; slot < 4; slot += 1) if (weights.getComponent(vertex, slot) > weights.getComponent(vertex, strongest)) strongest = slot;
      if (bones.has(node.skeleton.bones[indices.getComponent(vertex, strongest)])) points.push(node.getVertexPosition(vertex, new Vector3()).applyMatrix4(node.matrixWorld));
    }
  });
  return points;
}

/** How far inside the torso a leg vertex may sit, as a share of the torso's radius there (skinning bulges at the groin). */
const TORSO_DEPTH = 0.4;
/** Height bands and directions the torso's rest radius is measured in. */
const BANDS = 24;
const SECTORS = 16;

/**
 * The torso's radius at rest by height band and direction around its axis, in the hips' frame.
 * @returns How deep a point is inside it: 0 on the surface, 1 at the axis, below 0 outside.
 * @throws {Error} When the figure does not map the torso.
 */
function torsoDepth(): (point: Vector3) => number {
  const hips = boneOf('h:hips');
  const toHips = hips.matrixWorld.clone().invert();
  // The torso is whichever of these the rig maps; the built-in figure has no upper chest.
  const torso = ['h:spine', 'h:chest', 'h:upperChest'].filter((key) => rig.joints.some((joint) => joint.key === key));
  const points = skinOf(torso).map((point) => point.applyMatrix4(toHips));
  const low = Math.min(...points.map((p) => p.y));
  const high = Math.max(...points.map((p) => p.y));
  const band = (y: number): number => Math.min(BANDS - 1, Math.max(0, Math.floor(((y - low) / (high - low)) * BANDS)));
  const sector = (p: Vector3, centre: Vector3): number => Math.floor(((Math.atan2(p.z - centre.z, p.x - centre.x) + Math.PI) / (2 * Math.PI)) * SECTORS) % SECTORS;
  const centres = Array.from({ length: BANDS }, (_, b) => {
    const inBand = points.filter((p) => band(p.y) === b);
    return inBand.reduce((sum, p) => sum.add(new Vector3(p.x, 0, p.z)), new Vector3()).divideScalar(Math.max(1, inBand.length));
  });
  const radii = Array.from({ length: BANDS }, () => new Array<number>(SECTORS).fill(0));
  for (const p of points) {
    const b = band(p.y);
    const s = sector(p, centres[b]);
    radii[b][s] = Math.max(radii[b][s], Math.hypot(p.x - centres[b].x, p.z - centres[b].z));
  }
  return (world) => {
    const p = world.clone().applyMatrix4(hips.matrixWorld.clone().invert());
    if (p.y < low || p.y > high) return -1;
    const b = band(p.y);
    const radius = radii[b][sector(p, centres[b])];
    return radius === 0 ? -1 : 1 - Math.hypot(p.x - centres[b].x, p.z - centres[b].z) / radius;
  };
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
      expect(thigh.angleTo(shin), side).toBeGreaterThan(Math.PI / 4);
      expect(knee.y, side).toBeGreaterThan(hip.y);
      expect(ankle.z, side).toBeGreaterThan(hip.z);
    }
    // Seated: the buttocks rest on the ground with the feet.
    const seat = Math.min(...skinOf(['h:hips', 'h:leftUpperLeg', 'h:rightUpperLeg']).map((point) => point.y));
    expect(seat - restFloor).toBeLessThan(GROUND_TOLERANCE * 2);
  });

  it.each(PRESETS)('%s keeps the skin of both forearms and hands out of the head', (_name, pose) => {
    rig.apply(pose);
    root.updateMatrixWorld(true);
    const head = new Box3().setFromPoints(skinOf(['h:head']));
    for (const side of SIDES) {
      const inside = skinOf([`h:${side}LowerArm`, `h:${side}Hand`]).filter((point) => head.containsPoint(point));
      expect(inside, side).toHaveLength(0);
    }
  });

  it.each(PRESETS)('%s keeps the skin of both legs out of the torso', (_name, pose) => {
    rig.apply({});
    root.updateMatrixWorld(true);
    const depth = torsoDepth();
    rig.apply(pose);
    root.updateMatrixWorld(true);
    const deep = skinOf(['h:leftUpperLeg', 'h:rightUpperLeg', 'h:leftLowerLeg', 'h:rightLowerLeg']).filter((point) => depth(point) > TORSO_DEPTH);
    expect(deep).toHaveLength(0);
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
