// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import { sourcesFromDrop } from '@web/spaces/three-d/model-source';

/**
 * Build a dropped file entry that yields the given File.
 * @throws {never} Never.
 */
function fileEntry(fullPath: string, file: File): FileSystemFileEntry {
  return { isFile: true, isDirectory: false, fullPath, name: file.name, file: (resolve: (value: File) => void) => resolve(file) } as unknown as FileSystemFileEntry;
}

/**
 * Build a dropped directory whose reader returns its children in batches, then an empty batch.
 * @throws {never} Never.
 */
function directoryEntry(fullPath: string, batches: FileSystemEntry[][]): FileSystemDirectoryEntry {
  return {
    isFile: false, isDirectory: true, fullPath, name: fullPath.slice(fullPath.lastIndexOf('/') + 1),
    createReader: () => {
      const pending = [...batches, []];
      return { readEntries: (resolve: (entries: FileSystemEntry[]) => void) => resolve(pending.shift() ?? []) };
    },
  } as unknown as FileSystemDirectoryEntry;
}

/**
 * Wrap entries as the drop event's item list.
 * @throws {never} Never.
 */
function transfer(entries: (FileSystemEntry | null)[], files: File[] = []): DataTransfer {
  const items = entries.map((entry, index) => ({ kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => files[index] ?? null }));
  return { items, files } as unknown as DataTransfer;
}

describe('dropped model sources (inner#1690)', () => {
  it('reads every file of a dropped folder, across reader batches, under its folder path', async () => {
    const model = new File(['{}'], 'model.gltf');
    const mesh = new File(['x'], 'mesh.bin');
    const texture = new File(['y'], 'a.png');
    const folder = directoryEntry('/hero', [
      [fileEntry('/hero/model.gltf', model)],
      [fileEntry('/hero/mesh.bin', mesh), directoryEntry('/hero/tex', [[fileEntry('/hero/tex/a.png', texture)]])],
    ]);

    const sources = await sourcesFromDrop(transfer([folder]));

    expect(sources.map((source) => [source.path, source.file])).toEqual([
      ['hero/model.gltf', model], ['hero/mesh.bin', mesh], ['hero/tex/a.png', texture],
    ]);
  });

  it('keeps dropped loose files under their own names', async () => {
    const model = new File(['{}'], 'model.glb');
    const sources = await sourcesFromDrop(transfer([fileEntry('/model.glb', model)]));
    expect(sources).toEqual([{ path: 'model.glb', file: model }]);
  });

  it('reads an item without a file system entry as the file it carries', async () => {
    const model = new File(['{}'], 'model.glb');
    const sources = await sourcesFromDrop(transfer([null], [model]));
    expect(sources).toEqual([{ path: 'model.glb', file: model }]);
  });
});
