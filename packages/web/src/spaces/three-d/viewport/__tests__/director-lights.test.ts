// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Box3, OrthographicCamera, Vector3 } from 'three';

interface LightInput { id: string; number: number; castShadow: boolean }
interface LightPlan { enabled: boolean; castsShadow: boolean; note: 'overLimit' | 'shadowBudget' | null }
interface Plan { defaultKey: boolean; lights: Readonly<Record<string, LightPlan>> }
interface Range { left: number; right: number; top: number; bottom: number; near: number; far: number }

const modules = import.meta.glob<Record<string, unknown>>('../director-lights.ts', { eager: true });
const lights = modules['../director-lights.ts'] ?? {};
const planLights = lights.planLights as (input: readonly LightInput[], limits: { maxLights: number; shadowSlots: number }) => Plan;
const shadowSlots = lights.shadowSlots as (maxTextures: number, programSamplers: readonly (readonly string[])[]) => number;
const directionalRange = lights.directionalShadowRange as (camera: OrthographicCamera, direction: Vector3, box: Box3, reach: number) => Range;
const localFar = lights.localShadowFar as (lightPosition: Vector3, box: Box3, reach: number) => number;

const light = (n: number, castShadow = true, id = `l${String(n).padStart(2, '0')}`): LightInput => ({ id, number: n, castShadow });

describe('which lights shine and cast shadows (inner#1694 design 6.4)', () => {
  it('exports planLights', () => { expect(typeof planLights).toBe('function'); });

  it('turns the default key light on only when there is no valid user light', () => {
    expect(planLights([], { maxLights: 16, shadowSlots: 4 }).defaultKey).toBe(true);
    expect(planLights([light(1)], { maxLights: 16, shadowSlots: 4 }).defaultKey).toBe(false);
  });

  it('enables the first max_lights lights by number, then id, and marks the rest over the limit', () => {
    const plan = planLights([light(3), light(1), light(2, true, 'b'), light(2, true, 'a')], { maxLights: 2, shadowSlots: 8 });
    expect(plan.lights.l01).toMatchObject({ enabled: true, note: null });
    expect(plan.lights.a).toMatchObject({ enabled: true, note: null });
    expect(plan.lights.b).toEqual({ enabled: false, castsShadow: false, note: 'overLimit' });
    expect(plan.lights.l03).toEqual({ enabled: false, castsShadow: false, note: 'overLimit' });
  });

  it('gives shadow slots in the same order to enabled lights whose shadow is on', () => {
    const plan = planLights([light(1, false), light(2), light(3), light(4)], { maxLights: 16, shadowSlots: 2 });
    expect(plan.lights.l01).toEqual({ enabled: true, castsShadow: false, note: null });
    expect(plan.lights.l02).toEqual({ enabled: true, castsShadow: true, note: null });
    expect(plan.lights.l03).toEqual({ enabled: true, castsShadow: true, note: null });
    expect(plan.lights.l04).toEqual({ enabled: true, castsShadow: false, note: 'shadowBudget' });
  });

  it('never enables more than max_lights or casts more than the slots, for any input', () => {
    const input = fc.uniqueArray(fc.record({ id: fc.uuid(), number: fc.integer({ min: 1, max: 40 }), castShadow: fc.boolean() }), { selector: (item) => item.id, maxLength: 30 });
    fc.assert(fc.property(input, fc.integer({ min: 0, max: 20 }), fc.integer({ min: 0, max: 20 }), (items, maxLights, slots) => {
      const plan = planLights(items, { maxLights, shadowSlots: slots });
      const values = Object.values(plan.lights);
      expect(values).toHaveLength(items.length);
      expect(values.filter((value) => value.enabled).length).toBe(Math.min(items.length, maxLights));
      expect(values.filter((value) => value.castsShadow).length).toBeLessThanOrEqual(slots);
      expect(values.every((value) => !value.castsShadow || value.enabled)).toBe(true);
    }), { numRuns: 200 });
  });
});

describe('the shadow budget (design 3.6)', () => {
  it('exports shadowSlots', () => { expect(typeof shadowSlots).toBe('function'); });

  it('is zero before any mesh program is compiled', () => {
    expect(shadowSlots(16, [])).toBe(0);
  });

  it('leaves one spare unit after the most sampler-hungry program, not counting shadow maps', () => {
    const skinned = ['map', 'normalMap', 'boneTexture', 'directionalShadowMap', 'spotShadowMap', 'pointShadowMap'];
    const plain = ['map'];
    expect(shadowSlots(16, [plain, skinned])).toBe(16 - 3 - 1);
  });

  it('never goes below zero', () => {
    expect(shadowSlots(4, [['a', 'b', 'c', 'd', 'e']])).toBe(0);
  });
});

describe('shadow camera range (design 3.6)', () => {
  const box = new Box3(new Vector3(-0.5, 0, -0.5), new Vector3(0.5, 1.8, 0.5));
  const corners = (b: Box3): Vector3[] => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));

  /** A shadow camera placed and aimed the way three r173 places it for a light. */
  function shadowCamera(position: Vector3, target: Vector3): OrthographicCamera {
    const camera = new OrthographicCamera();
    camera.position.copy(position);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    return camera;
  }

  /** Whether a world point falls inside the range in the camera's own space. */
  function inside(range: Range, camera: OrthographicCamera, point: Vector3): boolean {
    const p = point.clone().applyMatrix4(camera.matrixWorldInverse);
    const eps = 1e-9;
    return p.x >= range.left - eps && p.x <= range.right + eps && p.y >= range.bottom - eps && p.y <= range.top + eps && -p.z >= range.near - eps && -p.z <= range.far + eps;
  }

  it('exports the two range functions', () => {
    expect([typeof directionalRange, typeof localFar]).toEqual(['function', 'function']);
  });

  it('covers the box and its shadow on the ground for a light from above', () => {
    const position = new Vector3(5, 10, 4);
    const direction = position.clone().negate().normalize();
    const camera = shadowCamera(position, new Vector3());
    const range = directionalRange(camera, direction, box, 3);
    for (const corner of corners(box)) {
      expect(inside(range, camera, corner)).toBe(true);
      const ground = corner.clone().addScaledVector(direction, -corner.y / direction.y);
      expect(inside(range, camera, ground)).toBe(true);
    }
    expect(Object.values(range).every(Number.isFinite)).toBe(true);
  });

  it('allows a negative near so a model behind the light still casts', () => {
    const position = new Vector3(0, 1, 0);
    const camera = shadowCamera(position, new Vector3(0, 0, 1));
    const range = directionalRange(camera, new Vector3(0, -0.2, 1).normalize(), new Box3(new Vector3(-0.5, 0, -3), new Vector3(0.5, 1.8, -2)), 3);
    expect(range.near).toBeLessThan(0);
  });

  it('uses only the box when the light is near horizontal or points up', () => {
    const position = new Vector3(10, 0.2, 0);
    const camera = shadowCamera(position, new Vector3(0, 0, 0));
    const direction = new Vector3(-1, -0.02, 0).normalize();
    const range = directionalRange(camera, direction, box, 3);
    const boxOnly = corners(box).map((corner) => corner.applyMatrix4(camera.matrixWorldInverse));
    expect(range.right - range.left).toBeCloseTo(Math.max(...boxOnly.map((p) => p.x)) - Math.min(...boxOnly.map((p) => p.x)), 9);
    expect(range.far).toBeCloseTo(Math.max(...boxOnly.map((p) => -p.z)), 9);
  });

  it('caps the ground projection at reach times the box diagonal', () => {
    const direction = new Vector3(-1, -0.06, 0).normalize();
    const position = direction.clone().multiplyScalar(-20);
    const camera = shadowCamera(position, new Vector3());
    const range = directionalRange(camera, direction, box, 3);
    const diagonal = box.max.distanceTo(box.min);
    expect(range.far - range.near).toBeLessThanOrEqual(new Vector3(1, 1.8, 1).length() + 3 * diagonal + 1e-6);
  });

  it('reaches the farthest corner or ground shadow point for a spot or point light', () => {
    const position = new Vector3(2, 3, 0);
    const far = localFar(position, box, 3);
    const diagonal = box.max.distanceTo(box.min);
    let expected = 0;
    for (const corner of corners(box)) {
      expected = Math.max(expected, position.distanceTo(corner));
      if (corner.y < position.y) {
        const ray = corner.clone().sub(position).normalize();
        const length = Math.min(-corner.y / ray.y, 3 * diagonal);
        expected = Math.max(expected, position.distanceTo(corner.clone().addScaledVector(ray, length)));
      }
    }
    expect(far).toBeCloseTo(expected, 9);
  });
});
