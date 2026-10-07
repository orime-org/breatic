// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';

import { ApiException } from '@web/data/api/types';
import { assetsApi } from '@web/data/api/assets';
import { BytesNotDelivered, sendFileAndFinish } from '@web/data/upload/finish-upload';
import { hashFile } from '@web/data/upload/hash';
import {
  runMediaUpload,
  uploadMedia,
  UploadFailedError,
} from '@web/data/upload/media-upload';

vi.mock('@web/data/api/assets', () => ({
  assetsApi: { fetchUploadConfig: vi.fn(), requestUploadTicket: vi.fn() },
}));
vi.mock('@web/data/upload/hash', () => ({ hashFile: vi.fn() }));
vi.mock('@web/data/upload/finish-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/upload/finish-upload')>()),
  sendFileAndFinish: vi.fn(),
}));

/** The knob fixture threaded through the upload orchestration tests. */
const CFG = {
  maxUploadBytes: 2147483648,
  clientMaxAttempts: 3,
  clientRetryBaseDelayMs: 1000,
  clientRequestTimeoutMs: 30000,
  clientPutMinBytesPerSec: 65536,
  assetUrlPrefix: 'https://cdn/',
};

const HASH = 'a'.repeat(64);

/**
 * An error the API layer would have thrown for `status`.
 * @param status - The status the server answered with.
 * @returns The exception the caller sees.
 */
function apiError(status: number): ApiException {
  return new ApiException({ status, message: `HTTP ${status}` });
}

/** A ticket for a one-part upload. */
const TICKET = {
  ticket: 'signed',
  storageKey: 'image/2026-08-31/p.png',
  uploadUrl: 'https://ingest.example.com',
  kind: 'image',
  partSize: 5 * 1024 * 1024,
  totalParts: 1,
  taskId: 'task-row-1',
};

/** Shared orchestration deps (config + hash + network spies). */
function makeUploadDeps(
  over: Partial<Parameters<typeof runMediaUpload>[2]> = {},
): Parameters<typeof runMediaUpload>[2] {
  return {
    getUploadConfig: vi.fn().mockResolvedValue(CFG),
    hashFile: vi.fn().mockResolvedValue(HASH),
    requestTicket: vi.fn().mockResolvedValue(TICKET),
    sendToIngest: vi.fn().mockResolvedValue({
      assetId: 'asset-new',
      fileUrl: 'https://cdn/p.png',
      kind: 'image',
    }),
    onSuccess: vi.fn(),
    onFailure: vi.fn(),
    sleep: () => Promise.resolve(),
    ...over,
  };
}

describe('runMediaUpload — ask for a ticket, send the bytes, hand back the outcome', () => {
  const file = new File(['x'], 'photo.png', { type: 'image/png' });
  const context = { projectId: 'p1', nodeId: 'n1', spaceId: 's1' };

  it('asks with what the server signs a ticket from, then sends the file', async () => {
    const deps = makeUploadDeps();

    await runMediaUpload(file, context, deps);

    expect(deps.requestTicket).toHaveBeenCalledWith({
      filename: 'photo.png',
      contentType: 'image/png',
      projectId: 'p1',
      size: file.size,
      hash: HASH,
      nodeId: 'n1',
      spaceId: 's1',
    });
    expect(deps.sendToIngest).toHaveBeenCalledWith(file, TICKET, CFG);
    expect(deps.onFailure).not.toHaveBeenCalled();
  });

  it('reports progress as the share of the file that has landed (inner#1127 A4)', async () => {
    const big = new File([new Uint8Array(400)], 'clip.mp4', { type: 'video/mp4' });
    const onProgress = vi.fn();
    const deps = makeUploadDeps({
      onProgress,
      sendToIngest: vi.fn(async (_file, _ticket, _cfg, onPartLanded?: (n: number) => void) => {
        onPartLanded?.(100);
        onPartLanded?.(400);
        return { assetId: 'a', fileUrl: 'https://cdn/c.mp4', kind: 'video' };
      }),
    });

    await runMediaUpload(big, context, deps);

    expect(onProgress.mock.calls).toEqual([[0.25], [1]]);
  });

  // The node reads its result from Yjs and ignores this; an upload with no
  // node behind it has no other channel and reads it here (design §9).
  it('hands back what completing the upload said it became', async () => {
    const deps = makeUploadDeps();

    await runMediaUpload(file, context, deps);

    expect(deps.onSuccess).toHaveBeenCalledExactlyOnceWith({
      fileUrl: 'https://cdn/p.png',
      assetId: 'asset-new',
      kind: 'image',
    });
  });

  it('sends nothing when the studio already holds the content', async () => {
    const deps = makeUploadDeps({
      requestTicket: vi.fn().mockResolvedValue({
        alreadyExists: true,
        assetId: 'asset-existing',
        fileUrl: 'https://cdn/existing.png',
        kind: 'image',
      }),
    });

    await runMediaUpload(file, context, deps);

    expect(deps.sendToIngest).not.toHaveBeenCalled();
    expect(deps.onSuccess).toHaveBeenCalledExactlyOnceWith({
      fileUrl: 'https://cdn/existing.png',
      assetId: 'asset-existing',
      kind: 'image',
    });
  });

  // A studio's avatar belongs to no project: the ticket names the studio, and
  // what the picture is for travels with it.
  it('asks for a studio-scoped ticket for a studio avatar', async () => {
    const deps = makeUploadDeps();

    await runMediaUpload(file, { studioId: 'st1', purpose: 'studio_avatar' }, deps);

    expect(deps.requestTicket).toHaveBeenCalledWith({
      filename: 'photo.png',
      contentType: 'image/png',
      studioId: 'st1',
      size: file.size,
      hash: HASH,
      purpose: 'studio_avatar',
    });
  });

  // No hash, no upload (user decision 2026-07-26): the ledger keys on content,
  // and a file we cannot fingerprint has nothing to key on.
  it('refuses before any network call when the file cannot be hashed', async () => {
    const deps = makeUploadDeps({ hashFile: vi.fn().mockResolvedValue(null) });

    await runMediaUpload(file, context, deps);

    expect(deps.requestTicket).not.toHaveBeenCalled();
    expect(deps.sendToIngest).not.toHaveBeenCalled();
    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith({ reason: 'hash' });
  });

  it('retries a transient ticket failure before succeeding', async () => {
    const requestTicket = vi
      .fn()
      .mockRejectedValueOnce(apiError(503))
      .mockResolvedValue(TICKET);
    const deps = makeUploadDeps({ requestTicket });

    await runMediaUpload(file, context, deps);

    expect(requestTicket).toHaveBeenCalledTimes(2);
    expect(deps.onSuccess).toHaveBeenCalledOnce();
  });

  // No ticket means no grant, so nothing on the server knows this upload was
  // ever attempted and nobody will announce how it ended.
  it('sends nothing when the ticket request finally fails', async () => {
    const deps = makeUploadDeps({
      requestTicket: vi.fn().mockRejectedValue(apiError(503)),
    });

    await runMediaUpload(file, context, deps);

    expect(deps.sendToIngest).not.toHaveBeenCalled();
    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith({ reason: 'upload' });
  });

  // Past the ticket, the server holds a task row for this upload and a timer
  // that will judge it. The failure names that row, which is how the browser
  // tells this apart from one where nothing on the server ever knew (#186
  // §3.7.3) — and what it keys the retry file by.
  it('names the task row when the bytes failed after the ticket was granted', async () => {
    const deps = makeUploadDeps({
      sendToIngest: vi.fn().mockRejectedValue(new Error('part refused')),
    });

    await runMediaUpload(file, context, deps);

    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith({
      reason: 'upload',
      taskId: TICKET.taskId,
    });
  });

  // Bytes that never reached the edge are the one failure nobody on the server
  // is going to end (#237): the finish needs an upload id the transfer hands
  // back, so it was never asked for and no row will be settled by anyone else.
  // Every other failure past the ticket either reached the ledger — which
  // settles the row before it replies — or left the browser unable to say
  // whether it succeeded.
  it('tells a transfer that never landed apart from a finish that failed', async () => {
    const deps = makeUploadDeps({
      sendToIngest: vi
        .fn()
        .mockRejectedValue(new BytesNotDelivered(new TypeError('Failed to fetch'))),
    });

    await runMediaUpload(file, context, deps);

    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith({
      reason: 'transfer',
      taskId: TICKET.taskId,
    });
  });

  // The edge read the stored bytes and turned them down. Nothing about sending
  // them again changes what they are, so this is told apart from a transfer
  // that broke: the same file re-sent meets the same refusal every time.
  it('names a format the edge refused apart from a transfer that broke', async () => {
    const deps = makeUploadDeps({
      sendToIngest: vi.fn().mockRejectedValue(apiError(415)),
    });

    await runMediaUpload(file, context, deps);

    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith({
      reason: 'unsupportedType',
      taskId: TICKET.taskId,
    });
  });

  // A full account is not something a retry fixes, and the message the user
  // needs is a different one.
  it('names a full account apart from an ordinary failure', async () => {
    const deps = makeUploadDeps({
      requestTicket: vi.fn().mockRejectedValue(apiError(507)),
    });

    await runMediaUpload(file, context, deps);

    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith({ reason: 'storage' });
  });

  it('names a rate limit at once, asking for the ticket only one time', async () => {
    const requestTicket = vi.fn().mockRejectedValue(apiError(429));
    const deps = makeUploadDeps({ requestTicket });

    await runMediaUpload(file, context, deps);

    expect(requestTicket).toHaveBeenCalledOnce();
    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith({ reason: 'rateLimited' });
  });

  it('reports a failure when the knobs cannot be fetched', async () => {
    const deps = makeUploadDeps({
      getUploadConfig: vi.fn().mockRejectedValue(new Error('offline')),
    });

    await runMediaUpload(file, context, deps);

    expect(deps.requestTicket).not.toHaveBeenCalled();
    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith({ reason: 'upload' });
  });

  // A crop is a byproduct with no node: registered for dedup, and told apart
  // from a real upload in the feed.
  it('carries the byproduct flag and leaves out the node context', async () => {
    const deps = makeUploadDeps();

    await runMediaUpload(
      file,
      { projectId: 'p1', derived: true },
      deps,
    );

    expect(deps.requestTicket).toHaveBeenCalledWith({
      filename: 'photo.png',
      contentType: 'image/png',
      projectId: 'p1',
      size: file.size,
      hash: HASH,
      derived: true,
    });
  });
});

describe('uploadMedia — the pipeline wired to the real network, as a promise', () => {
  const file = new File(['x'], 'photo.png', { type: 'image/png' });

  /** Point the production deps at the fixtures. */
  function wire(): void {
    vi.mocked(assetsApi.fetchUploadConfig).mockResolvedValue(CFG);
    vi.mocked(hashFile).mockResolvedValue(HASH);
    vi.mocked(assetsApi.requestUploadTicket).mockResolvedValue(TICKET);
    vi.mocked(sendFileAndFinish).mockResolvedValue({
      assetId: 'asset-new',
      fileUrl: 'https://cdn/p.png',
      kind: 'image',
    });
  }

  it('resolves with what the server filed the upload under', async () => {
    wire();

    await expect(uploadMedia(file, { projectId: 'p1', derived: true })).resolves.toEqual({
      fileUrl: 'https://cdn/p.png',
      assetId: 'asset-new',
      kind: 'image',
    });
    expect(assetsApi.requestUploadTicket).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', derived: true, hash: HASH }),
    );
  });

  it('rejects with the pipeline\'s reason, readable as the message too', async () => {
    wire();
    vi.mocked(assetsApi.requestUploadTicket).mockRejectedValue(apiError(507));

    const failure = await uploadMedia(file, { projectId: 'p1' }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(UploadFailedError);
    expect((failure as UploadFailedError).reason).toBe('storage');
    expect((failure as UploadFailedError).message).toBe('storage');
  });
});
