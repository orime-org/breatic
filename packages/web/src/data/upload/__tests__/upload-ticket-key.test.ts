// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * One key per file per user action on the upload ticket (inner#1968 design
 * 3.2 "web side", test spec B-66, B-78 to B-81).
 *
 * Each file's ticket request carries an operation id, a UUID the page mints
 * before asking (`UploadTicketRequest.operationId`), sent as the request's
 * `Idempotency-Key`. Resends follow the chat send's `resendWait` rule: a 409
 * `in_progress`, a network error or a 5xx without `Idempotency-Status: done`
 * leave the outcome unknown and are resent with the same key until the
 * `upload-ticket` scope's deadline; a 5xx carrying `done` is final for that
 * key, whose admission the server already released, so the page tries again
 * with a fresh key, at most `clientMaxAttempts` times. A user pressing retry
 * starts a new operation and so a new key.
 */

import { describe, expect, it, vi } from 'vitest';
import { IDEMPOTENCY_SCOPES } from '@breatic/shared';

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));
vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  apiPost,
}));

import { assetsApi } from '@web/data/api/assets';
import { ApiException } from '@web/data/api/types';
import { runMediaUpload } from '@web/data/upload/media-upload';
import type { UploadTicketRequest } from '@web/data/upload/ingest-upload';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ATTEMPTS = 3;
const CFG = {
  maxUploadBytes: 2147483648,
  clientMaxAttempts: MAX_ATTEMPTS,
  clientRetryBaseDelayMs: 1000,
  uploadIdleTimeoutMs: 60000,
  uploadStatusPollSeconds: 2,
  assetUrlPrefix: 'https://cdn/',
};
const TICKET = {
  uploadId: 'upload-1',
  token: 'token-1',
  storageKey: 'image/2026-11-16/p.png',
  uploadUrl: 'https://ingest.example.com',
  kind: 'image',
  partSize: 5 * 1024 * 1024,
  totalParts: 1,
  taskId: 'task-row-1',
};
const FILE = new File(['x'], 'photo.png', { type: 'image/png' });
const CONTEXT = { projectId: 'p1', nodeId: 'n1', spaceId: 's1' };

/**
 * Upload dependencies whose ticket request answers as given.
 * @param requestTicket - The ticket request double.
 * @returns The dependencies.
 */
function deps(requestTicket: ReturnType<typeof vi.fn>): Parameters<typeof runMediaUpload>[2] {
  return {
    getUploadConfig: vi.fn().mockResolvedValue(CFG),
    hashFile: vi.fn().mockResolvedValue('a'.repeat(64)),
    requestTicket,
    sendToIngest: vi.fn().mockResolvedValue({ storageKey: TICKET.storageKey }),
    // The finish's ending is not under test; it never arrives.
    waitForEnding: vi.fn(() => new Promise<never>(() => {})),
    onSuccess: vi.fn(),
    onFailure: vi.fn(),
    sleep: () => Promise.resolve(),
  };
}

/**
 * The operation id each ticket request carried, in call order.
 * @param requestTicket - The ticket request double.
 * @returns The ids.
 */
function keysOf(requestTicket: ReturnType<typeof vi.fn>): unknown[] {
  return requestTicket.mock.calls.map((call) => (call[0] as UploadTicketRequest & { operationId?: unknown }).operationId);
}

const IN_PROGRESS = new ApiException({ status: 409, message: 'in progress', idempotencyStatus: 'in_progress' });
const DONE_5XX = new ApiException({ status: 503, message: 'released', idempotencyStatus: 'done' });
const NETWORK = new ApiException({ status: 0, message: 'Network Error', network: true });

describe('the ticket request carries the operation id as its Idempotency-Key', () => {
  it('sends params.operationId as the Idempotency-Key header and no client timeout', async () => {
    apiPost.mockResolvedValue(TICKET);
    const key = crypto.randomUUID();
    await assetsApi.requestUploadTicket({ filename: 'p.png', contentType: 'image/png', projectId: 'p1', size: 1, hash: 'a'.repeat(64), operationId: key } as UploadTicketRequest);
    const config = apiPost.mock.calls.at(-1)![2] as { headers?: Record<string, string>; timeout?: number };
    expect(config.headers?.['Idempotency-Key']).toBe(key);
    expect(config.timeout).toBe(0);
  });

  it('upload-ticket is a run-once scope', () => {
    expect(IDEMPOTENCY_SCOPES).toContain('upload-ticket');
  });

  it('B-66 a derived ticket body carries derived and space_id, and no node_id', async () => {
    apiPost.mockResolvedValue(TICKET);
    await assetsApi.requestUploadTicket({ filename: 'crop.png', contentType: 'image/png', projectId: 'p1', spaceId: 's1', size: 1, hash: 'a'.repeat(64), derived: true });
    const body = apiPost.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(body).toMatchObject({ derived: true, space_id: 's1' });
    expect(body).not.toHaveProperty('node_id');
  });
});

describe('runMediaUpload resends the ticket request by the run-once rule', () => {
  it('B-78 a 409 in_progress is resent with the same key, past clientMaxAttempts, until the ticket arrives', async () => {
    const requestTicket = vi.fn()
      .mockRejectedValueOnce(IN_PROGRESS)
      .mockRejectedValueOnce(IN_PROGRESS)
      .mockRejectedValueOnce(IN_PROGRESS)
      .mockResolvedValue(TICKET);
    const d = deps(requestTicket);
    await runMediaUpload(FILE, CONTEXT, d);

    expect(requestTicket).toHaveBeenCalledTimes(MAX_ATTEMPTS + 1);
    const keys = keysOf(requestTicket);
    expect(keys[0]).toMatch(UUID);
    expect(new Set(keys)).toEqual(new Set([keys[0]]));
    expect(d.sendToIngest).toHaveBeenCalledOnce();
    expect(d.onFailure).not.toHaveBeenCalled();
  });

  it('B-79 a 5xx marked done is not resent under its key: each try takes a fresh key', async () => {
    const requestTicket = vi.fn().mockRejectedValueOnce(DONE_5XX).mockRejectedValueOnce(DONE_5XX).mockResolvedValue(TICKET);
    const d = deps(requestTicket);
    await runMediaUpload(FILE, CONTEXT, d);

    expect(requestTicket).toHaveBeenCalledTimes(3);
    const keys = keysOf(requestTicket);
    for (const key of keys) expect(key).toMatch(UUID);
    expect(new Set(keys).size).toBe(3);
    expect(d.sendToIngest).toHaveBeenCalledOnce();
  });

  it('B-79 fresh keys stop at clientMaxAttempts, then the upload fails', async () => {
    const requestTicket = vi.fn().mockRejectedValue(DONE_5XX);
    const d = deps(requestTicket);
    await runMediaUpload(FILE, CONTEXT, d);

    expect(requestTicket).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    const keys = keysOf(requestTicket);
    for (const key of keys) expect(key).toMatch(UUID);
    expect(new Set(keys).size).toBe(MAX_ATTEMPTS);
    expect(d.sendToIngest).not.toHaveBeenCalled();
    expect(d.onFailure).toHaveBeenCalledExactlyOnceWith({ reason: 'upload' });
  });

  it('B-80 after a network error the request is resent with the same key', async () => {
    const requestTicket = vi.fn().mockRejectedValueOnce(NETWORK).mockResolvedValue(TICKET);
    const d = deps(requestTicket);
    await runMediaUpload(FILE, CONTEXT, d);

    expect(requestTicket).toHaveBeenCalledTimes(2);
    const [first, second] = keysOf(requestTicket);
    expect(first).toMatch(UUID);
    expect(second).toBe(first);
    expect(d.sendToIngest).toHaveBeenCalledOnce();
  });

  it('B-81 the user retrying the upload asks under a new key', async () => {
    const requestTicket = vi.fn().mockRejectedValueOnce(new ApiException({ status: 400, message: 'refused', idempotencyStatus: 'done' })).mockResolvedValue(TICKET);
    const d = deps(requestTicket);
    await runMediaUpload(FILE, CONTEXT, d);
    expect(d.onFailure).toHaveBeenCalledOnce();
    await runMediaUpload(FILE, CONTEXT, d);

    expect(requestTicket).toHaveBeenCalledTimes(2);
    const [first, second] = keysOf(requestTicket);
    expect(first).toMatch(UUID);
    expect(second).toMatch(UUID);
    expect(second).not.toBe(first);
  });
});
