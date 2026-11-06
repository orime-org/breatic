// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it, vi } from 'vitest';
import type { UploadStatus } from '@breatic/shared';
import { createUploadStatusList } from '@web/data/upload/upload-status';
import type { UploadStatusList } from '@web/data/upload/upload-status';

interface StatusHarness {
  list: UploadStatusList;
  asked: string[][];
  tick: () => Promise<void>;
  scheduled: () => boolean;
}

/**
 * Drain promise continuations without advancing the injected polling clock.
 * @throws {never} Never.
 */
async function settle(): Promise<void> {
  for (let step = 0; step < 10; step += 1) await Promise.resolve();
}

/**
 * Keep polling under the test's control, including an answer still in flight.
 * @throws {never} Never directly.
 */
function harness(answer: (keys: readonly string[]) => UploadStatus[] | Promise<UploadStatus[]>): StatusHarness {
  const asked: string[][] = [];
  let pending: (() => void) | null = null;
  const list = createUploadStatusList({
    fetchStatus: async (keys) => {
      asked.push([...keys]);
      return { items: await answer(keys), retryAfterSeconds: 1 };
    },
    pollSeconds: async () => 1,
    setTimer: (fire) => { pending = fire; },
  });
  return {
    list,
    asked,
    tick: async () => {
      const fire = pending;
      pending = null;
      fire?.();
      await settle();
    },
    scheduled: () => pending !== null,
  };
}

/**
 * Return the registered asset result the ordinary upload status API supplies.
 * @throws {never} Never.
 */
function completed(key: string): UploadStatus {
  return { key, state: 'completed', result: {
    assetId: `asset-${key}`, fileUrl: `https://assets.example/${key}`, kind: 'file', width: null, height: null,
  } };
}

describe('document-owned upload status observers (inner#1690)', () => {
  it('rejects an already aborted observer without scheduling its upload', async () => {
    const h = harness((keys) => keys.map(completed));
    const abort = new AbortController();
    abort.abort();
    const rejected = vi.fn();
    void h.list.waitFor('closed', abort.signal).catch(rejected);
    await settle();

    expect(rejected).toHaveBeenCalledTimes(1);
    expect(rejected.mock.calls[0]?.[0]).toMatchObject({ name: 'AbortError' });
    expect(h.asked).toEqual([]);
    expect(h.scheduled()).toBe(false);
  });

  it.each([0, 1])('cancels observer %i without ending its peer for the same upload', async (cancelledIndex) => {
    const h = harness((keys) => keys.map(completed));
    const owners = [new AbortController(), new AbortController()];
    const outcomes = owners.map((owner) => h.list.waitFor('shared', owner.signal));
    const cancelled = outcomes[cancelledIndex];
    const survivor = outcomes[1 - cancelledIndex];
    const rejected = vi.fn();
    void cancelled.catch(rejected);
    const otherUpload = h.list.waitFor('other');
    owners[cancelledIndex].abort();
    await settle();

    expect(rejected).toHaveBeenCalledTimes(1);
    expect(rejected.mock.calls[0]?.[0]).toMatchObject({ name: 'AbortError' });
    await h.tick();
    await expect(survivor).resolves.toEqual(completed('shared'));
    await expect(otherUpload).resolves.toEqual(completed('other'));
    expect(h.asked).toEqual([['shared', 'other']]);
    expect(h.scheduled()).toBe(false);
  });

  it('removes a cancelled last observer from subsequent batches while another upload continues', async () => {
    let round = 0;
    const h = harness((keys) => {
      round += 1;
      return keys.map((key): UploadStatus => round === 1 ? { key, state: 'finishing' } : completed(key));
    });
    const abort = new AbortController();
    const rejected = vi.fn();
    void h.list.waitFor('closed', abort.signal).catch(rejected);
    const otherUpload = h.list.waitFor('open');
    await settle();
    await h.tick();
    abort.abort();
    await settle();

    expect(rejected).toHaveBeenCalledTimes(1);
    expect(rejected.mock.calls[0]?.[0]).toMatchObject({ name: 'AbortError' });
    await h.tick();
    await expect(otherUpload).resolves.toEqual(completed('open'));
    expect(h.asked).toEqual([['closed', 'open'], ['open']]);
    expect(h.scheduled()).toBe(false);
  });

  it('delivers an in-flight answer to remaining observers after one document cancels', async () => {
    const answer = Promise.withResolvers<UploadStatus[]>();
    const h = harness(() => answer.promise);
    const abort = new AbortController();
    const rejected = vi.fn();
    void h.list.waitFor('shared', abort.signal).catch(rejected);
    const survivor = h.list.waitFor('shared');
    const otherUpload = h.list.waitFor('other');
    await settle();
    await h.tick();
    expect(h.asked).toEqual([['shared', 'other']]);
    abort.abort();
    await settle();

    expect(rejected).toHaveBeenCalledTimes(1);
    expect(rejected.mock.calls[0]?.[0]).toMatchObject({ name: 'AbortError' });
    answer.resolve([completed('shared'), completed('other')]);
    await settle();
    await expect(survivor).resolves.toEqual(completed('shared'));
    await expect(otherUpload).resolves.toEqual(completed('other'));
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(h.scheduled()).toBe(false);
  });

  it('keeps a later observer when a completed observer is subsequently aborted', async () => {
    const h = harness((keys) => keys.map(completed));
    const oldOwner = new AbortController();
    const first = h.list.waitFor('shared', oldOwner.signal);
    await settle();
    await h.tick();
    await expect(first).resolves.toEqual(completed('shared'));

    const reopened = h.list.waitFor('shared');
    await settle();
    oldOwner.abort();
    await h.tick();

    await expect(reopened).resolves.toEqual(completed('shared'));
    expect(h.asked).toEqual([['shared'], ['shared']]);
    expect(h.scheduled()).toBe(false);
  });
});
