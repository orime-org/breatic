// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';

import { ApiException } from '@web/data/api/types';
import { assetsApi } from '@web/data/api/assets';
import { BytesNotDelivered, sendFileAndFinish } from '@web/data/upload/finish-upload';
import { hashFile } from '@web/data/upload/hash';
import { waitForUploadEnding, type UploadEnding } from '@web/data/upload/upload-status';
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
vi.mock('@web/data/upload/upload-status', () => ({ waitForUploadEnding: vi.fn() }));
// W12 runs the real sendFileAndFinish; its two network edges stand in here.
const { sendBytesToIngest, apiPost } = vi.hoisted(() => ({ sendBytesToIngest: vi.fn(), apiPost: vi.fn() }));
vi.mock('@breatic/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@breatic/shared')>()),
  sendBytesToIngest,
}));
vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/request')>()),
  apiPost,
}));

/** The knob fixture threaded through the upload orchestration tests. */
const CFG = {
  maxUploadBytes: 2147483648,
  clientMaxAttempts: 3,
  clientRetryBaseDelayMs: 1000,
  uploadIdleTimeoutMs: 60000,
  uploadStatusPollSeconds: 2,
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
  uploadId: 'upload-1',
  token: 'token-1',
  storageKey: 'image/2026-08-31/p.png',
  uploadUrl: 'https://ingest.example.com',
  kind: 'image',
  partSize: 5 * 1024 * 1024,
  totalParts: 1,
  taskId: 'task-row-1',
};

/** The same ticket for an upload with no node, which opens no task row. */
const { taskId: _noRow, ...TICKET_NO_NODE } = TICKET;

/** What the status query hands a registered upload. */
const COMPLETED = {
  key: TICKET.storageKey,
  state: 'completed' as const,
  result: {
    assetId: 'asset-new',
    fileUrl: 'https://cdn/p.png',
    kind: 'image',
    width: 640,
    height: 480,
  },
};

/** Shared orchestration deps (config + hash + network spies). */
function makeUploadDeps(
  over: Partial<Parameters<typeof runMediaUpload>[2]> = {},
): Parameters<typeof runMediaUpload>[2] {
  return {
    getUploadConfig: vi.fn().mockResolvedValue(CFG),
    hashFile: vi.fn().mockResolvedValue(HASH),
    requestTicket: vi.fn().mockResolvedValue(TICKET),
    sendToIngest: vi.fn().mockResolvedValue({ storageKey: TICKET.storageKey }),
    waitForEnding: vi.fn().mockResolvedValue(COMPLETED),
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

  // inner#1303 §6.7: the ticket is the server's answer, which ends the
  // uploader's wait on the node before the bytes move.
  it('says the server answered once the ticket arrives, before the bytes move', async () => {
    const order: string[] = [];
    const deps = makeUploadDeps({
      onAnswered: vi.fn(() => order.push('answered')),
      sendToIngest: vi.fn(async () => {
        order.push('sent');
        return { storageKey: TICKET.storageKey };
      }),
    });
    await runMediaUpload(file, context, deps);
    expect(order).toEqual(['answered', 'sent']);
  });

  it('says the server answered when the studio already holds the content', async () => {
    const deps = makeUploadDeps({
      onAnswered: vi.fn(),
      requestTicket: vi.fn().mockResolvedValue({ alreadyExists: true, assetId: 'a', fileUrl: 'https://cdn/a.png', kind: 'image' }),
    });
    await runMediaUpload(file, context, deps);
    expect(deps.onAnswered).toHaveBeenCalledOnce();
  });

  it('does not say the server answered when the ticket request fails', async () => {
    const deps = makeUploadDeps({ onAnswered: vi.fn(), requestTicket: vi.fn().mockRejectedValue(apiError(400)) });
    await runMediaUpload(file, context, deps);
    expect(deps.onAnswered).not.toHaveBeenCalled();
    expect(deps.onFailure).toHaveBeenCalledOnce();
  });

  it('reports progress as the share of the file that has landed (inner#1127 A4)', async () => {
    const big = new File([new Uint8Array(400)], 'clip.mp4', { type: 'video/mp4' });
    const onProgress = vi.fn();
    const deps = makeUploadDeps({
      onProgress,
      sendToIngest: vi.fn(async (_file, _ticket, _cfg, onPartLanded?: (n: number) => void) => {
        onPartLanded?.(100);
        onPartLanded?.(400);
        return { storageKey: TICKET.storageKey };
      }),
    });

    await runMediaUpload(big, context, deps);

    expect(onProgress.mock.calls).toEqual([[0.25], [1]]);
  });

  // An upload with no node has no other channel for its result, so it waits
  // on the status query for what the queued finish registered (inner#1367).
  it('hands an upload with no node what its queued finish registered', async () => {
    const deps = makeUploadDeps({ requestTicket: vi.fn().mockResolvedValue(TICKET_NO_NODE) });

    await runMediaUpload(file, { projectId: 'p1', derived: true }, deps);

    expect(deps.waitForEnding).toHaveBeenCalledWith(TICKET.storageKey);
    expect(deps.onSuccess).toHaveBeenCalledExactlyOnceWith({
      fileUrl: 'https://cdn/p.png',
      assetId: 'asset-new',
      kind: 'image',
      width: 640,
      height: 480,
    });
  });

  // A node's content arrives through Yjs, so its upload is over for the page
  // once the finish is queued; holding it open would hold the space open.
  it('ends a node upload once its finish is queued, without waiting for the ending', async () => {
    const deps = makeUploadDeps({
      waitForEnding: vi.fn(() => new Promise<UploadEnding>(() => undefined)),
    });

    await runMediaUpload(file, context, deps);

    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onFailure).not.toHaveBeenCalled();
  });

  it('tells a node upload whose finish failed, naming its task row, once the ending arrives', async () => {
    let end: (ending: UploadEnding) => void = () => undefined;
    const deps = makeUploadDeps({
      waitForEnding: vi.fn(
        () =>
          new Promise<UploadEnding>((resolve) => {
            end = resolve;
          }),
      ),
    });

    await runMediaUpload(file, context, deps);
    end({ key: TICKET.storageKey, state: 'failed', reason: 'assemble_failed' });
    await Promise.resolve();

    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith({
      reason: 'upload',
      taskId: TICKET.taskId,
    });
  });

  it('says nothing more for a node upload whose finish registered', async () => {
    const deps = makeUploadDeps();

    await runMediaUpload(file, context, deps);
    await Promise.resolve();

    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onFailure).not.toHaveBeenCalled();
  });

  it('reports an ending the server does not know as an ordinary failure', async () => {
    const deps = makeUploadDeps({
      requestTicket: vi.fn().mockResolvedValue(TICKET_NO_NODE),
      waitForEnding: vi.fn().mockResolvedValue({ key: TICKET.storageKey, state: 'unknown' }),
    });

    await runMediaUpload(file, { projectId: 'p1' }, deps);

    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith({ reason: 'upload' });
  });

  it('sends nothing when the studio already holds the content', async () => {
    const deps = makeUploadDeps({
      requestTicket: vi.fn().mockResolvedValue({
        alreadyExists: true,
        assetId: 'asset-existing',
        fileUrl: 'https://cdn/existing.png',
        kind: 'image',
        width: 3000,
        height: 4000,
      }),
    });

    await runMediaUpload(file, context, deps);

    expect(deps.sendToIngest).not.toHaveBeenCalled();
    expect(deps.onSuccess).toHaveBeenCalledExactlyOnceWith({
      fileUrl: 'https://cdn/existing.png',
      assetId: 'asset-existing',
      kind: 'image',
      width: 3000,
      height: 4000,
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
    expect(deps.sendToIngest).toHaveBeenCalledOnce();
    expect(deps.onFailure).not.toHaveBeenCalled();
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
      waitForEnding: vi.fn().mockResolvedValue({ key: TICKET.storageKey, state: 'failed', reason: 'unsupported_type' }),
    });

    await runMediaUpload(file, context, deps);
    await Promise.resolve();

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
    vi.mocked(assetsApi.requestUploadTicket).mockResolvedValue(TICKET_NO_NODE);
    vi.mocked(sendFileAndFinish).mockResolvedValue({ storageKey: TICKET.storageKey });
    vi.mocked(waitForUploadEnding).mockResolvedValue(COMPLETED);
  }

  it('resolves with what the server filed the upload under', async () => {
    wire();

    await expect(uploadMedia(file, { projectId: 'p1', derived: true })).resolves.toEqual({
      fileUrl: 'https://cdn/p.png',
      assetId: 'asset-new',
      kind: 'image',
      width: 640,
      height: 480,
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

// inner#1595 §3.5: the server opens the upload at the ingest Worker itself and,
// when that fails, answers 200 `{ openFailed: { reason }, taskId }`. It is an
// answer (the node's wait ends) and the same failure as a transfer that never
// landed: `'transfer'`, naming the row when there is one.
describe('runMediaUpload — the server could not open the upload (inner#1595)', () => {
  const file = new File(['x'], 'photo.png', { type: 'image/png' });
  const context = { projectId: 'p1', nodeId: 'n1', spaceId: 's1' };

  it('W01 hears the answer first, then fails as a transfer naming the row, and sends nothing', async () => {
    const deps = makeUploadDeps({
      onAnswered: vi.fn(),
      requestTicket: vi.fn().mockResolvedValue({ openFailed: { reason: 'ingest_no_answer' }, taskId: 't1' }),
    });

    await runMediaUpload(file, context, deps);

    expect(deps.requestTicket).toHaveBeenCalledOnce();
    expect(deps.onAnswered).toHaveBeenCalledOnce();
    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith({ reason: 'transfer', taskId: 't1' });
    expect(vi.mocked(deps.onAnswered!).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.onFailure).mock.invocationCallOrder[0]!,
    );
    expect(deps.sendToIngest).not.toHaveBeenCalled();
    expect(deps.onSuccess).not.toHaveBeenCalled();
  });

  it('W02 with no row: answers first, then fails as a transfer with no taskId key', async () => {
    const deps = makeUploadDeps({
      onAnswered: vi.fn(),
      requestTicket: vi.fn().mockResolvedValue({ openFailed: { reason: 'ingest_refused' } }),
    });

    await runMediaUpload(file, context, deps);

    expect(deps.onAnswered).toHaveBeenCalledOnce();
    expect(deps.onFailure).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.onFailure).mock.calls[0]![0]).toStrictEqual({ reason: 'transfer' });
    expect(vi.mocked(deps.onAnswered!).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.onFailure).mock.invocationCallOrder[0]!,
    );
    expect(deps.sendToIngest).not.toHaveBeenCalled();
  });

  // The answer is a 200, so retryTransient (>= 500 only) does not ask again
  // and open a second grant and task row (design §3.4).
  it('W03 asks no more after a 5xx is followed by openFailed', async () => {
    const requestTicket = vi
      .fn()
      .mockRejectedValueOnce(apiError(503))
      .mockResolvedValue({ openFailed: { reason: 'ingest_no_answer' }, taskId: 't1' });
    const deps = makeUploadDeps({ requestTicket });

    await runMediaUpload(file, context, deps);

    expect(requestTicket).toHaveBeenCalledTimes(2);
    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith({ reason: 'transfer', taskId: 't1' });
    expect(deps.sendToIngest).not.toHaveBeenCalled();
  });

  // Acceptance 3, the browser's ordinary path: a ticket in the new shape is
  // sent and finished through the real sendFileAndFinish.
  it('W12 sends a new-shape ticket through the real finish and returns without waiting for the ending', async () => {
    const { sendFileAndFinish: realSendFileAndFinish } = await vi.importActual<typeof import('@web/data/upload/finish-upload')>('@web/data/upload/finish-upload');
    const HELD = { uploadId: 'upload-1', token: 'token-last', parts: [{ partNumber: 1, etag: 'e1' }] };
    sendBytesToIngest.mockReset().mockResolvedValue(HELD);
    apiPost.mockReset().mockResolvedValue({ storageKey: TICKET.storageKey });
    expect(TICKET).not.toHaveProperty('ticket');
    const deps = makeUploadDeps({
      onAnswered: vi.fn(),
      sendToIngest: realSendFileAndFinish,
      waitForEnding: vi.fn(() => new Promise<UploadEnding>(() => undefined)),
    });

    await runMediaUpload(file, context, deps);

    expect(deps.onAnswered).toHaveBeenCalledOnce();
    expect(sendBytesToIngest).toHaveBeenCalledOnce();
    expect(sendBytesToIngest.mock.calls[0]![1]).toMatchObject({
      uploadUrl: TICKET.uploadUrl,
      uploadId: TICKET.uploadId,
      token: TICKET.token,
      partSize: TICKET.partSize,
      totalParts: TICKET.totalParts,
    });
    expect(sendBytesToIngest.mock.calls[0]![1]).not.toHaveProperty('ticket');
    const completes = apiPost.mock.calls.filter(([url]) => url === `/assets/uploads/${HELD.uploadId}/complete`);
    expect(completes).toHaveLength(1);
    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onFailure).not.toHaveBeenCalled();
  });
});
