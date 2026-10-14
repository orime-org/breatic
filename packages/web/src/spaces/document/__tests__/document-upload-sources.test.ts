// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a pending block's bytes come from and how each source ends
 * (inner#1351 + inner#1390 design §5.2, §5.3, §5.4): a file is uploaded, an
 * `https:` address is fetched by the ingest Worker one at a time, a `data:`
 * or `blob:` address is read here and uploaded, an address of ours is
 * registered with the others of the same paste in one request.
 */

import { describe, it, expect, vi } from 'vitest';

import { ApiException } from '@web/data/api/types';
import { UploadFailedError, type StoredUpload } from '@web/data/upload/media-upload';
import type { UploadEnding } from '@web/data/upload/upload-status';
import {
  createUploadSources,
  type UploadSourceDeps,
} from '@web/spaces/document/document-upload-sources';
import type { UploadOutcome } from '@web/spaces/document/document-upload-controller';

const PREFIX = 'https://cdn.example/';

/**
 * A stored upload.
 * @param fileUrl - Its address.
 * @param kind - What the server read it as.
 * @returns The record.
 */
function stored(fileUrl: string, kind = 'image'): StoredUpload {
  return { assetId: 'a1', fileUrl, kind, width: 640, height: 480 };
}

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
    uploadFile: vi.fn(async () => stored(`${PREFIX}up.png`)),
    ingest: vi.fn(async () => 'key-1'),
    waitForEnding: vi.fn(async (key: string): Promise<UploadEnding> => ({
      key,
      state: 'completed',
      result: stored(`${PREFIX}fetched.png`),
    })),
    register: vi.fn(async ({ urls, pairs }: Parameters<UploadSourceDeps['register']>[0]) =>
      Object.fromEntries([...urls, ...pairs.flatMap((p) => [p.url, p.cover])].map((u) => [u, `${u}?copy`])),
    ),
    assetUrlPrefix: vi.fn(async () => PREFIX),
    readAddress: vi.fn(async () => new File(['x'], 'pasted', { type: 'image/png' })),
    sleep: vi.fn(async () => {}),
    ...overrides,
  };
  return { run: createUploadSources(deps), deps };
}

const noProgress = (): void => {};

/**
 * The failure an outcome holds.
 * @param outcome - The outcome.
 * @returns Its message key and whether a retry can help.
 */
function failure(outcome: UploadOutcome): { key: string; retryable: boolean } {
  if (outcome.ok) throw new Error('expected a failure');
  return { key: outcome.failure.messageKey, retryable: outcome.failure.retryable };
}

describe('a file', () => {
  it('is uploaded, its progress passed on, and ends with the stored address and size', async () => {
    const uploadFile = vi.fn(async (_file: File, onProgress: (share: number) => void) => {
      onProgress(0.5);
      return stored(`${PREFIX}up.png`);
    });
    const { run } = sources({ uploadFile });
    const progress = vi.fn();
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    const outcome = await run('u1', { kind: 'file', file }, progress);
    expect(outcome).toEqual({ ok: true, result: { url: `${PREFIX}up.png`, mediaWidth: 640, mediaHeight: 480 } });
    expect(progress).toHaveBeenCalledWith(0.5);
  });

  it('refused as too large says so and offers no retry', async () => {
    const { run } = sources({ uploadFile: vi.fn(async () => Promise.reject(new UploadFailedError('tooLarge'))) });
    const outcome = await run('u1', { kind: 'file', file: new File(['x'], 'a.png', { type: 'image/png' }) }, noProgress);
    expect(failure(outcome)).toEqual({ key: 'canvas.upload.tooLarge', retryable: false });
  });

  it('that failed in transfer can be retried', async () => {
    const { run } = sources({ uploadFile: vi.fn(async () => Promise.reject(new UploadFailedError('transfer'))) });
    const outcome = await run('u1', { kind: 'file', file: new File(['x'], 'a.png', { type: 'image/png' }) }, noProgress);
    expect(failure(outcome)).toEqual({ key: 'canvas.upload.failed', retryable: true });
  });

  it('stored as something that is not a medium is refused as that type', async () => {
    const { run } = sources({ uploadFile: vi.fn(async () => stored(`${PREFIX}x.pdf`, 'document')) });
    const outcome = await run('u1', { kind: 'file', file: new File(['x'], 'a.png', { type: 'image/png' }) }, noProgress);
    expect(failure(outcome)).toEqual({ key: 'canvas.upload.unsupportedType', retryable: false });
  });
});

describe('an https address', () => {
  it('is fetched by the ingest Worker and ends with what it stored', async () => {
    const { run, deps } = sources();
    const outcome = await run('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' }, noProgress);
    expect(deps.ingest).toHaveBeenCalledWith('https://imgs.example/x.jpg');
    expect(deps.waitForEnding).toHaveBeenCalledWith('key-1');
    expect(outcome).toEqual({ ok: true, result: { url: `${PREFIX}fetched.png`, mediaWidth: 640, mediaHeight: 480 } });
  });

  it.each([
    ['source_unreachable', true],
    ['source_cut_off', true],
    ['internal', true],
    ['unsupported_type', false],
    ['over_cap', false],
    ['empty', false],
  ])('whose fetch failed as %s says so, retryable: %s', async (reason, retryable) => {
    const { run } = sources({ waitForEnding: vi.fn(async (key: string) => ({ key, state: 'failed' as const, reason })) });
    const outcome = await run('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' }, noProgress);
    expect(failure(outcome)).toEqual({ key: `canvas.task.failure.${reason}`, retryable });
  });

  it('whose ending the server does not know fails and can be retried', async () => {
    const { run } = sources({ waitForEnding: vi.fn(async (key: string) => ({ key, state: 'unknown' as const })) });
    const outcome = await run('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' }, noProgress);
    expect(failure(outcome)).toEqual({ key: 'canvas.upload.failed', retryable: true });
  });

  it('turned away for the rate waits as long as the server says, then is sent again', async () => {
    const ingest = vi
      .fn<UploadSourceDeps['ingest']>()
      .mockRejectedValueOnce(new ApiException({ status: 429, message: 'slow', retryAfterSeconds: 7 }))
      .mockResolvedValueOnce('key-1');
    const { run, deps } = sources({ ingest });
    const outcome = await run('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' }, noProgress);
    expect(deps.sleep).toHaveBeenCalledWith(7000);
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(outcome.ok).toBe(true);
  });

  it.each([
    [507, 'canvas.upload.storageFull', false],
    [400, 'canvas.upload.failed', false],
    [0, 'canvas.upload.failed', true],
    [503, 'canvas.upload.failed', true],
  ])('refused with %s says %s, retryable: %s', async (status, key, retryable) => {
    const { run } = sources({
      ingest: vi.fn(async () => Promise.reject(new ApiException({ status, message: 'no' }))),
    });
    const outcome = await run('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' }, noProgress);
    expect(failure(outcome)).toEqual({ key, retryable });
  });

  it('is sent only once the address before it has been taken', async () => {
    let release!: (key: string) => void;
    const ingest = vi
      .fn<UploadSourceDeps['ingest']>()
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      .mockResolvedValueOnce('key-2');
    const { run } = sources({ ingest });
    const first = run('u1', { kind: 'address', url: 'https://imgs.example/1.jpg' }, noProgress);
    const second = run('u2', { kind: 'address', url: 'https://imgs.example/2.jpg' }, noProgress);
    await Promise.resolve();
    await Promise.resolve();
    expect(ingest).toHaveBeenCalledTimes(1);
    release('key-1');
    await Promise.all([first, second]);
    expect(ingest).toHaveBeenNthCalledWith(2, 'https://imgs.example/2.jpg');
  });

  it('under our own prefix keeps its address and sends nothing', async () => {
    const { run, deps } = sources();
    const outcome = await run('u1', { kind: 'address', url: `${PREFIX}mine.png` }, noProgress);
    expect(outcome).toEqual({ ok: true, result: { url: `${PREFIX}mine.png` } });
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

  it('that cannot be read any more fails with no retry', async () => {
    const { run } = sources({ readAddress: vi.fn(async () => Promise.reject(new TypeError('revoked'))) });
    const outcome = await run('u1', { kind: 'address', url: 'blob:https://x/1' }, noProgress);
    expect(failure(outcome)).toEqual({ key: 'canvas.upload.failed', retryable: false });
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
    expect(failure(outcome)).toEqual({ key: 'canvas.upload.storageFull', retryable: false });
  });

  it('turned away for the rate can be retried', async () => {
    const { run } = sources({
      register: vi.fn(async () => Promise.reject(new ApiException({ status: 429, message: 'slow' }))),
    });
    const outcome = await run('u1', { kind: 'ours', url: `${PREFIX}a.png` }, noProgress);
    expect(failure(outcome)).toEqual({ key: 'canvas.upload.rateLimited', retryable: true });
  });

  it('missing from the answer fails', async () => {
    const { run } = sources({ register: vi.fn(async () => ({})) });
    const outcome = await run('u1', { kind: 'ours', url: `${PREFIX}a.png` }, noProgress);
    expect(failure(outcome)).toEqual({ key: 'canvas.upload.failed', retryable: true });
  });
});
