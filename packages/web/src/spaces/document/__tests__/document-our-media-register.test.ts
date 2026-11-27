// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Our media entering a body are registered for this Project in one paste request (inner#2171 design §5.2, §10):
 * an address the answer maps lands as the mapped address, one the answer leaves out keeps its own address as a canvas
 * paste does, a failed request fails every block of the batch, and an address of ours that arrives as a plain
 * address joins the same batch.
 */

import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import { ApiException } from '@web/data/api/types';
import { createUploadSources, type UploadSourceDeps } from '@web/spaces/document/document-upload-sources';

const PREFIX = 'https://cdn.example/';
const noProgress = (): void => {};

/**
 * Sources whose paste request the test answers.
 * @param register - The answer.
 * @returns The run function and its deps.
 */
function sources(register: UploadSourceDeps['register']): { run: ReturnType<typeof createUploadSources>; deps: UploadSourceDeps } {
  const deps: UploadSourceDeps = {
    uploadFile: vi.fn(async () => {}),
    ingest: vi.fn(async () => {}),
    register: vi.fn(register),
    assetUrlPrefix: vi.fn(async () => PREFIX),
    readAddress: vi.fn(async () => new Blob(['x'])),
    sleep: vi.fn(async () => {}),
  };
  return { run: createUploadSources(deps), deps };
}

describe('our media registered for this Project (inner#2171)', () => {
  it('keeps the own address of one the answer leaves out', async () => {
    const url = `${PREFIX}gone.png`;
    const { run } = sources(async () => ({}));
    expect(await run('u1', { kind: 'ours', url }, noProgress)).toEqual({ ok: true, result: { url } });
  });

  it('fails every block of the batch when the request is refused', async () => {
    const { run } = sources(async () => { throw new ApiException({ status: 507, message: 'full' }); });
    const outcomes = await Promise.all([run('u1', { kind: 'ours', url: `${PREFIX}a.png` }, noProgress), run('u2', { kind: 'ours', url: `${PREFIX}b.png` }, noProgress)]);
    expect(outcomes.every((outcome) => !outcome.ok)).toBe(true);
  });

  it('registers an address of ours that arrives as a plain address, in the same batch', async () => {
    const { run, deps } = sources(async ({ urls }) => Object.fromEntries(urls.map((u) => [u, `${u}?copy`])));
    const outcomes = await Promise.all([
      run('u1', { kind: 'address', url: `${PREFIX}a.png` }, noProgress),
      run('u2', { kind: 'ours', url: `${PREFIX}b.png` }, noProgress),
    ]);
    expect(deps.register).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.register).mock.calls[0]![0].urls.sort()).toEqual([`${PREFIX}a.png`, `${PREFIX}b.png`]);
    expect(outcomes).toEqual([{ ok: true, result: { url: `${PREFIX}a.png?copy` } }, { ok: true, result: { url: `${PREFIX}b.png?copy` } }]);
  });

  it('lands every block as the mapped address or its own, sending one request per batch', async () => {
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(fc.integer({ min: 0, max: 50 }), { minLength: 1, maxLength: 6 }).chain((ids) => fc.tuple(fc.constant(ids), fc.subarray(ids))),
      async ([ids, mapped]) => {
        const { run, deps } = sources(async ({ urls }) => Object.fromEntries(urls.filter((u) => mapped.some((id) => u.endsWith(`/${id}.png`))).map((u) => [u, `${u}?copy`])));
        const outcomes = await Promise.all(ids.map((id) => run(`u${id}`, { kind: 'ours', url: `${PREFIX}${id}.png` }, noProgress)));
        expect(deps.register).toHaveBeenCalledTimes(1);
        ids.forEach((id, index) => {
          const url = `${PREFIX}${id}.png`;
          expect(outcomes[index]).toEqual({ ok: true, result: { url: mapped.includes(id) ? `${url}?copy` : url } });
        });
      },
    ), { numRuns: 100 });
  });
});
