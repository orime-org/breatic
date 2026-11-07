// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'three/addons/libs/fflate.module.js';

export interface SceneModelInput {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

const POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const UVS = new Float32Array([0, 0, 1, 0, 0, 1]);
const GEOMETRY_VIEWS = [{ buffer: 0, byteOffset: 0, byteLength: POSITIONS.byteLength },
  { buffer: 0, byteOffset: POSITIONS.byteLength, byteLength: UVS.byteLength }];

/**
 * Build an independently described glTF triangle with a real fixture texture.
 * @param token - Per-case source identity for an authoritative first upload.
 * @returns Source geometry, texture and the original glTF document.
 * @throws {Error} When the existing image fixture cannot be read.
 */
function sourceModel(token: string): { json: Record<string, unknown>; geometry: Uint8Array<ArrayBuffer>; image: Uint8Array<ArrayBuffer> } {
  const geometry = new Uint8Array(POSITIONS.byteLength + UVS.byteLength);
  geometry.set(new Uint8Array(POSITIONS.buffer));
  geometry.set(new Uint8Array(UVS.buffer), POSITIONS.byteLength);
  const image = Uint8Array.from(readFileSync('tests/fixtures/portrait.png'));
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Original surface', mesh: 0 }],
    buffers: [{ byteLength: geometry.byteLength, uri: 'mesh.bin' }],
    bufferViews: GEOMETRY_VIEWS,
    accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3, min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, type: 'VEC2', count: 3 }],
    images: [{ uri: 'color.png', mimeType: 'image/png' }], textures: [{ source: 0 }],
    materials: [{ name: 'Original material', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.7 } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }], extras: { sourceIdentity: token },
  };
  return { json, geometry, image };
}

/**
 * Produce a real textured GLB with original geometry and an embedded PNG.
 * @param token - Per-case source identity retained inside the model.
 * @returns A browser file payload for the actual import input.
 * @throws {Error} When the image fixture cannot be read.
 */
export function sceneGlb(token: string): SceneModelInput {
  const { json, geometry, image } = sourceModel(token);
  const binary = new Uint8Array(Math.ceil((geometry.byteLength + image.byteLength) / 4) * 4);
  binary.set(geometry);
  binary.set(image, geometry.byteLength);
  json.buffers = [{ byteLength: binary.byteLength }];
  json.images = [{ bufferView: 2, mimeType: 'image/png' }];
  json.bufferViews = [...GEOMETRY_VIEWS, { buffer: 0, byteOffset: geometry.byteLength, byteLength: image.byteLength }];
  const metadata = strToU8(JSON.stringify(json));
  const length = Math.ceil(metadata.byteLength / 4) * 4;
  const bytes = new Uint8Array(28 + length + binary.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20, 20 + length);
  bytes.set(metadata, 20);
  view.setUint32(20 + length, binary.byteLength, true);
  view.setUint32(24 + length, 0x004e4942, true);
  bytes.set(binary, 28 + length);
  return { name: 'character.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(bytes) };
}

/**
 * Retain a folder-shaped original glTF collection in an ordinary user ZIP.
 * @param token - Per-case source identity retained in each original entry.
 * @param multiple - Includes a second selectable model sharing the original resources.
 * @returns An ordinary archive with no application model-package manifest.
 * @throws {Error} When the fixture cannot be read or the archive cannot be written.
 */
export function sceneZip(token: string, multiple = false): SceneModelInput {
  const { json, geometry, image } = sourceModel(token);
  const files: Record<string, Uint8Array> = { 'models/scene.gltf': strToU8(JSON.stringify(json)),
    'models/mesh.bin': geometry, 'models/color.png': image };
  if (multiple) files['models/second.gltf'] = strToU8(JSON.stringify({ ...json,
    nodes: [{ name: 'Second original surface', mesh: 0, scale: [2, 1, 1] }],
    extras: { sourceIdentity: `${token}:second` } }));
  return { name: 'character.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync(files, { level: 0 })) };
}

/**
 * Keep a model and its dependencies as separate ordinary browser files.
 * @param token - Original model identity shared by this collection.
 * @returns The glTF entry followed by its buffer and PNG resource.
 * @throws {Error} When the existing image fixture cannot be read.
 */
export function sceneFiles(token: string): SceneModelInput[] {
  const { json, geometry, image } = sourceModel(token);
  return [
    { name: 'scene.gltf', mimeType: 'model/gltf+json', buffer: Buffer.from(JSON.stringify(json)) },
    { name: 'mesh.bin', mimeType: 'application/octet-stream', buffer: Buffer.from(geometry) },
    { name: 'color.png', mimeType: 'image/png', buffer: Buffer.from(image) },
  ];
}

/**
 * Expose an original entry whose local geometry and texture must be supplied.
 * @returns A deliberately incomplete user file for the actual missing-resource flow.
 * @throws {Error} When the fixture texture cannot be read.
 */
export function incompleteScene(): SceneModelInput {
  const { json } = sourceModel('missing-resources');
  return { name: 'scene.gltf', mimeType: 'model/gltf+json', buffer: Buffer.from(JSON.stringify(json)) };
}

/**
 * Expose a ZIP whose entry sits in a folder and lacks its local geometry and texture.
 * @returns An ordinary archive holding only `models/scene.gltf`.
 * @throws {Error} When the archive cannot be written.
 */
export function incompleteSceneZip(): SceneModelInput {
  const { json } = sourceModel('missing-zip-resources');
  return { name: 'character.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync({ 'models/scene.gltf': strToU8(JSON.stringify(json)) }, { level: 0 })) };
}
