// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Files put into a body by paste, drop or the insert menu (inner#1351 +
 * inner#1390 design §5.9): admitted at once on the canvas's rules plus the
 * body's own, each admitted file becomes a pending media block, and its
 * upload starts once the blocks are in.
 */

import { describe, it, expect, vi } from 'vitest';

import { createFileUploads, uploadLandsIn, type FileUploadsDeps } from '@web/spaces/document/document-uploads';

/**
 * A file of a given type and size.
 * @param name - Its name.
 * @param type - Its MIME type.
 * @param size - Its size in bytes.
 * @returns The file.
 */
function file(name: string, type: string, size = 8): File {
  return new File([new Uint8Array(size)], name, { type });
}

/**
 * File uploads whose cap and sinks the test reads.
 * @param maxUploadBytes - The cap the page knows.
 * @returns The uploads and their deps.
 */
function uploads(maxUploadBytes = 1000): { deps: FileUploadsDeps; files: ReturnType<typeof createFileUploads> } {
  const deps: FileUploadsDeps = {
    maxUploadBytes: () => maxUploadBytes,
    refuse: vi.fn(),
    start: vi.fn(),
  };
  return { deps, files: createFileUploads(deps) };
}

/** A pending block as {@link createFileUploads} builds it. */
interface Built {
  type: string;
  props: { url: string; uploadId: string; name: string; caption: string };
}

describe('admission', () => {
  it.each([
    ['an empty file', file('e.png', 'image/png', 0), 'canvas.upload.empty'],
    ['a file over the cap', file('big.png', 'image/png', 2000), 'canvas.upload.tooLarge'],
    ['a format we do not take', file('loop.gif', 'image/gif'), 'canvas.upload.unsupportedType'],
    ['a file that is not media', file('notes.txt', 'text/plain'), 'canvas.upload.unsupportedType'],
  ])('refuses %s at once, with a toast, and makes no block', (_label, picked, key) => {
    const { deps, files } = uploads();

    const prepared = files.prepare([picked]);

    expect(prepared).toBeNull();
    expect(deps.refuse).toHaveBeenCalledWith(key, expect.objectContaining({ filename: picked.name }));
  });

  it('with no cap read yet takes a large file and leaves it to the server', () => {
    const { files } = uploads(Infinity);

    expect(files.prepare([file('big.png', 'image/png', 2000)])).not.toBeNull();
  });

  it('makes blocks only for the files it admits', () => {
    const { deps, files } = uploads();

    const prepared = files.prepare([file('a.png', 'image/png'), file('e.png', 'image/png', 0)]);

    expect((prepared!.blocks as Built[]).map((b) => b.props.name)).toEqual(['a.png']);
    expect(deps.refuse).toHaveBeenCalledOnce();
  });
});

describe('the blocks', () => {
  it('name the Document they were made in, so their result is written into them (breatic#1574)', () => {
    const deps: FileUploadsDeps = { maxUploadBytes: () => 1000, refuse: vi.fn(), start: vi.fn(), home: 'project-p/document-s' };

    const prepared = createFileUploads(deps).prepare([file('a.png', 'image/png')]);

    expect((prepared!.blocks[0] as { props: Record<string, unknown> }).props['uploadHome']).toBe('project-p/document-s');
  });

  it('are pending blocks of each file\'s kind, named after it, each with its own upload', () => {
    const { files } = uploads();

    const prepared = files.prepare([
      file('a.png', 'image/png'),
      file('b.mp4', 'video/mp4'),
      file('c.mp3', 'audio/mpeg'),
    ]);

    const blocks = prepared!.blocks as Built[];
    expect(blocks.map((b) => [b.type, b.props.url, b.props.name, b.props.caption])).toEqual([
      ['image', '', 'a.png', ''],
      ['video', '', 'b.mp4', ''],
      ['audio', '', 'c.mp3', ''],
    ]);
    const ids = blocks.map((b) => b.props.uploadId);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => id !== '')).toBe(true);
  });

  it('start nothing until told, then start each file under its block\'s upload', () => {
    const { deps, files } = uploads();
    const a = file('a.png', 'image/png');
    const b = file('b.mp4', 'video/mp4');

    const prepared = files.prepare([a, b])!;
    expect(deps.start).not.toHaveBeenCalled();
    prepared.start();

    const ids = (prepared.blocks as Built[]).map((block) => block.props.uploadId);
    expect(deps.start).toHaveBeenNthCalledWith(1, ids[0], { kind: 'file', file: a });
    expect(deps.start).toHaveBeenNthCalledWith(2, ids[1], { kind: 'file', file: b });
  });
});

describe('uploadLandsIn', () => {
  it('matches collab: a block lands only in the Document its home names, and anywhere while the Document is unknown', () => {
    expect(uploadLandsIn('doc-a', 'doc-a')).toBe(true);
    expect(uploadLandsIn('doc-a', 'doc-b')).toBe(false);
    expect(uploadLandsIn(undefined, 'doc-a')).toBe(false);
    expect(uploadLandsIn('', 'doc-a')).toBe(false);
    expect(uploadLandsIn(undefined, null)).toBe(true);
    expect(uploadLandsIn('doc-a', undefined)).toBe(true);
  });
});
