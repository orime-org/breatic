// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act, renderHook } from '@testing-library/react';
import { REQUEST_SHAPE_REASON } from '@breatic/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const muteToasts = vi.hoisted(() => vi.fn());
vi.mock('@web/lib/toast', () => ({ muteToasts }));

import {
  _resetStaleReleaseForTests,
  checkStaleRelease,
  useStaleRelease,
} from '@web/data/deployment/stale-release';

const fetchMock = vi.fn();
const manifest = (version: unknown): Response => new Response(JSON.stringify({ version }));

beforeEach(() => {
  vi.stubEnv('PROD', true);
  vi.stubEnv('VITE_APP_VERSION', 'current');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockImplementation(() => Promise.resolve(manifest('next')));
  muteToasts.mockClear();
  sessionStorage.clear();
  _resetStaleReleaseForTests();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('telling an out-of-date page from a refused request', () => {
  it('calls the page out of date when a shape refusal meets a different live build', async () => {
    const { result } = renderHook(useStaleRelease);
    expect(result.current).toBe(false);
    await act(async () => { expect(await checkStaleRelease(REQUEST_SHAPE_REASON)).toBe(true); });
    expect(result.current).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/app-version.json'),
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('silences toasts the moment it decides, so the refusal behind it says nothing', async () => {
    await checkStaleRelease(REQUEST_SHAPE_REASON);
    expect(muteToasts).toHaveBeenCalledTimes(1);
  });

  it('does not look at the build for a refusal without the mark', async () => {
    expect(await checkStaleRelease(undefined)).toBe(false);
    expect(await checkStaleRelease('something_else')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(muteToasts).not.toHaveBeenCalled();
  });

  it('leaves the refusal alone when the live build is this one', async () => {
    fetchMock.mockResolvedValue(manifest('current'));
    expect(await checkStaleRelease(REQUEST_SHAPE_REASON)).toBe(false);
    expect(muteToasts).not.toHaveBeenCalled();
  });

  it.each([
    ['the manifest cannot be fetched', (): Promise<Response> => Promise.reject(new Error('offline'))],
    ['the manifest is not ours', (): Promise<Response> => Promise.resolve(new Response('<html>'))],
    ['the manifest answers an error', (): Promise<Response> => Promise.resolve(new Response('x', { status: 503 }))],
  ])('leaves the refusal alone when %s', async (_name, answer) => {
    fetchMock.mockImplementation(answer);
    expect(await checkStaleRelease(REQUEST_SHAPE_REASON)).toBe(false);
  });

  it('never decides in a build without a version', async () => {
    vi.stubEnv('PROD', false);
    expect(await checkStaleRelease(REQUEST_SHAPE_REASON)).toBe(false);
    vi.stubEnv('PROD', true); vi.stubEnv('VITE_APP_VERSION', '');
    expect(await checkStaleRelease(REQUEST_SHAPE_REASON)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still decides for a release the reader postponed with Later', async () => {
    sessionStorage.setItem('breatic.deferredAppVersions', '["next"]');
    expect(await checkStaleRelease(REQUEST_SHAPE_REASON)).toBe(true);
  });

  it('stays decided without asking again', async () => {
    await checkStaleRelease(REQUEST_SHAPE_REASON);
    fetchMock.mockClear();
    expect(await checkStaleRelease(REQUEST_SHAPE_REASON)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(muteToasts).toHaveBeenCalledTimes(1);
  });
});
