// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * An upload is waited for from the moment its ticket names the key, before any byte moves (#1580, test spec J-01,
 * J-03, J-05, J-07 to J-10, J-20; design §3): the finish job may end before the finish request returns, and the
 * ending must find its waiter already there. A failed send, a failed finish or a stop takes the registration back,
 * so an ending arriving later is handed to no one. The page's real table is used; only the network is stubbed.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { UploadClientConfig, UploadStatus } from '@breatic/shared';
import type { UploadContext, UploadTicket, UploadTicketRequest, UploadTicketResponse } from '@web/data/upload/ingest-upload';
import { runMediaUpload } from '@web/data/upload/media-upload';
import { settleUploadEnding, waitingUploadKeys } from '@web/data/upload/upload-status';

const CONFIG: UploadClientConfig = {
  maxUploadBytes: 2147483648, clientMaxAttempts: 3, clientRetryBaseDelayMs: 1000, uploadIdleTimeoutMs: 60000,
};
const FILE = new File(['png'], 'shot.png', { type: 'image/png' });
const CONTEXT: UploadContext = { projectId: 'project-1', derived: true };
const HASH = 'b'.repeat(64);

let n = 0;
/**
 * A ticket under a key no earlier case used.
 * @param extra - Fields the answer adds (a task row).
 * @returns The ticket.
 */
function ticket(extra: Partial<UploadTicket> & { taskId?: string } = {}): UploadTicket & { taskId?: string } {
  n += 1;
  return {
    uploadId: `upload-${n}`, token: `token-${n}`, storageKey: `uploads/w-${n}.png`,
    uploadUrl: 'https://ingest.example.test', kind: 'image', partSize: 8388608, totalParts: 1, ...extra,
  };
}

/**
 * A completed ending for `key`.
 * @param key - The key.
 * @returns The ending.
 */
function completed(key: string): Extract<UploadStatus, { state: 'completed' }> {
  return {
    key, state: 'completed',
    result: { assetId: `asset-${key}`, fileUrl: `https://assets.example.test/${key}`, kind: 'image', width: 64, height: 48 },
  };
}

/**
 * Hold an answer until the test gives it.
 * @returns The promise and its two ends.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

interface Deps {
  getUploadConfig: Mock<() => Promise<UploadClientConfig>>;
  hashFile: Mock<(file: File, signal?: AbortSignal) => Promise<string | null>>;
  requestTicket: Mock<(params: UploadTicketRequest, signal?: AbortSignal) => Promise<UploadTicketResponse>>;
  sendToIngest: Mock<(file: File, t: UploadTicket, c: UploadClientConfig, p?: (b: number) => void, s?: AbortSignal) => Promise<{ storageKey: string }>>;
  onAnswered: Mock<() => void>;
  onRegistering: Mock<() => void>;
  onRegistered: Mock<() => void>;
  onSuccess: Mock<(stored: unknown) => void>;
  onFailure: Mock<(outcome: unknown) => void>;
  sleep: Mock<() => Promise<void>>;
}

/**
 * The network for one upload answering `answer`, with no stand-in for the wait: the page's own table is used.
 * @param answer - What the ticket request answers.
 * @returns The dependencies.
 */
function deps(answer: UploadTicketResponse): Deps {
  return {
    getUploadConfig: vi.fn(async () => CONFIG),
    hashFile: vi.fn(async () => HASH),
    requestTicket: vi.fn(async () => answer),
    sendToIngest: vi.fn(async (_f: File, t: UploadTicket) => ({ storageKey: t.storageKey })),
    onAnswered: vi.fn(), onRegistering: vi.fn(), onRegistered: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn(),
    sleep: vi.fn(async () => undefined),
  };
}

describe('waiting from the ticket', () => {
  it('J-01 registers the ticket\'s key before the first byte is sent', async () => {
    const t = ticket();
    const d = deps(t);
    const registeredWhenSent: boolean[] = [];
    d.sendToIngest.mockImplementation(async (_f, sent) => {
      registeredWhenSent.push(waitingUploadKeys().includes(sent.storageKey));
      return { storageKey: sent.storageKey };
    });
    const running = runMediaUpload(FILE, CONTEXT, d);
    await vi.waitFor(() => expect(d.sendToIngest).toHaveBeenCalled());
    expect(registeredWhenSent).toEqual([true]);
    settleUploadEnding(completed(t.storageKey));
    await running;
  });

  it('J-03 and J-10 an ending that arrives while the bytes are still going is the result once they are in', async () => {
    const t = ticket();
    const d = deps(t);
    const send = deferred<{ storageKey: string }>();
    d.sendToIngest.mockReturnValue(send.promise);
    const running = runMediaUpload(FILE, CONTEXT, d);
    await vi.waitFor(() => expect(d.sendToIngest).toHaveBeenCalled());
    settleUploadEnding(completed(t.storageKey));
    expect(d.onSuccess).not.toHaveBeenCalled();
    send.resolve({ storageKey: t.storageKey });
    await running;
    expect(d.onSuccess).toHaveBeenCalledExactlyOnceWith(completed(t.storageKey).result);
    expect(d.onFailure).not.toHaveBeenCalled();
  });

  it('J-10 a failed ending is the failure its reason names', async () => {
    const t = ticket();
    const d = deps(t);
    const running = runMediaUpload(FILE, CONTEXT, d);
    await vi.waitFor(() => expect(d.onRegistering).toHaveBeenCalled());
    settleUploadEnding({ key: t.storageKey, state: 'failed', reason: 'unsupported_type' });
    await running;
    expect(d.onFailure).toHaveBeenCalledExactlyOnceWith({ reason: 'unsupportedType' });
    expect(d.onSuccess).not.toHaveBeenCalled();
  });
});

describe('taking the registration back', () => {
  it('J-05 when sending the bytes fails: the failure is reported as before and a later ending reaches no one', async () => {
    const t = ticket();
    const d = deps(t);
    d.sendToIngest.mockRejectedValue(new Error('network'));
    await runMediaUpload(FILE, CONTEXT, d);
    expect(waitingUploadKeys()).not.toContain(t.storageKey);
    expect(d.onFailure).toHaveBeenCalledTimes(1);
    settleUploadEnding(completed(t.storageKey));
    await Promise.resolve();
    expect(d.onSuccess).not.toHaveBeenCalled();
  });

  it('J-07 when the upload is stopped while the bytes go', async () => {
    const t = ticket();
    const d = deps(t);
    const stop = new AbortController();
    d.sendToIngest.mockImplementation(async () => {
      stop.abort();
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    await expect(runMediaUpload(FILE, CONTEXT, d, stop.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(waitingUploadKeys()).not.toContain(t.storageKey);
    settleUploadEnding(completed(t.storageKey));
    await Promise.resolve();
    expect(d.onSuccess).not.toHaveBeenCalled();
  });

  it('J-08 when the upload is stopped after the finish was queued', async () => {
    const t = ticket();
    const d = deps(t);
    const stop = new AbortController();
    const running = runMediaUpload(FILE, CONTEXT, d, stop.signal);
    await vi.waitFor(() => expect(d.onRegistering).toHaveBeenCalled());
    stop.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(waitingUploadKeys()).not.toContain(t.storageKey);
  });
});

describe('answers that move no bytes', () => {
  it('J-09 a copy the studio already holds registers nothing', async () => {
    const d = deps({ alreadyExists: true, assetId: 'a-old', fileUrl: 'https://assets.example.test/old.png', kind: 'image', width: 1, height: 1 });
    const before = waitingUploadKeys().length;
    await runMediaUpload(FILE, CONTEXT, d);
    expect(waitingUploadKeys()).toHaveLength(before);
    expect(d.onSuccess).toHaveBeenCalledTimes(1);
  });

  it('J-09 an upload our server could not open registers nothing', async () => {
    const d = deps({ openFailed: { reason: 'worker_unreachable' }, taskId: 'task-1' });
    const before = waitingUploadKeys().length;
    await runMediaUpload(FILE, CONTEXT, d);
    expect(waitingUploadKeys()).toHaveLength(before);
    expect(d.sendToIngest).not.toHaveBeenCalled();
    expect(d.onFailure).toHaveBeenCalledExactlyOnceWith({ reason: 'transfer', taskId: 'task-1' });
  });

  it('a Document block\'s upload, over for the page once the server has it, leaves nothing waiting', async () => {
    const t = ticket();
    const d = deps(t);
    const onHandedOff = vi.fn();
    await runMediaUpload(FILE, CONTEXT, { ...d, onHandedOff });
    expect(onHandedOff).toHaveBeenCalledTimes(1);
    expect(waitingUploadKeys()).not.toContain(t.storageKey);
  });
});

describe('an upload with a task row (a canvas node)', () => {
  it('J-20 a failed ending is told with the row', async () => {
    const t = ticket({ taskId: 'task-9' });
    const d = deps(t);
    await runMediaUpload(FILE, CONTEXT, d);
    settleUploadEnding({ key: t.storageKey, state: 'failed', reason: 'over_cap' });
    await vi.waitFor(() => expect(d.onFailure).toHaveBeenCalledExactlyOnceWith({ reason: 'upload', taskId: 'task-9' }));
    expect(d.onRegistered).not.toHaveBeenCalled();
  });

  it('J-20 a completed ending says the row holds the result', async () => {
    const t = ticket({ taskId: 'task-10' });
    const d = deps(t);
    await runMediaUpload(FILE, CONTEXT, d);
    settleUploadEnding(completed(t.storageKey));
    await vi.waitFor(() => expect(d.onRegistered).toHaveBeenCalledTimes(1));
    expect(d.onFailure).not.toHaveBeenCalled();
  });
});
