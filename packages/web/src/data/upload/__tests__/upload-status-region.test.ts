// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The page asks how an upload ended at the region that opened it, even after
 * the page moved to another region (inner#1955).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchUploadStatus = vi.hoisted(() => vi.fn());
vi.mock('@web/data/api/assets', () => ({
  assetsApi: {
    fetchUploadStatus,
    fetchUploadConfig: vi.fn(async () => ({ uploadStatusPollSeconds: 1 })),
  },
}));

import { waitForUploadEnding } from '@web/data/upload/upload-status';

afterEach(() => {
  vi.useRealTimers();
});

describe('waitForUploadEnding', () => {
  it('asks the API base each upload was opened at, never one for another', async () => {
    vi.useFakeTimers();
    fetchUploadStatus.mockImplementation(async (keys: readonly string[]) => ({
      items: keys.map((key) => ({ key, state: 'transferred' })),
      retryAfterSeconds: null,
    }));

    const sg = waitForUploadEnding('k-sg', undefined, 'https://sg.example.test/api/v1');
    const here = waitForUploadEnding('k-here');
    await vi.advanceTimersByTimeAsync(1000);

    await expect(sg).resolves.toEqual({ key: 'k-sg', state: 'transferred' });
    await expect(here).resolves.toEqual({ key: 'k-here', state: 'transferred' });
    expect(fetchUploadStatus.mock.calls).toEqual(
      expect.arrayContaining([
        [['k-sg'], 'https://sg.example.test/api/v1'],
        [['k-here'], undefined],
      ]),
    );
    expect(fetchUploadStatus).toHaveBeenCalledTimes(2);
  });
});
