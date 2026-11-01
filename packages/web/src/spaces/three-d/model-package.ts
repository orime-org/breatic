// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { strToU8, unzipSync, zipSync } from 'three/addons/libs/fflate.module.js';
import { z } from 'zod';
import type { SceneImportLimits } from '@breatic/shared';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';
import { loadedResources } from '@web/spaces/three-d/model-loaded-resources';

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
    throw new ModelImportError('invalid', `Invalid model resource path: ${path}`, { detail: path });
  }
  const parts: string[] = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new ModelImportError('invalid', `Model resource path escapes its collection: ${path}`, { detail: path });
      parts.pop();
    } else parts.push(part);
  }
  if (!parts.length) throw new ModelImportError('invalid', 'Model resource path is empty', { detail: path });
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
    throw new ModelImportError('invalid', `Model resource must be provided locally: ${uri}`, { detail: uri });
  }
  const directory = entry.slice(0, entry.lastIndexOf('/') + 1);
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    throw new ModelImportError('invalid', `Malformed model resource URI: ${uri}`, { detail: uri });
  }
  return normalizeModelPath(directory + decoded);
}

/**
 * Read the entry JSON while retaining the original container bytes.
 * @param bytes - Original GLB or glTF bytes.
 * @param entry - Entry path used to identify the format.
 * @param limits - Configured metadata budget.
 * @returns The validated glTF envelope and resource declarations.
 * @throws {ModelImportError} When the container or metadata is invalid, or the glTF version is not 2.0.
 */
export function readModelJson(bytes: Uint8Array, entry: string, limits: SceneImportLimits): GltfDocument {
  let json = bytes;
  if (entry.toLowerCase().endsWith('.glb')) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) throw new ModelImportError('invalid', 'Scene asset is not a binary glTF model', { detail: entry });
    const version = view.getUint32(4, true);
    if (version !== 2) throw new ModelImportError('unsupported', 'Unsupported binary glTF version', { detail: `glTF ${version}` });
    const length = view.getUint32(12, true);
    if (view.getUint32(8, true) !== bytes.byteLength || view.getUint32(16, true) !== 0x4e4f534a || length % 4 !== 0 || length > bytes.byteLength - 20) {
      throw new ModelImportError('invalid', 'Invalid binary glTF JSON chunk', { detail: entry });
    }
    json = bytes.subarray(20, 20 + length);
  } else if (!entry.toLowerCase().endsWith('.gltf')) throw new ModelImportError('invalid', 'Unsupported model entry format', { detail: entry });
  if (json.byteLength > limits.maxEntryJsonBytes) {
    throw new ModelImportError('budget', 'Model entry JSON exceeds its configured budget', { detail: entry,
      budget: { limit: 'entryJson', allowed: limits.maxEntryJsonBytes, actual: json.byteLength } });
  }
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder().decode(json)) as unknown;
  } catch {
    throw new ModelImportError('invalid', 'Model entry JSON cannot be parsed', { detail: entry });
  }
  const version = z.object({ asset: z.object({ version: z.unknown() }) }).safeParse(document);
  if (version.success && version.data.asset.version !== '2.0') {
    throw new ModelImportError('unsupported', 'Unsupported glTF version', { detail: `glTF ${String(version.data.asset.version)}` });
  }
  const result = gltfSchema.safeParse(document);
  if (!result.success) throw new ModelImportError('invalid', 'Model entry is not a valid glTF document', { detail: entry });
  return result.data;
}

/**
 * Check the textures, buffers and images GLTFLoader loads against the same closed collection: each texture names an image, each file is present and as long as declared.
 * @param files - Original selected resources indexed by normalized path.
 * @param entry - Selected model entry.
 * @param limits - Configured model budgets.
 * @returns A model package ready for the installed loader.
 * @throws {ModelImportError} When the entry or a loaded dependency is missing, unreadable or shorter than declared.
 */
export function inspectModelFiles(files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>, entry: string, limits: SceneImportLimits): ModelPackage {
  const bytes = files.get(entry);
  if (!bytes) throw new ModelImportError('invalid', `Missing model entry: ${entry}`, { detail: entry });
  const json = readModelJson(bytes, entry, limits);
  // Every declared URI must stay inside the selection; presence and length matter only for what the loader reads.
  for (const resource of [...json.buffers ?? [], ...json.images ?? []]) {
    if (resource.uri !== undefined && !resource.uri.startsWith('data:')) resolveModelDependency(entry, resource.uri);
  }
  const loaded = loadedResources(json);
  // GLTFLoader reads a used texture's image without checking it exists.
  const imageless = loaded.textures.find((texture) => texture.image === undefined);
  if (imageless) throw new ModelImportError('invalid', 'Model texture names no image', { detail: `textures[${imageless.texture}]` });
  const resources = [...[...loaded.buffers].map((buffer) => json.buffers?.[buffer]), ...[...loaded.images].map((image) => json.images?.[image])];
  const missing = resources.flatMap((resource) => {
    if (resource?.uri === undefined || resource.uri.startsWith('data:')) return [];
    const path = resolveModelDependency(entry, resource.uri);
    return files.has(path) ? [] : [path];
  });
  if (missing.length) throw new ModelImportError('missing', `Missing model resources: ${[...new Set(missing)].join(', ')}`,
    { detail: '', info: { entries: [], paths: [...files.keys()], missing: [...new Set(missing)] } });
  const decoded = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const index of loaded.buffers) {
    const buffer = json.buffers?.[index];
    if (!buffer) continue;
    const location = buffer.uri === undefined ? index === 0 ? entry : `buffers[${index}]`
      : buffer.uri.startsWith('data:') ? `buffers[${index}]` : resolveModelDependency(entry, buffer.uri);
    // GLTFLoader reads only the first buffer from the GLB body; any other buffer needs a URI.
    if (buffer.uri === undefined && index !== 0) throw new ModelImportError('invalid', 'Only the first model buffer can be embedded', { detail: location });
    if (buffer.byteLength !== undefined && readModelResource({ entry, files }, buffer.uri, location, decoded).byteLength < buffer.byteLength) {
      throw new ModelImportError('invalid', 'Model buffer is shorter than its declared length', { detail: location });
    }
  }
  return { entry, files, json };
}

/**
 * Read the bytes GLTFLoader reads for a buffer or image URI: an embedded data URI, a file in the closed collection, or, for no URI, the GLB binary chunk.
 * @param model - The model entry and its original files.
 * @param uri - The resource URI, absent for the GLB binary chunk.
 * @param location - The resource's location named in failures.
 * @param decoded - Data URIs decoded so far by this check; resources sharing one decode it once.
 * @returns A view of the resource bytes, empty when an external file is absent.
 * @throws {ModelImportError} When an embedded resource or the GLB container cannot be read.
 */
export function readModelResource(model: Pick<ModelPackage, 'entry' | 'files'>, uri: string | undefined, location: string,
  decoded: Map<string, Uint8Array<ArrayBuffer>>): Uint8Array<ArrayBuffer> {
  if (uri === undefined) return readBinaryChunk(model, location);
  if (!uri.startsWith('data:')) return model.files.get(resolveModelDependency(model.entry, uri)) ?? new Uint8Array();
  const cached = decoded.get(uri);
  if (cached) return cached;
  const comma = uri.indexOf(',');
  if (comma < 0) throw new ModelImportError('invalid', 'Invalid embedded model resource', { detail: location });
  const encoded = uri.slice(comma + 1).replace(/%([a-f\d]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  let binary: string;
  try {
    binary = /;base64$/i.test(uri.slice(0, comma)) ? atob(encoded) : encoded;
  } catch {
    throw new ModelImportError('invalid', 'Invalid embedded model resource', { detail: location });
  }
  const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
  decoded.set(uri, bytes);
  return bytes;
}

/**
 * Locate the GLB BIN chunk without copying it.
 * @param model - The model entry and its original files.
 * @param location - The location named in failures.
 * @returns A byte view of the embedded buffer.
 * @throws {ModelImportError} When the entry is no GLB or its chunks are invalid.
 */
function readBinaryChunk(model: Pick<ModelPackage, 'entry' | 'files'>, location: string): Uint8Array<ArrayBuffer> {
  const bytes = model.files.get(model.entry);
  if (!bytes || !model.entry.toLowerCase().endsWith('.glb')) throw new ModelImportError('invalid', 'Model has no embedded binary buffer', { detail: location });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 12; offset < bytes.byteLength;) {
    if (bytes.byteLength - offset < 8) throw new ModelImportError('invalid', 'Truncated binary model chunk', { detail: location });
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    offset += 8;
    if (length % 4 !== 0 || length > bytes.byteLength - offset) throw new ModelImportError('invalid', 'Invalid binary model chunk length', { detail: location });
    if (type === 0x004e4942) return bytes.subarray(offset, offset + length);
    offset += length;
  }
  throw new ModelImportError('invalid', 'Model has no embedded binary buffer', { detail: location });
}

/**
 * Recognize files an archiver or the macOS Finder adds beside the user's own files.
 * @param path - A normalized resource path.
 * @returns Whether the path is AppleDouble or Finder metadata.
 * @throws {never} Never.
 */
export function isArchiverMetadata(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return path.startsWith('__MACOSX/') || name.startsWith('._') || name === '.DS_Store';
}

/**
 * Read a ZIP entry name as UTF-8 when the archiver wrote UTF-8 bytes without setting the UTF-8 flag.
 * fflate reads such names as Latin-1; macOS Finder writes them this way, so non-ASCII names would no longer match their glTF URIs.
 * @param name - The entry name as fflate decoded it.
 * @returns The UTF-8 reading when those bytes are valid UTF-8, otherwise the name unchanged.
 * @throws {never} Never.
 */
function utf8EntryName(name: string): string {
  const codes = Array.from(name, (character) => character.charCodeAt(0));
  if (!codes.some((code) => code >= 0x80) || codes.some((code) => code > 0xff)) return name;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(codes));
  } catch {
    return name;
  }
}

/**
 * Tell whether an archive's end record defers to a zip64 directory, which packages we write never do.
 * @param bytes - The complete archive.
 * @returns Whether the end-of-central-directory record carries a zip64 marker.
 * @throws {never} Never.
 */
function usesZip64(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let end = bytes.byteLength - 22; end >= Math.max(0, bytes.byteLength - 65557); end -= 1) {
    if (view.getUint32(end, true) !== 0x06054b50) continue;
    return view.getUint16(end + 10, true) === 0xffff || view.getUint32(end + 16, true) === 0xffffffff;
  }
  return false;
}

/**
 * Visit every central-directory record without inflating anything, naming a damaged directory as an unreadable archive.
 * @param bytes - The complete archive.
 * @param visit - Receives each record; it may throw to refuse the archive.
 * @param location - The archive's own path, named when its directory is damaged.
 * @throws {ModelImportError} When the directory cannot be read or a record is refused.
 */
function readDirectory(bytes: Uint8Array, visit: (file: { name: string; originalSize: number; compression: number }) => void, location: string): void {
  try {
    unzipSync(bytes, { filter: (file) => { visit(file); return false; } });
  } catch (error) {
    if (error instanceof ModelImportError) throw error;
    throw new ModelImportError('invalid', error instanceof Error ? error.message : String(error), { detail: location });
  }
}

/**
 * Expand bounded ZIP entries by the sizes their central directory declares.
 * Entries written with data descriptors have no reliable end in the local stream, so offsets come from the directory.
 * The directory is read once to check names, methods and totals, and once more to inflate the accepted entries.
 * @param bytes - The complete bounded archive input.
 * @param limits - Configured file count and declared expanded-byte budgets.
 * @param registered - Whether this is a package we wrote, whose root manifest occupies its reserved metadata slot.
 * @param location - The archive's path in the user's selection, named when the archive itself is damaged.
 * @returns The original resources under normalized paths.
 * @throws {ModelImportError} When archive paths, methods, counts, decoding or output sizes break the contract.
 */
export function unpackModelArchive(bytes: Uint8Array, limits: SceneImportLimits, registered = false, location = ''): Map<string, Uint8Array<ArrayBuffer>> {
  const allowedBytes = registered ? limits.maxArtifactBytes : limits.maxInputBytes;
  if (bytes.byteLength > allowedBytes) {
    throw new ModelImportError('budget', 'Model archive exceeds its input-byte budget', { detail: '',
      budget: { limit: registered ? 'artifact' : 'input', allowed: allowedBytes, actual: bytes.byteLength } });
  }
  if (registered && usesZip64(bytes)) throw new ModelImportError('invalid', 'Registered model package uses a zip64 directory', { detail: '' });
  const declared = new Map<string, { path: string; size: number }>();
  const paths = new Set<string>();
  let expanded = 0;
  readDirectory(bytes, (file) => {
    if (file.name.endsWith('/')) return false;
    const path = normalizeModelPath(registered ? file.name : utf8EntryName(file.name));
    if (!registered && isArchiverMetadata(path)) return false;
    if (paths.has(path)) throw new ModelImportError('duplicate', `Duplicate model resource path: ${path}`, { detail: path });
    if (file.compression !== 0 && file.compression !== 8) throw new ModelImportError('unsupported', `Unsupported ZIP compression method ${file.compression}`, { detail: path });
    paths.add(path);
    expanded += file.originalSize;
    declared.set(file.name, { path, size: file.originalSize });
  }, location);
  const count = paths.size - (registered && paths.has('manifest.json') ? 1 : 0);
  if (count > limits.maxFiles) {
    throw new ModelImportError('budget', 'Model archive exceeds its configured file count', { detail: '', budget: { limit: 'files', allowed: limits.maxFiles, actual: count } });
  }
  if (expanded > limits.maxExpandedBytes) {
    throw new ModelImportError('budget', 'Model archive exceeds its expanded-byte budget', { detail: '',
      budget: { limit: 'expanded', allowed: limits.maxExpandedBytes, actual: expanded } });
  }
  // fflate inflates each accepted entry right after the filter accepts it, so the last accepted name is the one that failed.
  let current = '';
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, { filter: (file) => { current = declared.get(file.name)?.path ?? ''; return declared.has(file.name); } });
  } catch (error) {
    throw new ModelImportError('invalid', error instanceof Error ? error.message : String(error), { detail: current || location });
  }
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const [name, { path, size }] of declared) {
    const output = entries[name] as Uint8Array<ArrayBuffer> | undefined;
    if (!output || output.byteLength !== size) throw new ModelImportError('invalid', `Model archive entry has an inconsistent size: ${path}`, { detail: path });
    files.set(path, output);
  }
  return files;
}

/**
 * Read the versioned manifest of a registered model container.
 * @param bytes - Stored model package bytes.
 * @param limits - The configured import budgets.
 * @returns The selected entry and its closed resource collection.
 * @throws {ModelImportError} When the manifest, its version, entry or resource collection is invalid.
 */
export function readRegisteredModelPackage(bytes: Uint8Array, limits: SceneImportLimits): ModelPackage {
  const files = unpackModelArchive(bytes, limits, true);
  const manifest = files.get('manifest.json');
  if (!manifest || manifest.byteLength > limits.maxEntryJsonBytes) throw new ModelImportError('invalid', 'Missing or oversized model manifest', { detail: 'manifest.json' });
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(new TextDecoder().decode(manifest));
  } catch {
    throw new ModelImportError('invalid', 'Model manifest is not JSON', { detail: 'manifest.json' });
  }
  const result = manifestSchema.safeParse(manifestJson);
  if (!result.success) throw new ModelImportError('invalid', 'Unsupported or invalid model manifest version', { detail: 'manifest.json' });
  const entry = normalizeModelPath(result.data.entryPath);
  if (!entry.startsWith('files/') || entry !== result.data.entryPath) throw new ModelImportError('invalid', 'Invalid model manifest entry path', { detail: result.data.entryPath });
  for (const path of files.keys()) {
    if (path !== 'manifest.json' && !path.startsWith('files/')) throw new ModelImportError('invalid', `Invalid model package resource path: ${path}`, { detail: path });
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
  if (files.size > limits.maxFiles) {
    throw new ModelImportError('budget', 'Model exceeds its configured file count', { detail: '', budget: { limit: 'files', allowed: limits.maxFiles, actual: files.size } });
  }
  const total = [...files.values()].reduce((sum, value) => sum + value.byteLength, 0);
  if (total > limits.maxExpandedBytes) {
    throw new ModelImportError('budget', 'Model exceeds its expanded-byte budget', { detail: '', budget: { limit: 'expanded', allowed: limits.maxExpandedBytes, actual: total } });
  }
  const external = [...model.json.buffers ?? [], ...model.json.images ?? []].some((resource) => resource.uri !== undefined && !resource.uri.startsWith('data:'));
  if (files.size === 1 && entry.toLowerCase().endsWith('.glb') && !external) {
    const bytes = files.get(entry)!;
    if (bytes.byteLength > limits.maxArtifactBytes) {
      throw new ModelImportError('budget', 'Model asset exceeds its configured budget', { detail: entry,
        budget: { limit: 'artifact', allowed: limits.maxArtifactBytes, actual: bytes.byteLength } });
    }
    return bytes;
  }
  const manifest = Uint8Array.from(strToU8(JSON.stringify({ formatVersion: 1, entryPath: `files/${entry}` })));
  if (total + manifest.byteLength > limits.maxExpandedBytes) {
    throw new ModelImportError('budget', 'Model exceeds its expanded-byte budget', { detail: '',
      budget: { limit: 'expanded', allowed: limits.maxExpandedBytes, actual: total + manifest.byteLength } });
  }
  const entries: Record<string, Uint8Array> = { 'manifest.json': manifest };
  for (const path of [...files.keys()].sort()) {
    if (normalizeModelPath(path) !== path) throw new ModelImportError('invalid', `Invalid model resource path: ${path}`, { detail: path });
    entries[`files/${path}`] = files.get(path)!;
  }
  // zipSync returns a fresh array over its own ArrayBuffer.
  const bytes = zipSync(entries, { level: 0, mtime: new Date(1980, 0, 1) }) as Uint8Array<ArrayBuffer>;
  if (bytes.byteLength > limits.maxArtifactBytes) {
    throw new ModelImportError('budget', 'Model asset exceeds its configured budget', { detail: '',
      budget: { limit: 'artifact', allowed: limits.maxArtifactBytes, actual: bytes.byteLength } });
  }
  return bytes;
}
