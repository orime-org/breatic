// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A focus crop handed to the server (#1580 test spec E-01, E-02, E-08 to
 * E-11; design §2.4): the crop carries one id from start to end, the upload
 * names the pool it lands in, and the page writes nothing into the document.
 */

import { describe, it, expect, vi } from 'vitest';

import { runFocusCrop } from '@web/spaces/canvas/focus/run-focus-crop';

const CROP = { x: 10, y: 20, width: 640.5, height: 360 };

/** The dependencies a crop needs, each a spy. */
function deps(): Parameters<typeof runFocusCrop>[1] {
  return {
    exportCrop: vi.fn().mockResolvedValue(new Blob(['x'], { type: 'image/png' })),
    uploadFile: vi.fn().mockResolvedValue(undefined),
    onFailure: vi.fn(),
  };
}

const PARAMS = {
  id: 'crop-1',
  sourceUrl: 'https://cdn/source.png',
  sourceName: 'Image Node 26',
  sourceTimeSeconds: null,
  crop: CROP,
  projectId: 'p1',
};

describe('runFocusCrop, handed to the server', () => {
  it('E-01 and E-02 upload the crop under the id it was started with, naming the image the pool will hold', async () => {
    const d = deps();
    await runFocusCrop(PARAMS, d);
    expect(d.uploadFile).toHaveBeenCalledTimes(1);
    const [, projectId, focusImage] = vi.mocked(d.uploadFile).mock.calls[0]!;
    expect(projectId).toBe('p1');
    expect(focusImage).toEqual({ id: 'crop-1', name: 'Image Node 26', width: 640.5, height: 360 });
  });

  it('E-08 writes nothing into the document when the upload ends well', async () => {
    const d = deps();
    await runFocusCrop(PARAMS, d);
    expect(d).not.toHaveProperty('addFocusImage');
    expect(d.onFailure).not.toHaveBeenCalled();
  });

  it.each([
    ['the export', 'export', () => ({ exportCrop: vi.fn().mockRejectedValue(new Error('x')) })],
    ['the bytes', 'transfer', () => ({ uploadFile: vi.fn().mockRejectedValue(new Error('transfer')) })],
    ['a refusal naming storage', 'storage', () => ({ uploadFile: vi.fn().mockRejectedValue(new Error('storage')) })],
  ])('E-09 to E-11 reports a failure in %s', async (_label, stage, over) => {
    const d = { ...deps(), ...over() };
    await runFocusCrop(PARAMS, d);
    expect(d.onFailure).toHaveBeenCalledWith(stage);
  });

  it('settles once the bytes are sent, and still reports an upload that ends badly afterwards', async () => {
    let endUpload: (err: Error) => void = () => undefined;
    const d = {
      ...deps(),
      uploadFile: vi.fn((_file: File, _projectId: string, _image: unknown, onSent: () => void) => {
        onSent();
        return new Promise<void>((_resolve, reject) => { endUpload = reject; });
      }),
    };
    let settled = false;
    const run = runFocusCrop(PARAMS, d).then(() => { settled = true; });
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(d.onFailure).not.toHaveBeenCalled();
    endUpload(new Error('transfer'));
    await vi.waitFor(() => expect(d.onFailure).toHaveBeenCalledWith('transfer'));
    await run;
  });
});
