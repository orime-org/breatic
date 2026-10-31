// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Unzip, UnzipInflate, strToU8, zipSync } from 'three/addons/libs/fflate.module.js';
import { z } from 'zod';
import type { SceneImportLimits } from '@breatic/shared';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';

/** Model bytes and their closed, normalized resource collection. */
export interface ModelPackage {
  entry: string;
  files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
  json: GltfDocument;
}

const gltfSchema = z.object({
  asset: z.object({ version: z.literal('2.0') }).passthrough(),
  buffers: z.array(z.object({ uri: z.string().optional(), byteLength: z.number().optional() }).passthrough()).optional(),
  bufferViews: z.array(z.object({ buffer: z.number(), byteOffset: z.number().optional(), byteLength: z.number() }).passthrough()).optional(),
  images: z.array(z.object({ uri: z.string().optional(), bufferView: z.number().optional() }).passthrough()).optional(),
  extensionsRequired: z.array(z.string()).optional(),
  extensionsUsed: z.array(z.string()).optional(),
}).passthrough();
export type GltfDocument = z.infer<typeof gltfSchema>;

const manifestSchema = z.object({ formatVersion: z.literal(1), entryPath: z.string() }).strict();

/**
 * Normalize a file path independently of URL percent encoding.
 * @param path - A path from a selected file, ZIP entry or model manifest.
 * @returns A relative path inside the selected collection.
 * @throws {Error} When a path is absolute or escapes the collection.
 */
export function normalizeModelPath(path: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('/') || path.startsWith('\\') || path.includes('\0')) {
    throw new ModelImportError('invalid', `Invalid model resource path: ${path}`);
  }
  const parts: string[] = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new ModelImportError('invalid', `Model resource path escapes its collection: ${path}`);
      parts.pop();
    } else parts.push(part);
  }
  if (!parts.length) throw new ModelImportError('invalid', 'Model resource path is empty');
  return parts.join('/');
}

/**
 * Resolve a glTF URI against its original entry directory.
 * @param entry - Normalized model entry path.
 * @param uri - A relative resource URI from the model.
 * @returns The normalized path of the selected resource.
 * @throws {Error} When the URI is external, malformed or outside the collection.
 */
export function resolveModelDependency(entry: string, uri: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(uri) || uri.startsWith('/') || uri.startsWith('\\')) {
    throw new ModelImportError('invalid', `Model resource must be provided locally: ${uri}`);
  }
  const directory = entry.slice(0, entry.lastIndexOf('/') + 1);
  return normalizeModelPath(directory + decodeURIComponent(uri));
}

/**
 * Read the entry JSON while retaining the original container bytes.
 * @param bytes - Original GLB or glTF bytes.
 * @param entry - Entry path used to identify the format.
 * @param limits - Configured metadata budget.
 * @returns The validated glTF envelope and resource declarations.
 * @throws {Error} When the container, version or metadata is invalid.
 */
export function readModelJson(bytes: Uint8Array, entry: string, limits: SceneImportLimits): GltfDocument {
  let json = bytes;
  if (entry.toLowerCase().endsWith('.glb')) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) throw new ModelImportError('invalid', 'Scene asset is not a binary glTF model');
    if (view.getUint32(4, true) !== 2) throw new ModelImportError('invalid', 'Unsupported binary glTF version');
    const length = view.getUint32(12, true);
    if (view.getUint32(8, true) !== bytes.byteLength || view.getUint32(16, true) !== 0x4e4f534a || length % 4 !== 0 || length > bytes.byteLength - 20) {
      throw new ModelImportError('invalid', 'Invalid binary glTF JSON chunk');
    }
    json = bytes.subarray(20, 20 + length);
  } else if (!entry.toLowerCase().endsWith('.gltf')) throw new ModelImportError('invalid', 'Unsupported model entry format');
  if (json.byteLength > limits.maxEntryJsonBytes) throw new ModelImportError('budget', 'Model entry JSON exceeds its configured budget');
  return gltfSchema.parse(JSON.parse(new TextDecoder().decode(json)) as unknown);
}

/**
 * Check every declared buffer and image against the same closed collection.
 * @param files - Original selected resources indexed by normalized path.
 * @param entry - Selected model entry.
 * @param limits - Configured model budgets.
 * @returns A model package ready for the installed loader.
 * @throws {Error} When the entry or one of its dependencies is missing.
 */
export function inspectModelFiles(files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>, entry: string, limits: SceneImportLimits): ModelPackage {
  const bytes = files.get(entry);
  if (!bytes) throw new ModelImportError('invalid', `Missing model entry: ${entry}`);
  const json = readModelJson(bytes, entry, limits);
  const missing = [...json.buffers ?? [], ...json.images ?? []].flatMap((resource) => {
    if (resource.uri === undefined || resource.uri.startsWith('data:')) return [];
    const path = resolveModelDependency(entry, resource.uri);
    return files.has(path) ? [] : [path];
  });
  if (missing.length) throw new ModelImportError('missing', `Missing model resources: ${[...new Set(missing)].join(', ')}`,
    { entries: [], paths: [...files.keys()], missing: [...new Set(missing)] });
  return { entry, files, json };
}

/**
 * Expand bounded ZIP entries with a streaming decoder.
 * @param bytes - The complete bounded archive input.
 * @param limits - Configured file count and actual expanded-byte budgets.
 * @param registered - Whether the root manifest occupies its reserved metadata slot.
 * @returns The original resources under normalized paths.
 * @throws {Error} When archive paths, counts, decoding or actual output exceed the contract.
 */
export function unpackModelArchive(bytes: Uint8Array, limits: SceneImportLimits, registered = false): Map<string, Uint8Array<ArrayBuffer>> {
  if (bytes.byteLength > (registered ? limits.maxArtifactBytes : limits.maxInputBytes)) throw new ModelImportError('budget', 'Model archive exceeds its input-byte budget');
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  let expanded = 0;
  let count = 0;
  const archive = new Unzip((file) => {
    if (file.name.endsWith('/')) return;
    const path = normalizeModelPath(file.name);
    if (files.has(path)) throw new ModelImportError('duplicate', `Duplicate model resource path: ${path}`);
    if (!(registered && path === 'manifest.json')) count += 1;
    if (count > limits.maxFiles) throw new ModelImportError('budget', 'Model archive exceeds its configured file count');
    if (file.originalSize !== undefined && file.originalSize > limits.maxExpandedBytes) throw new ModelImportError('budget', 'Model archive exceeds its expanded-byte budget');
    const chunks: Uint8Array[] = [];
    let size = 0;
    files.set(path, new Uint8Array());
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      size += chunk.byteLength;
      expanded += chunk.byteLength;
      if (expanded > limits.maxExpandedBytes) throw new ModelImportError('budget', 'Model archive exceeds its expanded-byte budget');
      chunks.push(chunk);
      if (final) {
        const output = new Uint8Array(size);
        let offset = 0;
        for (const part of chunks) { output.set(part, offset); offset += part.byteLength; }
        files.set(path, output);
      }
    };
    file.start();
  });
  archive.register(UnzipInflate);
  // UnzipInflate is synchronous; its final push validates unfinished entries.
  // Small compressed input slices bound each decoder callback's allocation.
  for (let offset = 0; offset < bytes.byteLength; offset += 4096) {
    archive.push(bytes.subarray(offset, offset + 4096), offset + 4096 >= bytes.byteLength);
  }
  return files;
}

/**
 * Read the versioned manifest of a registered model container.
 * @param bytes - Stored model package bytes.
 * @param limits - The configured import budgets.
 * @returns The selected entry and its closed resource collection.
 * @throws {Error} When the manifest version, entry or resource collection is invalid.
 */
export function readRegisteredModelPackage(bytes: Uint8Array, limits: SceneImportLimits): ModelPackage {
  const files = unpackModelArchive(bytes, limits, true);
  const manifest = files.get('manifest.json');
  if (!manifest || manifest.byteLength > limits.maxEntryJsonBytes) throw new ModelImportError('invalid', 'Missing or oversized model manifest');
  const result = manifestSchema.safeParse(JSON.parse(new TextDecoder().decode(manifest)) as unknown);
  if (!result.success) throw new ModelImportError('invalid', 'Unsupported or invalid model manifest version');
  const entry = normalizeModelPath(result.data.entryPath);
  if (!entry.startsWith('files/') || entry !== result.data.entryPath) throw new ModelImportError('invalid', 'Invalid model manifest entry path');
  for (const path of files.keys()) {
    if (path !== 'manifest.json' && !path.startsWith('files/')) throw new ModelImportError('invalid', `Invalid model package resource path: ${path}`);
  }
  files.delete('manifest.json');
  return inspectModelFiles(files, entry, limits);
}

/**
 * Preserve selected source bytes in a deterministic model asset.
 * @param files - Original resources under their relative paths.
 * @param entry - The user's chosen model entry.
 * @param limits - Configured output budgets.
 * @returns An original self-contained GLB or the versioned ZIP bytes.
 * @throws {Error} When dependencies or output budgets are invalid.
 */
export function packModelFiles(files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>, entry: string, limits: SceneImportLimits): Uint8Array<ArrayBuffer> {
  const model = inspectModelFiles(files, entry, limits);
  if (files.size > limits.maxFiles) throw new ModelImportError('budget', 'Model exceeds its configured file count');
  const total = [...files.values()].reduce((sum, value) => sum + value.byteLength, 0);
  if (total > limits.maxExpandedBytes) throw new ModelImportError('budget', 'Model exceeds its expanded-byte budget');
  const external = [...model.json.buffers ?? [], ...model.json.images ?? []].some((resource) => resource.uri !== undefined && !resource.uri.startsWith('data:'));
  if (files.size === 1 && entry.toLowerCase().endsWith('.glb') && !external) {
    const bytes = files.get(entry)!;
    if (bytes.byteLength > limits.maxArtifactBytes) throw new ModelImportError('budget', 'Model asset exceeds its configured budget');
    return bytes;
  }
  const manifest = Uint8Array.from(strToU8(JSON.stringify({ formatVersion: 1, entryPath: `files/${entry}` })));
  if (total + manifest.byteLength > limits.maxExpandedBytes) throw new ModelImportError('budget', 'Model exceeds its expanded-byte budget');
  const entries: Record<string, Uint8Array> = { 'manifest.json': manifest };
  for (const path of [...files.keys()].sort()) {
    if (normalizeModelPath(path) !== path) throw new ModelImportError('invalid', `Invalid model resource path: ${path}`);
    entries[`files/${path}`] = files.get(path)!;
  }
  const bytes = Uint8Array.from(zipSync(entries, { level: 0, mtime: new Date(1980, 0, 1) }));
  if (bytes.byteLength > limits.maxArtifactBytes) throw new ModelImportError('budget', 'Model asset exceeds its configured budget');
  return bytes;
}
