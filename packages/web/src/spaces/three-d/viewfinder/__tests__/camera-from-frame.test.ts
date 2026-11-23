// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';

interface Rect { x: number; y: number; width: number; height: number }
interface Saved { position: [number, number, number]; rotation: [number, number, number, number]; focalLength: number }
type FromFrame = (view: { position: Vector3; quaternion: Quaternion }, frame: Rect, viewport: { width: number; height: number }) => Saved;

const modules = import.meta.glob<Record<string, unknown>>('../camera-from-frame.ts', { eager: true });
const cameraFromFrame = (modules['../camera-from-frame.ts'] ?? {}).cameraFromFrame as FromFrame;
const VIEWPORT = { width: 1200, height: 800 };

/** The free view camera: 45 degrees, aimed at the origin from (6, 4, 8). */
function freeView(): PerspectiveCamera {
  const camera = new PerspectiveCamera(45, VIEWPORT.width / VIEWPORT.height, 0.05, 5000);
  camera.position.set(6, 4, 8);
  camera.lookAt(0, 1, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

/** A world point on the free view's ray through a viewport pixel. */
function pointAt(view: PerspectiveCamera, x: number, y: number): Vector3 {
  const ndc = new Vector3((x / VIEWPORT.width) * 2 - 1, 1 - (y / VIEWPORT.height) * 2, 0.5).unproject(view);
  return view.position.clone().add(ndc.sub(view.position).normalize().multiplyScalar(10));
}

/** Where a world point lands in the saved camera's own frame, in NDC. */
function seenBy(saved: Saved, aspect: number, point: Vector3): Vector3 {
  const camera = new PerspectiveCamera(45, aspect, 0.05, 5000);
  camera.filmGauge = 36;
  camera.setFocalLength(saved.focalLength);
  camera.position.fromArray(saved.position);
  camera.quaternion.fromArray(saved.rotation);
  camera.updateMatrixWorld(true);
  return point.clone().project(camera);
}

describe('saving a view as a camera (inner#1694 design 3.5)', () => {
  it('exports cameraFromFrame', () => { expect(typeof cameraFromFrame).toBe('function'); });

  it('aims at the frame centre and fits its top and bottom edges, from the view position', () => {
    const view = freeView();
    const frame = { x: 340, y: 160, width: 640, height: 360 };
    const saved = cameraFromFrame(view, frame, VIEWPORT);
    expect(saved.position).toEqual([6, 4, 8]);
    const centre = seenBy(saved, 16 / 9, pointAt(view, frame.x + frame.width / 2, frame.y + frame.height / 2));
    expect(centre.x).toBeCloseTo(0, 6);
    expect(centre.y).toBeCloseTo(0, 6);
    // The top and bottom rays sit unevenly around the centre ray of a frame off the canvas centre, so each lands near the edge.
    expect(seenBy(saved, 16 / 9, pointAt(view, frame.x + frame.width / 2, frame.y)).y).toBeCloseTo(1, 1);
    expect(seenBy(saved, 16 / 9, pointAt(view, frame.x + frame.width / 2, frame.y + frame.height)).y).toBeCloseTo(-1, 1);
    for (const [x, y] of [[frame.x, frame.y], [frame.x + frame.width, frame.y + frame.height]] as const) {
      expect(Math.abs(seenBy(saved, 16 / 9, pointAt(view, x, y)).x)).toBeCloseTo(1, 1);
    }
  });

  it('keeps the camera upright', () => {
    const saved = cameraFromFrame(freeView(), { x: 100, y: 100, width: 640, height: 360 }, VIEWPORT);
    expect(new Vector3(1, 0, 0).applyQuaternion(new Quaternion().fromArray(saved.rotation)).y).toBeCloseTo(0, 9);
  });

  it('keeps the focal length within 8 to 300 mm', () => {
    expect(cameraFromFrame(freeView(), { x: 598, y: 398, width: 4, height: 2.25 }, VIEWPORT).focalLength).toBe(300);
    const whole = cameraFromFrame(freeView(), { x: 0, y: 0, width: 1200, height: 800 }, VIEWPORT).focalLength;
    expect(whole).toBeGreaterThanOrEqual(8);
    expect(whole).toBeLessThanOrEqual(300);
  });
});

describe('placing a new light (inner#1694 design 3.6)', () => {
  type LightPose = (centre: [number, number, number], viewer: [number, number, number]) => { position: [number, number, number]; rotation: [number, number, number, number] };
  const newLightPose = (modules['../camera-from-frame.ts'] ?? {}).newLightPose as LightPose;

  it('puts the light above the centre, toward the viewer and to the viewer\'s left, aimed at the centre', () => {
    const pose = newLightPose([0, 1, 0], [0, 2, 10]);
    const viewer = new PerspectiveCamera(45, 1);
    viewer.position.set(0, 2, 10);
    viewer.lookAt(0, 1, 0);
    viewer.updateMatrixWorld(true);
    const local = new Vector3().fromArray(pose.position).applyMatrix4(viewer.matrixWorldInverse);
    expect(local.x).toBeLessThan(0);
    expect(pose.position[1]).toBeCloseTo(4.5, 9);
    expect(pose.position[2]).toBeCloseTo(2.5, 9);
    const aim = new Vector3(0, 0, -1).applyQuaternion(new Quaternion().fromArray(pose.rotation));
    expect(aim.dot(new Vector3(0, 1, 0).sub(new Vector3().fromArray(pose.position)).normalize())).toBeCloseTo(1, 9);
  });
});
