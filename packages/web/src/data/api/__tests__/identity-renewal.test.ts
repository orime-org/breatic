// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Keeping the identity token fresh (inner#1955). The token lives sixty
 * seconds, so a build with several regions renews it every 45 seconds in the
 * background; a hidden tab's timers are slowed, so a region that answers 401
 * with `identity_expired` gets one renewal and one retry of the same request.
 * A build with one region never renews.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';
import { AxiosError } from 'axios';

const checkStaleRelease = vi.hoisted(() => vi.fn((_reason: unknown) => Promise.resolve(false)));
vi.mock('@web/data/deployment/stale-release', () => ({ checkStaleRelease }));

import { request } from '@web/data/api/request';
import { IDENTITY_RENEW_INTERVAL_MS, startIdentityRenewal } from '@web/data/api/identity-renewal';
import { parseRegionConfig } from '@web/data/api/regions';

const TWO_REGIONS = parseRegionConfig(
  JSON.stringify({
    global: 'us-west',
    regions: {
      'us-west': { api: 'https://us.example.test/api/v1', collab: 'wss://us.example.test/collab' },
      sg: { api: 'https://sg.example.test/api/v1', collab: 'wss://sg.example.test/collab' },
    },
  }),
);

/** Requests the stand-in adapter saw, by full URL. */
let seen: string[] = [];

/**
 * An adapter answering from a queue of statuses per URL suffix.
 * @param answers - For each path, the statuses and reasons to answer in turn.
 * @returns The adapter.
 */
function adapter(answers: Record<string, Array<{ status: number; reason?: string }>>): AxiosAdapter {
  return async (config: InternalAxiosRequestConfig) => {
    const url = `${config.baseURL ?? ''}${config.url ?? ''}`;
    seen.push(url);
    const key = Object.keys(answers).find((suffix) => url.endsWith(suffix));
    const next = key === undefined ? { status: 200 } : (answers[key]!.shift() ?? { status: 200 });
    const response = {
      data: next.status < 400 ? { data: { ok: true } } : { error: { code: next.status, message: 'no', reason: next.reason } },
      status: next.status,
      statusText: String(next.status),
      headers: {},
      config,
    };
    if (next.status >= 400) {
      throw new AxiosError('failed', String(next.status), config, undefined, response);
    }
    return response;
  };
}

let originalAdapter: typeof request.defaults.adapter;

beforeEach(() => {
  seen = [];
  originalAdapter = request.defaults.adapter;
});

afterEach(() => {
  request.defaults.adapter = originalAdapter;
  vi.useRealTimers();
});

describe('startIdentityRenewal', () => {
  it('renews every 45 seconds in a build with several regions and stops when asked', async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => undefined);

    const stop = startIdentityRenewal(renew, TWO_REGIONS);
    expect(IDENTITY_RENEW_INTERVAL_MS).toBe(45_000);
    await vi.advanceTimersByTimeAsync(45_000 * 3);
    expect(renew).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(45_000 * 2);
    expect(renew).toHaveBeenCalledTimes(3);
  });

  it('never renews in a build with one region', async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => undefined);

    const stop = startIdentityRenewal(renew, null);
    await vi.advanceTimersByTimeAsync(45_000 * 3);

    expect(renew).not.toHaveBeenCalled();
    stop();
  });
});

describe('retrying after identity_expired', () => {
  it('renews at the global region once and retries the same request', async () => {
    request.defaults.adapter = adapter({ '/projects/p1': [{ status: 401, reason: 'identity_expired' }, { status: 200 }] });

    const res = await request.get('/projects/p1', { baseURL: 'https://sg.example.test/api/v1' });

    expect(res.status).toBe(200);
    expect(seen).toEqual([
      'https://sg.example.test/api/v1/projects/p1',
      expect.stringMatching(/\/auth\/identity$/),
      'https://sg.example.test/api/v1/projects/p1',
    ]);
  });

  it('gives up after one renewal when the retry is refused again', async () => {
    request.defaults.adapter = adapter({
      '/projects/p1': [
        { status: 401, reason: 'identity_expired' },
        { status: 401, reason: 'identity_expired' },
      ],
    });

    await expect(request.get('/projects/p1', { baseURL: 'https://sg.example.test/api/v1' })).rejects.toBeDefined();
    expect(seen.filter((url) => url.endsWith('/auth/identity'))).toHaveLength(1);
  });

  it('does not renew for any other 401', async () => {
    request.defaults.adapter = adapter({ '/projects/p1': [{ status: 401 }] });

    await expect(request.get('/projects/p1', { baseURL: 'https://sg.example.test/api/v1' })).rejects.toBeDefined();
    expect(seen.filter((url) => url.endsWith('/auth/identity'))).toHaveLength(0);
  });
});
