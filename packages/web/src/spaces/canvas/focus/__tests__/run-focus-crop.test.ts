// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Focus-crop orchestration tests (#1782): export → wrap as File →
 * upload pipeline → focusImages write, with both failure exits.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  runFocusCrop,
  focusCropFilename,
  type FocusCropDeps,
} from '@web/spaces/canvas/focus/run-focus-crop';

const CROP = { x: 10, y: 20, width: 640, height: 360 };

/**
 * Build a full happy-path dependency set; individual tests override the
 * failing piece.
 * @returns The deps plus the spies for assertions.
 */
function makeDeps(): FocusCropDeps & {
  addFocusImage: ReturnType<typeof vi.fn>;
  onFailure: ReturnType<typeof vi.fn>;
} {
  return {
    exportCrop: vi.fn().mockResolvedValue(new Blob(['x'], { type: 'image/png' })),
    uploadFile: vi.fn().mockResolvedValue('https://cdn/crop-final.png'),
    addFocusImage: vi.fn(),
    onFailure: vi.fn(),
    makeId: () => 'focus-uuid-1',
  };
}

describe('runFocusCrop', () => {
  it('happy path: exports, uploads, then appends the FocusImage copy', async () => {
    const deps = makeDeps();
    await runFocusCrop(
      {
        sourceUrl: 'https://cdn/source.png',
        sourceName: 'Image Node 26',
        crop: CROP,
        projectId: 'p1',
      },
      deps,
    );
    expect(deps.exportCrop).toHaveBeenCalledWith('https://cdn/source.png', CROP);
    // The uploaded file is a PNG named from the source snapshot.
    const uploadCall = vi.mocked(deps.uploadFile).mock.calls[0]!;
    const file = uploadCall[0];
    expect(file.name).toBe(focusCropFilename('Image Node 26'));
    expect(file.type).toBe('image/png');
    expect(uploadCall[1]).toBe('p1');
    expect(deps.addFocusImage).toHaveBeenCalledWith({
      id: 'focus-uuid-1',
      url: 'https://cdn/crop-final.png',
      name: 'Image Node 26',
      width: 640,
      height: 360,
    });
    expect(deps.onFailure).not.toHaveBeenCalled();
  });

  it('export failure: reports "export", never uploads or writes', async () => {
    const deps = makeDeps();
    vi.mocked(deps.exportCrop).mockRejectedValue(new Error('taint'));
    await runFocusCrop(
      { sourceUrl: 'u', sourceName: 'n', crop: CROP, projectId: 'p1' },
      deps,
    );
    expect(deps.onFailure).toHaveBeenCalledWith('export');
    expect(deps.uploadFile).not.toHaveBeenCalled();
    expect(deps.addFocusImage).not.toHaveBeenCalled();
  });

  it('upload failure: reports "upload", writes nothing (no half data)', async () => {
    const deps = makeDeps();
    vi.mocked(deps.uploadFile).mockRejectedValue(new Error('net'));
    await runFocusCrop(
      { sourceUrl: 'u', sourceName: 'n', crop: CROP, projectId: 'p1' },
      deps,
    );
    expect(deps.onFailure).toHaveBeenCalledWith('upload');
    expect(deps.addFocusImage).not.toHaveBeenCalled();
  });
});

describe('focusCropFilename', () => {
  it('builds a .png name from the source snapshot', () => {
    expect(focusCropFilename('Image Node 26')).toBe('focus-Image Node 26.png');
  });

  it('strips path separators and control chars (presign filename rules)', () => {
    expect(focusCropFilename('a/b\\cd')).toBe('focus-abcd.png');
  });

  it('falls back to "crop" for an empty-after-sanitize name and trims long names', () => {
    expect(focusCropFilename('//\\\\')).toBe('focus-crop.png');
    const long = 'x'.repeat(300);
    expect(focusCropFilename(long).length).toBeLessThanOrEqual(255);
  });
});
