// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Part tables and applying a look to an object's own materials (inner#1693 design 5.1, 5.2).
 */

import {
  BoxGeometry, BufferGeometry, Color, Float32BufferAttribute, Group, LineBasicMaterial, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial,
  Points, PointsMaterial, Texture,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import * as looks from '@web/spaces/three-d/viewport/look-materials';

const IMAGE = '66666666-6666-4666-8666-666666666666';
const THEME = '#5f5f5f';

type PartTable = ReadonlyMap<string, { materialType: string; color: string; roughness?: number; transmission: number; transparent: boolean; depthWrite: boolean; alphaTest: number; hasMap: boolean; unlit: boolean; line: boolean }>;
type Build = (root: Group, partOf: (material: unknown) => string, options: { builtin: boolean }) => PartTable;
type Apply = (root: Group, table: PartTable, look: Record<string, Record<string, unknown>>, options: {
  themeColor: string; picture: (assetId: string) => Texture | null;
}) => { programChanged: boolean };

/**
 * An export of the module under test.
 * @param name - Its name.
 * @returns The export.
 * @throws {AssertionError} When it is missing.
 */
function exported<T>(name: string): T {
  const candidate = (looks as Record<string, unknown>)[name];
  expect(candidate, `${name} must be exported`).toBeTypeOf('function');
  return candidate as T;
}

/** A model with two parts: part 0 a textured standard material, part 1 a glass physical one, part 2 unlit. */
function model(): { root: Group; meshes: Mesh[] } {
  const root = new Group();
  const map = new Texture();
  const first = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ color: '#ffffff', roughness: 0.7, metalness: 0, map }));
  const glass = new MeshPhysicalMaterial({ color: '#ffffff', roughness: 0, transmission: 1 });
  const second = new Mesh(new BoxGeometry(), glass);
  const third = new Mesh(new BoxGeometry(), new MeshBasicMaterial({ color: '#ff0000' }));
  first.material.userData.lookPart = '0'; glass.userData.lookPart = '1'; third.material.userData.lookPart = '2';
  root.add(first, second, third);
  return { root, meshes: [first, second, third] };
}

/** The part a material belongs to, from the key load put on it. */
const partOf = (material: unknown): string => (material as { userData: { lookPart: string } }).userData.lookPart;

/** The one material of a mesh. */
const materialOf = (mesh: Mesh): MeshStandardMaterial => mesh.material as MeshStandardMaterial;

describe('buildPartTable', () => {
  it('records each part\'s own class, values and transparency settings', () => {
    const { root } = model();
    const table = exported<Build>('buildPartTable')(root, partOf, { builtin: false });
    expect(table.get('0')).toMatchObject({ materialType: 'MeshStandardMaterial', color: '#ffffff', roughness: 0.7, transmission: 0, hasMap: true, unlit: false });
    expect(table.get('1')).toMatchObject({ materialType: 'MeshPhysicalMaterial', transmission: 1 });
    expect(table.get('2')).toMatchObject({ materialType: 'MeshBasicMaterial', unlit: true });
  });

  it('marks a line part as line', () => {
    const root = new Group();
    const material = new LineBasicMaterial({ color: '#00ff00' });
    material.userData.lookPart = '0';
    const line = new Mesh(new BoxGeometry(), material as never);
    root.add(line);
    expect(exported<Build>('buildPartTable')(root, partOf, { builtin: false }).get('0')).toMatchObject({ line: true });
  });

  it('reports a part whose material also draws triangles from its triangle variant, met after a points variant', () => {
    const root = new Group();
    const points = new PointsMaterial({ color: '#00ff00' });
    const lit = new MeshStandardMaterial({ color: '#00ff00', roughness: 0.3, metalness: 0.6 });
    points.userData.lookPart = '0';
    lit.userData.lookPart = '0';
    root.add(new Points(new BoxGeometry(), points), new Mesh(new BoxGeometry(), lit));
    const entry = exported<Build>('buildPartTable')(root, partOf, { builtin: false }).get('0');
    expect(entry).toMatchObject({ materialType: 'MeshStandardMaterial', line: false, roughness: 0.3, metalness: 0.6 });
    expect([points.userData.lookOriginal, lit.userData.lookOriginal]).toEqual([0, 1]);
  });
});

describe('applyLook', () => {
  it('asks for a new shader program only when picture presence, transmission past 0 or transparency changes', () => {
    const { root, meshes } = model();
    const table = exported<Build>('buildPartTable')(root, partOf, { builtin: false });
    const apply = (look: Record<string, Record<string, unknown>>): void => {
      exported<Apply>('applyLook')(root, table, look as never, { themeColor: THEME, picture: () => new Texture() });
    };
    apply({ 0: { roughness: 0.2 } });
    const version = (): number => materialOf(meshes[0]!).version;
    let last = version();
    apply({ 0: { roughness: 0.5, color: '#112233', metalness: 1 } });
    expect(version()).toBe(last);
    apply({ 0: { roughness: 0.5, opacity: 0.4 } });
    expect(version()).toBeGreaterThan(last);
    last = version();
    apply({ 0: { roughness: 0.5, opacity: 0.6 } });
    expect(version()).toBe(last);
    apply({ 0: { roughness: 0.5, opacity: 0.6, map: 'none' } });
    expect(version()).toBeGreaterThan(last);
  });

  it('writes stored fields onto this object\'s own material and keeps the others', () => {
    const { root, meshes } = model();
    const table = exported<Build>('buildPartTable')(root, partOf, { builtin: false });
    exported<Apply>('applyLook')(root, table, { 0: { color: '#112233', metalness: 1 } }, { themeColor: THEME, picture: () => null });
    expect(`#${materialOf(meshes[0]!).color.getHexString()}`).toBe('#112233');
    expect(materialOf(meshes[0]!).metalness).toBe(1);
    expect(materialOf(meshes[0]!).roughness).toBe(0.7);
  });

  it('restores the part table values on an empty look, including after a class change', () => {
    const { root, meshes } = model();
    const apply = exported<Apply>('applyLook');
    const table = exported<Build>('buildPartTable')(root, partOf, { builtin: false });
    apply(root, table, { 0: { transmission: 1, opacity: 0.5 } }, { themeColor: THEME, picture: () => null });
    expect(meshes[0]!.material).toBeInstanceOf(MeshPhysicalMaterial);
    expect((meshes[0]!.material as MeshPhysicalMaterial).defines).toMatchObject({ STANDARD: '', PHYSICAL: '' });
    apply(root, table, {}, { themeColor: THEME, picture: () => null });
    expect(meshes[0]!.material.constructor).toBe(MeshStandardMaterial);
    expect(materialOf(meshes[0]!).transparent).toBe(false);
    expect(materialOf(meshes[0]!).depthWrite).toBe(true);
    expect(materialOf(meshes[0]!).roughness).toBe(0.7);
  });

  it('turns an own glass part off when transmission is set to 0', () => {
    const { root, meshes } = model();
    const table = exported<Build>('buildPartTable')(root, partOf, { builtin: false });
    exported<Apply>('applyLook')(root, table, { 1: { transmission: 0 } }, { themeColor: THEME, picture: () => null });
    expect((meshes[1]!.material as MeshPhysicalMaterial).transmission ?? 0).toBe(0);
  });

  it('turns transparency on below opacity 1 and back to the part\'s own settings at 1', () => {
    const { root, meshes } = model();
    const apply = exported<Apply>('applyLook');
    const table = exported<Build>('buildPartTable')(root, partOf, { builtin: false });
    apply(root, table, { 0: { opacity: 0.4 } }, { themeColor: THEME, picture: () => null });
    expect(materialOf(meshes[0]!).transparent).toBe(true);
    expect(materialOf(meshes[0]!).depthWrite).toBe(false);
    apply(root, table, { 0: { opacity: 1 } }, { themeColor: THEME, picture: () => null });
    expect(materialOf(meshes[0]!).transparent).toBe(false);
    expect(materialOf(meshes[0]!).depthWrite).toBe(true);
  });

  it('shows a usable user picture at white unless a colour is stored, with repeat wrapping from the origin', () => {
    const { root, meshes } = model();
    const picture = new Texture();
    const table = exported<Build>('buildPartTable')(root, partOf, { builtin: false });
    exported<Apply>('applyLook')(root, table, { 0: { map: IMAGE, mapRepeat: [3, 2], mapRotation: 90 } }, { themeColor: THEME, picture: () => picture });
    const material = materialOf(meshes[0]!);
    expect(`#${material.color.getHexString()}`).toBe('#ffffff');
    expect(material.map).not.toBe(picture);
    expect(material.map?.source).toBe(picture.source);
    expect(material.map?.repeat.toArray()).toEqual([3, 2]);
    expect(material.map?.center.toArray()).toEqual([0, 0]);
    expect(material.map?.rotation).toBeCloseTo(Math.PI / 2);
    expect(material.map?.wrapS).toBe(1000);
  });

  it('falls back to the own picture and tiling, keeping stored colour and finish, while the user picture is unusable', () => {
    const { root, meshes } = model();
    const ownMap = materialOf(meshes[0]!).map;
    const table = exported<Build>('buildPartTable')(root, partOf, { builtin: false });
    exported<Apply>('applyLook')(root, table, { 0: { map: IMAGE, mapRepeat: [3, 3], color: '#ff0000', metalness: 1 } }, { themeColor: THEME, picture: () => null });
    const material = materialOf(meshes[0]!);
    expect(material.map?.source).toBe(ownMap?.source);
    expect(material.map?.repeat.toArray()).toEqual([1, 1]);
    expect(`#${material.color.getHexString()}`).toBe('#ff0000');
    expect(material.metalness).toBe(1);
  });

  it('drops the own picture for none', () => {
    const { root, meshes } = model();
    const table = exported<Build>('buildPartTable')(root, partOf, { builtin: false });
    exported<Apply>('applyLook')(root, table, { 0: { map: 'none' } }, { themeColor: THEME, picture: () => null });
    expect(materialOf(meshes[0]!).map).toBeNull();
  });

  it('applies only colour, picture and opacity to an unlit part', () => {
    const { root, meshes } = model();
    const table = exported<Build>('buildPartTable')(root, partOf, { builtin: false });
    exported<Apply>('applyLook')(root, table, { 2: { color: '#00ff00', opacity: 0.5, transmission: 1, roughness: 0 } }, { themeColor: THEME, picture: () => null });
    expect(meshes[2]!.material).toBeInstanceOf(MeshBasicMaterial);
    expect(`#${(meshes[2]!.material as MeshBasicMaterial).color.getHexString()}`).toBe('#00ff00');
    expect((meshes[2]!.material as MeshBasicMaterial).opacity).toBe(0.5);
  });

  it('gives a built-in part the current theme colour unless a colour is stored', () => {
    const { root, meshes } = model();
    const apply = exported<Apply>('applyLook');
    const table = exported<Build>('buildPartTable')(root, partOf, { builtin: true });
    apply(root, table, {}, { themeColor: '#969696', picture: () => null });
    expect(`#${materialOf(meshes[0]!).color.getHexString()}`).toBe('#969696');
    apply(root, table, { 0: { color: '#112233' } }, { themeColor: '#5f5f5f', picture: () => null });
    expect(`#${materialOf(meshes[0]!).color.getHexString()}`).toBe('#112233');
    expect(new Color(materialOf(meshes[1]!).color).getHexString()).toBe('5f5f5f');
  });

  it('reports a program change when the class, the picture presence or the transmission sign changes', () => {
    const { root } = model();
    const apply = exported<Apply>('applyLook');
    const table = exported<Build>('buildPartTable')(root, partOf, { builtin: false });
    const options = { themeColor: THEME, picture: () => new Texture() };
    expect(apply(root, table, { 0: { color: '#111111' } }, options).programChanged).toBe(false);
    expect(apply(root, table, { 0: { color: '#111111', transmission: 1 } }, options).programChanged).toBe(true);
    expect(apply(root, table, { 0: { color: '#111111', transmission: 1 }, 1: { transmission: 0 } }, options).programChanged).toBe(true);
    expect(apply(root, table, { 0: { color: '#111111', transmission: 1 }, 1: { transmission: 0 }, 2: { map: IMAGE } }, options).programChanged).toBe(true);
    expect(apply(root, table, { 0: { color: '#222222', transmission: 1 }, 1: { transmission: 0 }, 2: { map: IMAGE } }, options).programChanged).toBe(false);
  });

  it('resets each of a part\'s materials to its own loaded state, as GLTFLoader splits one glTF material per primitive', () => {
    const root = new Group();
    const plain = new MeshStandardMaterial({ color: '#ffffff' });
    const coloured = plain.clone();
    coloured.vertexColors = true;
    coloured.flatShading = true;
    coloured.normalScale.y = -1;
    const dots = new PointsMaterial({ color: '#ffffff', size: 3 });
    for (const material of [plain, coloured, dots]) material.userData.lookPart = '0';
    const first = new Mesh(new BoxGeometry(), plain);
    const second = new Mesh(new BoxGeometry(), coloured);
    const cloud = new Points(new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3)), dots);
    root.add(first, second, cloud);
    const apply = exported<Apply>('applyLook');
    const table = exported<Build>('buildPartTable')(root, partOf, { builtin: false });
    apply(root, table, {}, { themeColor: THEME, picture: () => null });
    expect(second.material).toMatchObject({ vertexColors: true, flatShading: true });
    expect((second.material as MeshStandardMaterial).normalScale.y).toBe(-1);
    expect(cloud.material).toBeInstanceOf(PointsMaterial);
    expect((cloud.material as PointsMaterial).size).toBe(3);
    apply(root, table, { 0: { transmission: 1, color: '#112233' } }, { themeColor: THEME, picture: () => null });
    expect(first.material).toBeInstanceOf(MeshPhysicalMaterial);
    expect(second.material).toBeInstanceOf(MeshPhysicalMaterial);
    expect(second.material).toMatchObject({ vertexColors: true });
    expect(cloud.material).toBeInstanceOf(PointsMaterial);
    expect(`#${(cloud.material as PointsMaterial).color.getHexString()}`).toBe('#112233');
    apply(root, table, {}, { themeColor: THEME, picture: () => null });
    expect(first.material).toBeInstanceOf(MeshStandardMaterial);
    expect(first.material).not.toBeInstanceOf(MeshPhysicalMaterial);
    expect(second.material).toMatchObject({ vertexColors: true, flatShading: true });
  });

  it('keeps a part\'s picture clone across applies and only retiles it, so a slider tick uploads nothing', () => {
    const { root, meshes } = model();
    const apply = exported<Apply>('applyLook');
    const table = exported<Build>('buildPartTable')(root, partOf, { builtin: false });
    const picture = new Texture();
    const options = { themeColor: THEME, picture: () => picture };
    apply(root, table, { 0: { map: IMAGE, roughness: 0.2 } }, options);
    const shown = materialOf(meshes[0]!).map!;
    const dispose = vi.spyOn(shown, 'dispose');
    const version = shown.version;
    apply(root, table, { 0: { map: IMAGE, roughness: 0.4, mapRepeat: [2, 3] } }, options);
    expect(materialOf(meshes[0]!).map).toBe(shown);
    expect(shown.repeat.toArray()).toEqual([2, 3]);
    expect(shown.version).toBe(version);
    expect(dispose).not.toHaveBeenCalled();
    apply(root, table, { 0: { map: IMAGE, roughness: 0.4 } }, options);
    expect(shown.repeat.toArray()).toEqual([1, 1]);
    apply(root, table, { 0: { map: 'none' } }, options);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('applyLook on a material several meshes share', () => {
  it('moves every mesh to one new material and one picture clone when the class changes', () => {
    const root = new Group();
    const shared = new MeshStandardMaterial({ color: '#ffffff' });
    shared.userData.lookPart = '0';
    const meshes = [0, 1, 2].map(() => new Mesh(new BoxGeometry(), shared));
    root.add(...meshes);
    const apply = exported<Apply>('applyLook');
    const table = exported<Build>('buildPartTable')(root, partOf, { builtin: false });
    const picture = new Texture();
    const clone = vi.spyOn(picture, 'clone');
    apply(root, table, { 0: { map: IMAGE } }, { themeColor: THEME, picture: () => picture });
    expect(new Set(meshes.map((mesh) => mesh.material)).size).toBe(1);
    expect(clone).toHaveBeenCalledTimes(1);
    apply(root, table, { 0: { map: IMAGE, transmission: 1 } }, { themeColor: THEME, picture: () => picture });
    const after = new Set(meshes.map((mesh) => mesh.material));
    expect(after.size).toBe(1);
    expect([...after][0]).toBeInstanceOf(MeshPhysicalMaterial);
    expect(clone).toHaveBeenCalledTimes(1);
  });
});

describe('buildPartTable picture transform', () => {
  it('records the own picture\'s tiling, offset and rotation in degrees as the default the panel shows', () => {
    const root = new Group();
    const map = new Texture();
    map.repeat.set(3, 4); map.offset.set(0.1, 0.2); map.rotation = Math.PI / 2;
    const material = new MeshStandardMaterial({ map });
    material.userData.lookPart = '0';
    root.add(new Mesh(new BoxGeometry(), material));
    const entry = exported<Build>('buildPartTable')(root, partOf, { builtin: false }).get('0') as unknown as Record<string, unknown>;
    expect(entry.mapRepeat).toEqual([3, 4]);
    expect(entry.mapOffset).toEqual([0.1, 0.2]);
    expect(entry.mapRotation).toBeCloseTo(90);
  });

  it('keeps a small thumbnail of the own picture, for the part row and the picture field', () => {
    const draw = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,own');
    const image = document.createElement('canvas');
    image.width = 512; image.height = 256;
    const root = new Group();
    const textured = new MeshStandardMaterial({ map: new Texture(image) });
    textured.userData.lookPart = '0';
    const plain = new MeshStandardMaterial();
    plain.userData.lookPart = '1';
    root.add(new Mesh(new BoxGeometry(), textured), new Mesh(new BoxGeometry(), plain));
    const table = exported<Build>('buildPartTable')(root, partOf, { builtin: false });
    expect((table.get('0') as unknown as { thumbnail?: string }).thumbnail).toBe('data:image/png;base64,own');
    expect(draw).toHaveBeenCalledWith(image, 0, 0, 64, 32);
    expect((table.get('1') as unknown as { thumbnail?: string }).thumbnail).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('brings a model rotation past 180 degrees, an offset past 100 and a tiling past the bounds into the ranges a part takes', () => {
    const root = new Group();
    const map = new Texture();
    map.offset.set(120.25, -0.5); map.rotation = Math.PI * 1.5; map.repeat.set(50000, -0.00001);
    const material = new MeshStandardMaterial({ map });
    material.userData.lookPart = '0';
    root.add(new Mesh(new BoxGeometry(), material));
    const entry = exported<Build>('buildPartTable')(root, partOf, { builtin: false }).get('0') as unknown as Record<string, number[] | number>;
    expect(entry.mapOffset).toEqual([0.25, -0.5]);
    expect(entry.mapRotation).toBeCloseTo(-90);
    expect(entry.mapRepeat).toEqual([10000, -0.0001]);
  });
});
