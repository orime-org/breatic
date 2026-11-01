// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'three/addons/libs/fflate.module.js';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';
import type { ModelImportErrorCode, ModelInspectionInfo } from '@web/spaces/three-d/model-import-errors';
import { inspectModelSelection } from '@web/spaces/three-d/model-selection';
import { sourcesFromFiles, supplementSources } from '@web/spaces/three-d/model-source';

const GEOMETRY = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
const ENTRY = 'hero/model.gltf';

/**
 * Supply the original JSON bytes for one valid triangle and its buffer URI.
 * @throws {never} Never.
 */
function modelJson(uri: string, name = 'Selected character'): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(strToU8(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name, mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: GEOMETRY.byteLength, uri }],
    bufferViews: [{ buffer: 0, byteLength: GEOMETRY.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3, min: [0, 0, 0], max: [1, 1, 0] }],
  }, null, 2) + '\n'));
}

/**
 * Encode an original GLB with an embedded data URI and a valid JSON chunk.
 * @throws {never} Never.
 */
function modelGlb(name = 'Selected character'): Uint8Array<ArrayBuffer> {
  const uri = `data:application/octet-stream;base64,${btoa(String.fromCharCode(...GEOMETRY))}`;
  const json = modelJson(uri, name);
  const padded = Math.ceil(json.byteLength / 4) * 4;
  const bytes = new Uint8Array(20 + padded);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, padded, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20);
  bytes.set(json, 20);
  return bytes;
}

/**
 * Retain browser file identity and folder paths with a real arrayBuffer reader.
 * @throws {never} Never directly.
 */
function inputFile(name: string, bytes: Uint8Array<ArrayBuffer>, relativePath = '', type = 'application/octet-stream'): File {
  const file = new File([bytes], name, { type });
  Object.defineProperties(file, {
    webkitRelativePath: { value: relativePath },
    arrayBuffer: { value: async () => bytes.slice().buffer, configurable: true },
  });
  return file;
}

/**
 * Build external ZIP input independently of the production selection code.
 * @throws {Error} When the ZIP fixture encoder rejects the input.
 */
function archive(entries: ReadonlyMap<string, Uint8Array<ArrayBuffer>>): Uint8Array<ArrayBuffer> {
  const files = Object.fromEntries([...entries].map(([path, bytes]) => [path, Uint8Array.from(bytes)]));
  return Uint8Array.from(zipSync(files, { level: 0 }));
}

/**
 * Assert the typed failure and its public inspection facts.
 * @throws {Error} When the operation or its error does not match the contract.
 */
async function expectFailure(operation: Promise<unknown>, code: ModelImportErrorCode, info?: ModelInspectionInfo): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(ModelImportError);
    expect(error).toMatchObject({ code, ...(info !== undefined && { info }) });
    return;
  }
  throw new Error(`Expected model selection to fail with ${code}`);
}

/**
 * Inspect browser picker files through the same path mapping the dialog uses.
 * @throws {ModelImportError} When the selection fails inspection.
 */
function inspect(files: readonly File[], entry: string | undefined, limits: typeof IMPORT_LIMITS): ReturnType<typeof inspectModelSelection> {
  return inspectModelSelection(sourcesFromFiles(files), entry, limits);
}

describe('model-selection supplements and archiver metadata (inner#1690)', () => {
  /**
   * Inspect a first selection, then add bare picker files the way the dialog supplements them.
   * @throws {Error} When the first selection does not report missing resources.
   */
  async function supplemented(first: readonly File[], entry: string, added: readonly File[]): ReturnType<typeof inspectModelSelection> {
    const sources = sourcesFromFiles(first);
    let missing: readonly string[] = [];
    try { await inspectModelSelection(sources, entry, IMPORT_LIMITS); } catch (error) {
      if (error instanceof ModelImportError) missing = error.info?.missing ?? [];
    }
    expect(missing.length).toBeGreaterThan(0);
    return inspectModelSelection([...sources, ...supplementSources(added, missing)], entry, IMPORT_LIMITS);
  }

  it('places a supplemented file at the missing path of a folder selection', async () => {
    const selected = await supplemented([inputFile('model.gltf', modelJson('mesh.bin'), ENTRY)], ENTRY, [inputFile('mesh.bin', GEOMETRY.slice())]);
    expect([...selected.paths].sort()).toEqual(['hero/mesh.bin', ENTRY]);
  });

  it('places a supplemented file at a missing path in a subdirectory of the entry', async () => {
    const selected = await supplemented([inputFile('model.gltf', modelJson('bin/mesh.bin'))], 'model.gltf', [inputFile('mesh.bin', GEOMETRY.slice())]);
    expect([...selected.paths].sort()).toEqual(['bin/mesh.bin', 'model.gltf']);
  });

  it('adds supplemented files to the expanded resources of a selected ZIP', async () => {
    const zipped = archive(new Map([[ENTRY, modelJson('mesh.bin')]]));
    const selected = await supplemented([inputFile('character.zip', zipped)], ENTRY, [inputFile('mesh.bin', GEOMETRY.slice())]);
    expect([...selected.paths].sort()).toEqual(['hero/mesh.bin', ENTRY]);
  });

  it('keeps a supplemented file under its own name when several missing paths share that name', () => {
    const file = inputFile('a.png', GEOMETRY.slice());
    expect(supplementSources([file], ['one/a.png', 'two/a.png'])).toEqual([{ path: 'a.png', file }]);
  });

  it('leaves Finder metadata out of a folder selection and its single entry', async () => {
    const selected = await inspect([
      inputFile('model.glb', modelGlb(), 'hero/model.glb'),
      inputFile('._model.glb', new Uint8Array([0, 5, 22, 7]), 'hero/._model.glb'),
      inputFile('.DS_Store', new Uint8Array([0, 0, 0, 1]), 'hero/.DS_Store'),
    ], undefined, IMPORT_LIMITS);
    expect([...selected.entries]).toEqual(['hero/model.glb']);
    expect([...selected.paths]).toEqual(['hero/model.glb']);
  });
});

describe('model-selection file and entry contract (inner#1690)', () => {
  it('reports an empty selection', async () => {
    await expectFailure(inspect([], undefined, IMPORT_LIMITS), 'empty');
  });

  it.each(['application/octet-stream', 'text/plain', 'application/zip'])('recognizes a valid single GLB regardless of File.type %s', async (type) => {
    const bytes = modelGlb();
    const selected = await inspect([inputFile('character.glb', bytes, '', type)], undefined, IMPORT_LIMITS);

    expect(selected.model.entry).toBe('character.glb');
    expect([...selected.entries]).toEqual(['character.glb']);
    expect([...selected.paths]).toEqual(['character.glb']);
    expect(Array.from(selected.model.files.get('character.glb')!)).toEqual(Array.from(bytes));
    expect(Array.from(selected.artifact)).toEqual(Array.from(bytes));
  });

  it('reports a collection that contains no supported model entry', async () => {
    await expectFailure(inspect([inputFile('notes.txt', new Uint8Array([65]))], undefined, IMPORT_LIMITS), 'unsupported', {
      entries: [], paths: ['notes.txt'], missing: [],
    });
  });

  it.each([new Error('File unavailable'), new DOMException('File unavailable', 'NotReadableError')])('reports an unreadable original file: %s', async (error) => {
    const file = inputFile('character.glb', modelGlb());
    vi.spyOn(file, 'arrayBuffer').mockRejectedValueOnce(error);
    await expectFailure(inspect([file], undefined, IMPORT_LIMITS), 'invalid');
  });

  it('returns every entry and source path when several GLBs need an explicit choice', async () => {
    const files = [inputFile('first.glb', modelGlb('First')), inputFile('second.glb', modelGlb('Second'))];
    await expectFailure(inspect(files, undefined, IMPORT_LIMITS), 'entry', {
      entries: ['first.glb', 'second.glb'], paths: ['first.glb', 'second.glb'], missing: [],
    });
  });

  it.each(['first.glb', 'second.glb'])('retains all selected models after explicitly choosing %s', async (entry) => {
    const first = modelGlb('First');
    const second = modelGlb('Second');
    const files = [inputFile('first.glb', first), inputFile('second.glb', second)];
    const selected = await inspect(files, entry, IMPORT_LIMITS);
    const artifact = unzipSync(selected.artifact);

    expect(selected.model.entry).toBe(entry);
    expect([...selected.entries].sort()).toEqual(['first.glb', 'second.glb']);
    expect([...selected.paths].sort()).toEqual(['first.glb', 'second.glb']);
    expect(JSON.parse(strFromU8(artifact['manifest.json']))).toEqual({ formatVersion: 1, entryPath: `files/${entry}` });
    expect(Array.from(artifact['files/first.glb'])).toEqual(Array.from(first));
    expect(Array.from(artifact['files/second.glb'])).toEqual(Array.from(second));
  });

  it('reports current entry choices when the requested entry is absent', async () => {
    const files = [inputFile('first.glb', modelGlb('First')), inputFile('second.glb', modelGlb('Second'))];
    await expectFailure(inspect(files, 'absent.glb', IMPORT_LIMITS), 'entry', {
      entries: ['first.glb', 'second.glb'], paths: ['first.glb', 'second.glb'], missing: [],
    });
  });

  it('uses webkitRelativePath to retain a folder model and its original buffer', async () => {
    const source = modelJson('mesh.bin');
    const selected = await inspect([
      inputFile('model.gltf', source, ENTRY, 'text/plain'),
      inputFile('mesh.bin', GEOMETRY, 'hero/mesh.bin'),
    ], undefined, IMPORT_LIMITS);
    const artifact = unzipSync(selected.artifact);

    expect(selected.model.entry).toBe(ENTRY);
    expect([...selected.entries]).toEqual([ENTRY]);
    expect([...selected.paths].sort()).toEqual(['hero/mesh.bin', ENTRY]);
    expect(Array.from(selected.model.files.get(ENTRY)!)).toEqual(Array.from(source));
    expect(Array.from(selected.model.files.get('hero/mesh.bin')!)).toEqual(Array.from(GEOMETRY));
    expect(JSON.parse(strFromU8(artifact['manifest.json']))).toEqual({ formatVersion: 1, entryPath: `files/${ENTRY}` });
  });

  it('reads a ZIP model collection and preserves its buffer and unrelated selected data', async () => {
    const source = modelJson('mesh.bin');
    const note = Uint8Array.from(strToU8('Original source note\n'));
    const zipped = archive(new Map([[ENTRY, source], ['hero/mesh.bin', GEOMETRY], ['notes.txt', note]]));
    const selected = await inspect([inputFile('character.zip', zipped)], undefined, IMPORT_LIMITS);
    const artifact = unzipSync(selected.artifact);

    expect(selected.model.entry).toBe(ENTRY);
    expect([...selected.entries]).toEqual([ENTRY]);
    expect([...selected.paths].sort()).toEqual(['hero/mesh.bin', ENTRY, 'notes.txt']);
    expect(Array.from(artifact[`files/${ENTRY}`])).toEqual(Array.from(source));
    expect(Array.from(artifact['files/hero/mesh.bin'])).toEqual(Array.from(GEOMETRY));
    expect(Array.from(artifact['files/notes.txt'])).toEqual(Array.from(note));
  });

  it('returns the precise missing dependency with the available source and entry paths', async () => {
    await expectFailure(inspect([
      inputFile('model.gltf', modelJson('mesh.bin'), ENTRY),
    ], undefined, IMPORT_LIMITS), 'missing', {
      entries: [ENTRY], paths: [ENTRY], missing: ['hero/mesh.bin'],
    });
  });

  it('rejects two selected files whose folder paths normalize to the same model', async () => {
    const bytes = modelGlb();
    await expectFailure(inspect([
      inputFile('model.glb', bytes, 'hero/model.glb'),
      inputFile('model.glb', bytes, 'hero/./model.glb'),
    ], undefined, IMPORT_LIMITS), 'duplicate');
  });

  it('reports duplicate normalized paths inside a selected ZIP', async () => {
    const zipped = archive(new Map([
      [ENTRY, modelJson('mesh.bin')],
      ['hero/mesh.bin', GEOMETRY],
      ['hero/./mesh.bin', Uint8Array.from(GEOMETRY)],
    ]));
    await expectFailure(inspect([inputFile('character.zip', zipped)], undefined, IMPORT_LIMITS), 'duplicate');
  });

  it('reports invalid bytes even when the file advertises a model MIME type', async () => {
    await expectFailure(inspect([
      inputFile('character.glb', new Uint8Array([1, 2, 3, 4]), '', 'model/gltf-binary'),
    ], undefined, IMPORT_LIMITS), 'invalid');
  });
});

describe('model-selection metadata budget admission', () => {
  it('accepts the exact input byte budget and refuses a lower budget before reading the file', async () => {
    const bytes = modelGlb();
    const file = inputFile('character.glb', bytes);
    const read = vi.spyOn(file, 'arrayBuffer');
    const limits = { ...IMPORT_LIMITS, maxInputBytes: file.size };
    const selected = await inspect([file], undefined, limits);
    expect(Array.from(selected.artifact)).toEqual(Array.from(bytes));
    expect(read).toHaveBeenCalledTimes(1);
    read.mockClear();

    await expectFailure(inspect([file], undefined, { ...limits, maxInputBytes: file.size - 1 }), 'budget');
    expect(read).toHaveBeenCalledTimes(0);
  });

  it('checks the combined input size before reading either selected file', async () => {
    const first = inputFile('first.glb', modelGlb('First'));
    const second = inputFile('second.glb', modelGlb('Second'));
    const firstRead = vi.spyOn(first, 'arrayBuffer');
    const secondRead = vi.spyOn(second, 'arrayBuffer');
    const total = first.size + second.size;
    const limits = { ...IMPORT_LIMITS, maxInputBytes: total };
    const selected = await inspect([first, second], 'first.glb', limits);
    expect([...selected.paths].sort()).toEqual(['first.glb', 'second.glb']);
    expect(firstRead).toHaveBeenCalledTimes(1);
    expect(secondRead).toHaveBeenCalledTimes(1);
    firstRead.mockClear();
    secondRead.mockClear();

    await expectFailure(inspect([first, second], 'first.glb', { ...limits, maxInputBytes: total - 1 }), 'budget');
    expect(firstRead).toHaveBeenCalledTimes(0);
    expect(secondRead).toHaveBeenCalledTimes(0);
  });

  it('checks the selected file count at its exact boundary before reading bytes', async () => {
    const first = inputFile('first.glb', modelGlb('First'));
    const second = inputFile('second.glb', modelGlb('Second'));
    const firstRead = vi.spyOn(first, 'arrayBuffer');
    const secondRead = vi.spyOn(second, 'arrayBuffer');
    const limits = { ...IMPORT_LIMITS, maxFiles: 2 };
    const selected = await inspect([first, second], 'first.glb', limits);
    expect([...selected.paths].sort()).toEqual(['first.glb', 'second.glb']);
    firstRead.mockClear();
    secondRead.mockClear();

    await expectFailure(inspect([first, second], 'first.glb', { ...limits, maxFiles: 1 }), 'budget');
    expect(firstRead).toHaveBeenCalledTimes(0);
    expect(secondRead).toHaveBeenCalledTimes(0);
  });

  it('also applies the file budget to the entries expanded from one selected ZIP', async () => {
    const zipped = archive(new Map([[ENTRY, modelJson('mesh.bin')], ['hero/mesh.bin', GEOMETRY]]));
    const file = inputFile('character.zip', zipped);
    const limits = { ...IMPORT_LIMITS, maxFiles: 2 };
    const selected = await inspect([file], undefined, limits);
    expect([...selected.paths].sort()).toEqual(['hero/mesh.bin', ENTRY]);

    await expectFailure(inspect([file], undefined, { ...limits, maxFiles: 1 }), 'budget');
  });

  it('reports an artifact budget failure through the typed selection error', async () => {
    await expectFailure(inspect([
      inputFile('character.glb', modelGlb()),
    ], undefined, { ...IMPORT_LIMITS, maxArtifactBytes: 1 }), 'budget');
  });
});

describe('model-selection failures state their limit and location (inner#1690)', () => {
  /**
   * Run one inspection and return the failure it reports.
   * @throws {Error} When the inspection succeeds.
   */
  async function failure(files: readonly File[], entry: string | undefined, limits = IMPORT_LIMITS): Promise<ModelImportError> {
    try { await inspect(files, entry, limits); } catch (error) { if (error instanceof ModelImportError) return error; throw error; }
    throw new Error('Expected model selection to fail');
  }

  it('states the expanded size of a whole archive against its limit', async () => {
    const zipped = archive(new Map([['a.bin', new Uint8Array(600)], ['b.bin', new Uint8Array(600)], ['m.glb', modelGlb()]]));
    const error = await failure([inputFile('m.zip', zipped)], undefined, { ...IMPORT_LIMITS, maxExpandedBytes: 1000 });
    expect(error).toMatchObject({ code: 'budget', budget: { limit: 'expanded', allowed: 1000, actual: 1200 + modelGlb().byteLength } });
  });

  it('states the selected file count and total size against their limits', async () => {
    const files = [inputFile('a.glb', modelGlb()), inputFile('b.bin', GEOMETRY.slice())];
    expect(await failure(files, 'a.glb', { ...IMPORT_LIMITS, maxFiles: 1 })).toMatchObject({ budget: { limit: 'files', allowed: 1, actual: 2 } });
    const total = files[0].size + files[1].size;
    expect(await failure(files, 'a.glb', { ...IMPORT_LIMITS, maxInputBytes: total - 1 })).toMatchObject({ budget: { limit: 'input', allowed: total - 1, actual: total } });
  });

  it('states the entry description size against its limit', async () => {
    const json = modelJson('mesh.bin');
    const error = await failure([inputFile('model.gltf', json, ENTRY), inputFile('mesh.bin', GEOMETRY.slice(), 'hero/mesh.bin')], undefined, { ...IMPORT_LIMITS, maxEntryJsonBytes: 10 });
    expect(error).toMatchObject({ code: 'budget', detail: ENTRY, budget: { limit: 'entryJson', allowed: 10, actual: json.byteLength } });
  });

  it.each([['../textures/color.png', '../textures/color.png'], ['https://cdn.example.com/mesh.bin', 'https://cdn.example.com/mesh.bin']])('names the dependency %s that is not inside the selection', async (uri, detail) => {
    expect(await failure([inputFile('model.gltf', modelJson(uri))], undefined)).toMatchObject({ code: 'invalid', detail });
  });

  it('names the archive entries that share a path and an unsupported compression method', async () => {
    const zipped = archive(new Map([['m/t.png', new Uint8Array(1)], ['m\\t.png', new Uint8Array(1)], ['m.glb', modelGlb()]]));
    expect(await failure([inputFile('m.zip', zipped)], undefined)).toMatchObject({ code: 'duplicate', detail: 'm/t.png' });
    const bzip = archive(new Map([['m.glb', modelGlb()]]));
    const view = new DataView(bzip.buffer);
    for (let offset = 0; offset < bzip.byteLength - 4; offset += 1) {
      const signature = view.getUint32(offset, true);
      if (signature === 0x04034b50) view.setUint16(offset + 8, 12, true);
      if (signature === 0x02014b50) view.setUint16(offset + 10, 12, true);
    }
    expect(await failure([inputFile('m.zip', bzip)], undefined)).toMatchObject({ code: 'unsupported', detail: 'm.glb' });
  });

  it('names a selected file the browser cannot read', async () => {
    const file = inputFile('model.glb', modelGlb(), 'hero/model.glb');
    Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.reject(new DOMException('gone', 'NotFoundError')) });
    expect(await failure([file], undefined)).toMatchObject({ code: 'invalid', detail: 'hero/model.glb' });
  });

  it('reads a UTF-8 entry name written without the UTF-8 flag', async () => {
    const zipped = archive(new Map([['hero/model.gltf', modelJson('%E8%B4%B4%E5%9B%BE.bin')], ['hero/贴图.bin', GEOMETRY.slice()]]));
    const view = new DataView(zipped.buffer);
    for (let offset = 0; offset < zipped.byteLength - 4; offset += 1) {
      const signature = view.getUint32(offset, true);
      if (signature === 0x04034b50) view.setUint16(offset + 6, view.getUint16(offset + 6, true) & ~0x800, true);
      if (signature === 0x02014b50) view.setUint16(offset + 8, view.getUint16(offset + 8, true) & ~0x800, true);
    }
    const selected = await inspect([inputFile('hero.zip', zipped)], undefined, IMPORT_LIMITS);
    expect([...selected.paths].sort()).toEqual(['hero/model.gltf', 'hero/贴图.bin']);
  });
});
