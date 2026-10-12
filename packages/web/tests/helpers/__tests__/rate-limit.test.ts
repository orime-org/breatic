// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { describe, expect, it } from 'vitest';

import { whileRateLimited } from '../rate-limit';

/**
 * An answer with the two things the helper reads.
 * @param status - The status code.
 * @param retryAfter - The Retry-After header, when there is one.
 * @returns The answer.
 */
function answer(status: number, retryAfter?: string): { status: () => number; headers: () => Record<string, string> } {
  return {
    status: () => status,
    headers: () => (retryAfter === undefined ? {} : { 'retry-after': retryAfter }),
  };
}

describe('whileRateLimited', () => {
  it('waits as long as the server says, then sends again', async () => {
    const answers = [answer(429, '2'), answer(200)];
    const waited: number[] = [];
    const final = await whileRateLimited(
      async () => answers.shift() ?? answer(500),
      async (ms) => {
        waited.push(ms);
      },
    );
    expect(final.status()).toBe(200);
    expect(waited).toEqual([2000]);
  });

  it('hands back any other answer at once', async () => {
    const waited: number[] = [];
    const final = await whileRateLimited(
      async () => answer(401),
      async (ms) => {
        waited.push(ms);
      },
    );
    expect(final.status()).toBe(401);
    expect(waited).toEqual([]);
  });

  it('gives up with the limit named when the server keeps refusing', async () => {
    await expect(
      whileRateLimited(
        async () => answer(429, '1'),
        async () => {},
      ),
    ).rejects.toThrow(/429/);
  });
});
