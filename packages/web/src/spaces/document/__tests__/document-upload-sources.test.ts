// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Where a pending block's bytes come from and how each source ends
 * (inner#1351 + inner#1390 design §5.2, §5.3, §5.4; breatic#1574): a file is
 * handed to the server for its block, an `https:` address is handed to the
 * ingest Worker one at a time, a `data:` or `blob:` address is read here and
 * handed over as a file, an address of ours is registered with the others of
 * the same paste in one request.
 */

import { describe, it, expect, vi } from 'vitest';

import { ApiException } from '@web/data/api/types';
import { UploadFailedError } from '@web/data/upload/media-upload';
import {
  createUploadSources,
  type UploadSourceDeps,
} from '@web/spaces/document/document-upload-sources';
import type { UploadFailure, UploadOutcome } from '@web/spaces/document/document-upload-controller';

const PREFIX = 'https://cdn.example/';

/**
 * Sources whose network the test answers.
 * @param overrides - The parts a test answers itself.
 * @returns The run function and the deps it was built with.
 */
function sources(overrides: Partial<UploadSourceDeps> = {}): {
  run: ReturnType<typeof createUploadSources>;
  deps: UploadSourceDeps;
} {
  const deps: UploadSourceDeps = {
    uploadFile: vi.fn(async () => {}),
    ingest: vi.fn(async () => {}),
    register: vi.fn(async ({ urls, pairs }: Parameters<UploadSourceDeps['register']>[0]) =>
      Object.fromEntries([...urls, ...pairs.flatMap((p) => [p.url, p.cover])].map((u) => [u, `${u}?copy`])),
    ),
    assetUrlPrefix: vi.fn(async () => PREFIX),
    readAddress: vi.fn(async () => new Blob(['x'], { type: 'image/png' })),
    sleep: vi.fn(async () => {}),
    ...overrides,
  };
  return { run: createUploadSources(deps), deps };
}

const noProgress = (): void => {};

/**
 * The failure an outcome holds.
 * @param outcome - The outcome.
 * @returns Why it failed and whether a retry can help.
 */
function failure(outcome: UploadOutcome): UploadFailure {
  if (outcome.ok) throw new Error('expected a failure');
  return outcome.failure;
}

describe('a file', () => {
  it('is handed to the server for its block, its progress passed on, and this page is done with it', async () => {
    const uploadFile = vi.fn(async (_file: File, _uploadId: string, onProgress: (share: number) => void) => {
      onProgress(0.5);
    });
    const { run } = sources({ uploadFile });
    const progress = vi.fn();
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    const outcome = await run('u1', { kind: 'file', file }, progress);
    expect(outcome).toEqual({ ok: true, handedOff: true });
    expect(uploadFile).toHaveBeenCalledWith(file, 'u1', expect.any(Function));
    expect(progress).toHaveBeenCalledWith(0.5);
  });

  it('refused as too large says so and offers no retry', async () => {
    const { run } = sources({ uploadFile: vi.fn(async () => Promise.reject(new UploadFailedError('tooLarge'))) });
    const outcome = await run('u1', { kind: 'file', file: new File(['x'], 'a.png', { type: 'image/png' }) }, noProgress);
    expect(failure(outcome)).toEqual({ reason: 'tooLarge', retryable: false });
  });

  it('that failed in transfer can be retried', async () => {
    const { run } = sources({ uploadFile: vi.fn(async () => Promise.reject(new UploadFailedError('transfer'))) });
    const outcome = await run('u1', { kind: 'file', file: new File(['x'], 'a.png', { type: 'image/png' }) }, noProgress);
    expect(failure(outcome)).toEqual({ reason: 'failed', retryable: true });
  });
});

describe('an https address', () => {
  it('is handed to the ingest Worker for its block, and this page is done with it', async () => {
    const { run, deps } = sources();
    const outcome = await run('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' }, noProgress);
    expect(deps.ingest).toHaveBeenCalledWith('https://imgs.example/x.jpg', 'u1');
    expect(outcome).toEqual({ ok: true, handedOff: true });
  });

  it('turned away for the rate waits as long as the server says, then is sent again', async () => {
    const ingest = vi
      .fn<UploadSourceDeps['ingest']>()
      .mockRejectedValueOnce(new ApiException({ status: 429, message: 'slow', retryAfterSeconds: 7 }))
      .mockResolvedValueOnce(undefined);
    const { run, deps } = sources({ ingest });
    const outcome = await run('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' }, noProgress);
    expect(deps.sleep).toHaveBeenCalledWith(7000);
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(outcome.ok).toBe(true);
  });

  it.each([
    [507, 'storageFull', false],
    [400, 'failed', false],
    [0, 'failed', true],
    [503, 'failed', true],
  ])('refused with %s says %s, retryable: %s', async (status, reason, retryable) => {
    const { run } = sources({
      ingest: vi.fn(async () => Promise.reject(new ApiException({ status, message: 'no' }))),
    });
    const outcome = await run('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' }, noProgress);
    expect(failure(outcome)).toEqual({ reason, retryable });
  });

  it('is sent only once the address before it has been taken', async () => {
    let release!: () => void;
    const ingest = vi
      .fn<UploadSourceDeps['ingest']>()
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      .mockResolvedValueOnce(undefined);
    const { run } = sources({ ingest });
    const first = run('u1', { kind: 'address', url: 'https://imgs.example/1.jpg' }, noProgress);
    const second = run('u2', { kind: 'address', url: 'https://imgs.example/2.jpg' }, noProgress);
    await Promise.resolve();
    await Promise.resolve();
    expect(ingest).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(ingest).toHaveBeenNthCalledWith(2, 'https://imgs.example/2.jpg', 'u2');
  });

  it('under our own prefix is registered with the paste request and sends nothing to the ingest Worker', async () => {
    const { run, deps } = sources();
    const outcome = await run('u1', { kind: 'address', url: `${PREFIX}mine.png` }, noProgress);
    expect(deps.register).toHaveBeenCalledExactlyOnceWith({ urls: [`${PREFIX}mine.png`], pairs: [] });
    expect(outcome).toEqual({ ok: true, result: { url: `${PREFIX}mine.png?copy` } });
    expect(deps.ingest).not.toHaveBeenCalled();
  });
});

describe('a data: or blob: address', () => {
  it('is read here and uploaded as a file', async () => {
    const { run, deps } = sources();
    const outcome = await run('u1', { kind: 'address', url: 'data:image/png;base64,eA==' }, noProgress);
    expect(deps.readAddress).toHaveBeenCalledWith('data:image/png;base64,eA==');
    expect(deps.uploadFile).toHaveBeenCalledTimes(1);
    expect(outcome.ok).toBe(true);
  });

  it.each([
    ['image/png', 'pasted.png'],
    ['image/jpeg', 'pasted.jpg'],
    ['video/quicktime', 'pasted.mov'],
    ['audio/mpeg', 'pasted.mp3'],
    ['audio/mp4', 'pasted.m4a'],
  ])('read as %s is uploaded under a name carrying its extension, %s', async (type, name) => {
    const { run, deps } = sources({ readAddress: vi.fn(async () => new Blob(['x'], { type })) });
    await run('u1', { kind: 'address', url: 'data:x;base64,eA==' }, noProgress);
    const file = vi.mocked(deps.uploadFile).mock.calls[0]![0] as File;
    expect(file.name).toBe(name);
    expect(file.type).toBe(type);
  });

  it('that cannot be read any more fails with no retry', async () => {
    const { run } = sources({ readAddress: vi.fn(async () => Promise.reject(new TypeError('revoked'))) });
    const outcome = await run('u1', { kind: 'address', url: 'blob:https://x/1' }, noProgress);
    expect(failure(outcome)).toEqual({ reason: 'failed', retryable: false });
  });
});

describe('addresses of ours', () => {
  it('started together are registered in one request, a video with its cover as a pair', async () => {
    const { run, deps } = sources();
    const [a, b] = await Promise.all([
      run('u1', { kind: 'ours', url: `${PREFIX}a.png` }, noProgress),
      run('u2', { kind: 'ours', url: `${PREFIX}v.mp4`, coverUrl: `${PREFIX}v.jpg` }, noProgress),
    ]);
    expect(deps.register).toHaveBeenCalledExactlyOnceWith({
      urls: [`${PREFIX}a.png`],
      pairs: [{ url: `${PREFIX}v.mp4`, cover: `${PREFIX}v.jpg` }],
    });
    expect(a).toEqual({ ok: true, result: { url: `${PREFIX}a.png?copy` } });
    expect(b).toEqual({ ok: true, result: { url: `${PREFIX}v.mp4?copy` } });
  });

  it('refused for want of room all say so, with no retry', async () => {
    const { run } = sources({
      register: vi.fn(async () => Promise.reject(new ApiException({ status: 507, message: 'full' }))),
    });
    const outcome = await run('u1', { kind: 'ours', url: `${PREFIX}a.png` }, noProgress);
    expect(failure(outcome)).toEqual({ reason: 'storageFull', retryable: false });
  });

  it('turned away for the rate can be retried', async () => {
    const { run } = sources({
      register: vi.fn(async () => Promise.reject(new ApiException({ status: 429, message: 'slow' }))),
    });
    const outcome = await run('u1', { kind: 'ours', url: `${PREFIX}a.png` }, noProgress);
    expect(failure(outcome)).toEqual({ reason: 'rateLimited', retryable: true });
  });

  it('missing from the answer keeps its own address', async () => {
    const { run } = sources({ register: vi.fn(async () => ({})) });
    const outcome = await run('u1', { kind: 'ours', url: `${PREFIX}a.png` }, noProgress);
    expect(outcome).toEqual({ ok: true, result: { url: `${PREFIX}a.png` } });
  });
});
