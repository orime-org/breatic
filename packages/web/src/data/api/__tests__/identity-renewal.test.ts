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
import { IDENTITY_RENEW_INTERVAL_MS, ensureFreshIdentity, renewIdentityNow, startIdentityRenewal } from '@web/data/api/identity-renewal';
import { parseRegionConfig } from '@web/data/api/regions';
import { ApiException } from '@web/data/api/types';

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
    const next = key === undefined ? { status: 200 } : (answers[key].shift() ?? { status: 200 });
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

  it('stops renewing once the global region answers that the session is gone', async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => {
      throw new ApiException({ status: 401, message: 'not signed in' });
    });

    const stop = startIdentityRenewal(renew, TWO_REGIONS);
    await vi.advanceTimersByTimeAsync(45_000 * 3);
    expect(renew).toHaveBeenCalledTimes(1);
    stop();
  });

  it('still renews on demand after a 401, and resumes the timer once a renewal works again', async () => {
    vi.useFakeTimers();
    let signedOut = true;
    const renew = vi.fn(async () => {
      if (signedOut) throw new ApiException({ status: 401, message: 'not signed in' });
    });

    const stop = startIdentityRenewal(renew, TWO_REGIONS);
    await vi.advanceTimersByTimeAsync(45_000 * 2);
    expect(renew).toHaveBeenCalledTimes(1);

    // The user signed in again elsewhere; a region refusal asks for a renewal.
    signedOut = false;
    await renewIdentityNow();
    expect(renew).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(45_000 * 2);
    expect(renew).toHaveBeenCalledTimes(4);
    stop();
  });

  it('keeps renewing after a failure that is not about the session', async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => {
      throw new ApiException({ status: 503, message: 'down' });
    });

    const stop = startIdentityRenewal(renew, TWO_REGIONS);
    await vi.advanceTimersByTimeAsync(45_000 * 3);
    expect(renew).toHaveBeenCalledTimes(3);
    stop();
  });

  it('renews at once when the tab comes back after the token went stale, and not when it is fresh', async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => undefined);
    const stop = startIdentityRenewal(renew, TWO_REGIONS);

    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(renew).not.toHaveBeenCalled();

    // A hidden tab's interval never fired: the clock moved, the timer did not.
    vi.setSystemTime(Date.now() + 2 * IDENTITY_RENEW_INTERVAL_MS);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(renew).toHaveBeenCalledTimes(1);
    stop();
  });

  it('renews at once when the network comes back after the token went stale', async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => undefined);
    const stop = startIdentityRenewal(renew, TWO_REGIONS);

    vi.setSystemTime(Date.now() + 2 * IDENTITY_RENEW_INTERVAL_MS);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(renew).toHaveBeenCalledTimes(1);
    stop();
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('makes a sender wait for one shared renewal only when the token is stale', async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const renew = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const stop = startIdentityRenewal(renew, TWO_REGIONS);

    await ensureFreshIdentity();
    expect(renew).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 2 * IDENTITY_RENEW_INTERVAL_MS);
    let done = 0;
    const waits = [ensureFreshIdentity().then(() => { done += 1; }), ensureFreshIdentity().then(() => { done += 1; })];
    await vi.advanceTimersByTimeAsync(0);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(done).toBe(0);
    release();
    await Promise.all(waits);
    expect(done).toBe(2);
    await ensureFreshIdentity();
    expect(renew).toHaveBeenCalledTimes(1);
    stop();
  });

  it('never makes a sender wait in a build with one region', async () => {
    const renew = vi.fn(async () => undefined);
    const stop = startIdentityRenewal(renew, null);
    await ensureFreshIdentity();
    expect(renew).not.toHaveBeenCalled();
    stop();
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
  let stop: () => void = () => undefined;
  beforeEach(() => {
    stop = startIdentityRenewal(() => request.post('/auth/identity', undefined, { baseURL: 'https://us.example.test/api/v1' }), TWO_REGIONS);
  });
  afterEach(() => stop());

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

  it('shares one renewal among requests refused together', async () => {
    request.defaults.adapter = adapter({
      '/projects/p1': [{ status: 401, reason: 'identity_expired' }, { status: 200 }],
      '/projects/p2': [{ status: 401, reason: 'identity_expired' }, { status: 200 }],
    });

    await Promise.all([
      request.get('/projects/p1', { baseURL: 'https://sg.example.test/api/v1' }),
      request.get('/projects/p2', { baseURL: 'https://sg.example.test/api/v1' }),
    ]);

    expect(seen.filter((url) => url.endsWith('/auth/identity'))).toHaveLength(1);
  });

  it('does not renew for any other 401', async () => {
    request.defaults.adapter = adapter({ '/projects/p1': [{ status: 401 }] });

    await expect(request.get('/projects/p1', { baseURL: 'https://sg.example.test/api/v1' })).rejects.toBeDefined();
    expect(seen.filter((url) => url.endsWith('/auth/identity'))).toHaveLength(0);
  });
});
