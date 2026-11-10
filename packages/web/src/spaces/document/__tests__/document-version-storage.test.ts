// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The snapshot storage BlockNote's versioning controller reads (inner#1129
 * design §7.1, §7.4, §7.6): server rows in the controller's shape, refusals
 * as typed results, and a restore that only applies what is on screen.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentVersion } from '@breatic/shared';

import { documentsApi } from '@web/data/api/documents';
import { ApiException } from '@web/data/api/types';
import { createDocumentVersionStorage, type ShownVersion } from '@web/spaces/document/document-version-storage';

vi.mock('@web/data/api/documents', () => ({
  documentsApi: { list: vi.fn(), get: vi.fn(), rename: vi.fn(), remove: vi.fn(), save: vi.fn() },
}));

const api = vi.mocked(documentsApi);
const scope = { projectId: 'p', spaceId: 's' };
const signal = new AbortController().signal;

const row: DocumentVersion = {
  id: 'v1',
  projectId: 'p',
  spaceId: 's',
  name: null,
  schemaVersion: 'x',
  createdAt: '2026-11-10T08:30:00.123456Z',
  updatedAt: '2026-11-10T08:30:00.123456Z',
  createdBy: { id: 'u1', name: 'Mia' },
};

/** A storage over a shown record the test controls. */
function storage(shown: ShownVersion | null = null, apply = vi.fn(() => 'restored' as const), report = vi.fn()) {
  const ref = { current: shown };
  return { storage: createDocumentVersionStorage({ scope, shown: ref, apply, report }), apply, report, ref };
}

/** A refusal as the request layer throws it. */
function refused(status: number, network = false): ApiException {
  return new ApiException({ status, message: 'no', fromServer: !network, network });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createDocumentVersionStorage', () => {
  it('lists rows in the controller shape, newest first as the server sends them', async () => {
    api.list.mockResolvedValueOnce({ versions: [row, { ...row, id: 'v0', name: 'Draft' }], nextCursor: 'c1' });

    const result = await storage().storage.list(signal);

    expect(api.list).toHaveBeenCalledWith(scope, undefined, signal);
    expect(result).toEqual({
      ok: true,
      value: {
        snapshots: [
          { id: 'v1', createdAt: Date.parse(row.createdAt), name: undefined, by: 'u1', metadata: { savedBy: 'Mia' } },
          { id: 'v0', createdAt: Date.parse(row.createdAt), name: 'Draft', by: 'u1', metadata: { savedBy: 'Mia' } },
        ],
        nextCursor: 'c1',
      },
    });
  });

  it('ends the history when the server has no next page', async () => {
    api.list.mockResolvedValueOnce({ versions: [], nextCursor: null });

    const result = await storage().storage.list(signal, 'c1');

    expect(api.list).toHaveBeenCalledWith(scope, 'c1', signal);
    expect(result).toEqual({ ok: true, value: { snapshots: [] } });
  });

  it.each([
    [refused(404), { type: 'not-found' }],
    [refused(403), { type: 'forbidden' }],
    [refused(409), { type: 'conflict' }],
    [refused(0, true), { type: 'network' }],
    [refused(500), { type: 'server', status: 500 }],
  ])('returns a refusal as a typed failure (%#)', async (thrown, error) => {
    api.get.mockRejectedValueOnce(thrown);
    api.rename.mockRejectedValueOnce(thrown);
    api.remove.mockRejectedValueOnce(thrown);
    const { storage: s } = storage();

    expect(await s.getContent('v1', signal)).toEqual({ ok: false, error });
    expect(await s.rename!('v1', 'n')).toEqual({ ok: false, error });
    expect(await s.remove!('v1')).toEqual({ ok: false, error });
  });

  it('lets an unexpected bug reject', async () => {
    api.get.mockRejectedValueOnce(new TypeError('bug'));

    await expect(storage().storage.getContent('v1', signal)).rejects.toThrow('bug');
  });

  it('reads a snapshot body from the server every time', async () => {
    api.get.mockResolvedValue({ version: row, content: { type: 'doc' } });
    const { storage: s } = storage();

    await s.getContent('v1', signal);
    await s.getContent('v1', signal);

    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.get).toHaveBeenCalledWith(scope, 'v1', signal);
  });

  it('clears a name when the controller passes none', async () => {
    api.rename.mockResolvedValueOnce(undefined);

    expect(await storage().storage.rename!('v1', undefined)).toEqual({ ok: true, value: undefined });
    expect(api.rename).toHaveBeenCalledWith(scope, 'v1', null);
  });

  it('restores what is on screen without a request', async () => {
    const content = { type: 'doc', content: [] };
    const { storage: s, apply } = storage({ id: 'v1', content });

    expect(await s.restore!('v1')).toEqual({ ok: true, value: undefined });

    expect(apply).toHaveBeenCalledWith(content);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('refuses to restore a snapshot that is not the one on screen', async () => {
    const { storage: s, apply } = storage({ id: 'v2', content: { type: 'doc' } });

    expect(await s.restore!('v1')).toEqual({ ok: false, error: { type: 'not-found' } });
    expect(await storage(null).storage.restore!('v1')).toEqual({ ok: false, error: { type: 'not-found' } });

    expect(apply).not.toHaveBeenCalled();
  });

  it('keeps the panel when the write throws, reporting it once', async () => {
    const failure = new RangeError('schema');
    const apply = vi.fn(() => {
      throw failure;
    });
    const { storage: s, report } = storage({ id: 'v1', content: { type: 'doc' } }, apply as never);

    expect(await s.restore!('v1')).toEqual({ ok: false, error: { type: 'server', status: 0 } });

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(failure);
  });
});
