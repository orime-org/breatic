// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The page's list of uploads still finishing (inner#1367 §4.2a): one timer,
 * one round asking about every upload still waiting, at most
 * `UPLOAD_STATUS_MAX_KEYS` per request.
 */

import { describe, it, expect, vi } from 'vitest';

import type { UploadStatus } from '@breatic/shared';
import { UPLOAD_STATUS_MAX_KEYS } from '@breatic/shared';
import { createUploadStatusList } from '@web/data/upload/upload-status';

/** A list whose timer fires only when the test says so. */
function harness(answers: (keys: readonly string[]) => UploadStatus[] | Error) {
  const asked: string[][] = [];
  const delays: number[] = [];
  let pending: (() => void) | null = null;
  const list = createUploadStatusList({
    fetchStatus: vi.fn(async (keys: readonly string[]) => {
      asked.push([...keys]);
      const answer = answers(keys);
      if (answer instanceof Error) throw answer;
      return { items: answer, retryAfterSeconds: 3 };
    }),
    pollSeconds: async () => 2,
    setTimer: (fire, ms) => {
      delays.push(ms);
      pending = fire;
    },
  });
  /** Fire the scheduled round and let it finish. */
  async function tick(): Promise<void> {
    const fire = pending;
    pending = null;
    fire?.();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }
  return { list, asked, delays, tick, scheduled: () => pending !== null };
}

/** Let the waits started so far reach the timer. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

const done = (key: string): UploadStatus => ({
  key,
  state: 'completed',
  result: { assetId: `a-${key}`, fileUrl: `https://cdn/${key}`, kind: 'image', width: 4, height: 3 },
});

describe('the list of uploads still finishing', () => {
  it('asks once per round and hands each upload its ending', async () => {
    let round = 0;
    const h = harness((keys) => {
      round += 1;
      return keys.map((key) => (round === 1 ? { key, state: 'finishing' } : done(key)));
    });

    const ending = h.list.waitFor('k1');
    await settle();
    await h.tick();
    await h.tick();

    await expect(ending).resolves.toEqual({
      key: 'k1',
      state: 'completed',
      result: { assetId: 'a-k1', fileUrl: 'https://cdn/k1', kind: 'image', width: 4, height: 3 },
    });
    expect(h.asked).toEqual([['k1'], ['k1']]);
  });

  it('carries every waiting upload in one request, and drops the ones that ended', async () => {
    const h = harness((keys) =>
      keys.map((key) => (key === 'k1' ? done(key) : { key, state: 'finishing' })),
    );

    void h.list.waitFor('k1');
    void h.list.waitFor('k2');
    await settle();
    await h.tick();
    await h.tick();

    expect(h.asked).toEqual([['k1', 'k2'], ['k2']]);
  });

  it('takes an upload that joins between rounds into the next one', async () => {
    const h = harness((keys) => keys.map((key) => ({ key, state: 'finishing' as const })));

    void h.list.waitFor('k1');
    await settle();
    await h.tick();
    void h.list.waitFor('k2');
    await settle();
    await h.tick();

    expect(h.asked).toEqual([['k1'], ['k1', 'k2']]);
  });

  it('splits more uploads than one request may carry across requests', async () => {
    const h = harness((keys) => keys.map((key) => ({ key, state: 'finishing' as const })));

    for (let i = 0; i <= UPLOAD_STATUS_MAX_KEYS; i += 1) void h.list.waitFor(`k${i}`);
    await settle();
    await h.tick();

    expect(h.asked.map((keys) => keys.length)).toEqual([UPLOAD_STATUS_MAX_KEYS, 1]);
  });

  it('keeps every upload waiting when a round fails, and asks again', async () => {
    let round = 0;
    const h = harness((keys) => {
      round += 1;
      return round === 1 ? new Error('offline') : keys.map(done);
    });

    const ending = h.list.waitFor('k1');
    await settle();
    await h.tick();
    expect(h.scheduled()).toBe(true);
    await h.tick();

    await expect(ending).resolves.toMatchObject({ state: 'completed' });
  });

  it('waits the configured interval first, then what the last answer said', async () => {
    const h = harness((keys) => keys.map((key) => ({ key, state: 'finishing' as const })));

    void h.list.waitFor('k1');
    await settle();
    await h.tick();

    expect(h.delays).toEqual([2000, 3000]);
  });

  it('stops asking once nothing is waiting', async () => {
    const h = harness((keys) => keys.map(done));

    void h.list.waitFor('k1');
    await settle();
    await h.tick();

    expect(h.scheduled()).toBe(false);
  });

  it('hands an upload the server does not know its ending', async () => {
    const h = harness((keys) => keys.map((key) => ({ key, state: 'unknown' as const })));

    const ending = h.list.waitFor('k1');
    await settle();
    await h.tick();

    await expect(ending).resolves.toEqual({ key: 'k1', state: 'unknown' });
    // Ended, so it leaves the list and nothing is left to ask about.
    expect(h.scheduled()).toBe(false);
  });

  it('hands a failed upload its reason', async () => {
    const h = harness((keys) =>
      keys.map((key) => ({ key, state: 'failed' as const, reason: 'unsupported_type' })),
    );

    const ending = h.list.waitFor('k1');
    await settle();
    await h.tick();

    await expect(ending).resolves.toEqual({ key: 'k1', state: 'failed', reason: 'unsupported_type' });
    expect(h.scheduled()).toBe(false);
  });
});

// inner#1006 W10: a transfer upload ends `transferred`, which carries no
// result. The list hands it over like any other ending and stops asking.
describe('a transfer upload in the list', () => {
  it('ends the wait with transferred and asks no more about that key', async () => {
    let round = 0;
    const h = harness((keys) => {
      round += 1;
      return keys.map((key): UploadStatus =>
        round === 1 ? { key, state: 'finishing' } : { key, state: 'transferred' },
      );
    });

    const ending = h.list.waitFor('transfer/2026-10-24/1_t.transfer');
    await settle();
    await h.tick();
    await h.tick();

    await expect(ending).resolves.toEqual({
      key: 'transfer/2026-10-24/1_t.transfer',
      state: 'transferred',
    });
    expect(h.asked).toEqual([
      ['transfer/2026-10-24/1_t.transfer'],
      ['transfer/2026-10-24/1_t.transfer'],
    ]);
    expect(h.scheduled()).toBe(false);
  });
});
