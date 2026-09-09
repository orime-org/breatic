// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How the finish is delivered again when its answer never arrived.
 *
 * The bytes are already in R2 by the time this step runs, so the only thing
 * standing between a momentary network drop and a lost upload is this retry.
 * What it has to get right is the two halves of "again": leave enough time for
 * the connection to come back, and stop the moment the server has said
 * something a repeat cannot change.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { UploadClientConfig } from '@breatic/shared';

const sendBytesToIngest = vi.fn();
const apiPost = vi.fn();

vi.mock('@breatic/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@breatic/shared')>()),
  sendBytesToIngest: (...args: unknown[]) => sendBytesToIngest(...args),
}));
vi.mock('@web/data/api/request', () => ({
  apiPost: (...args: unknown[]) => apiPost(...args),
}));

const { sendFileAndFinish } = await import('@web/data/upload/finish-upload');
const { ApiException } = await import('@web/data/api/types');

const CFG: UploadClientConfig = {
  maxUploadBytes: 2147483648,
  clientMaxAttempts: 3,
  clientRetryBaseDelayMs: 1000,
  clientRequestTimeoutMs: 30000,
  clientPutMinBytesPerSec: 65536,
};

const TICKET = {
  ticket: 'signed',
  storageKey: 'image/2026-09-09/x.png',
  uploadUrl: 'https://ingest.example.com',
  kind: 'image',
  partSize: 5 * 1024 * 1024,
  totalParts: 1,
};

/** What the transport hands back once every part has landed. */
function held(): { uploadId: string; token: string; parts: unknown[] } {
  return {
    uploadId: 'an-upload',
    token: 'a-token',
    parts: [{ partNumber: 1, etag: 'e1' }],
  };
}

/** The shape `apiPost` rejects with; status 0 is "nothing answered". */
function refusal(status: number): Error {
  return new ApiException({ status, message: 'refused', fromServer: status > 0 });
}

beforeEach(() => {
  sendBytesToIngest.mockReset().mockResolvedValue(held());
  apiPost.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('finishing an upload our server drives', () => {
  it('gives back the row the server registered', async () => {
    apiPost.mockResolvedValue({ assetId: 'a1', fileUrl: 'https://cdn/x.png' });

    const outcome = await sendFileAndFinish(
      new File(['x'], 'x.png', { type: 'image/png' }),
      TICKET,
      CFG,
    );

    expect(outcome.fileUrl).toBe('https://cdn/x.png');
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  // The grant is void and the bytes are refused: R2 already holds what it is
  // going to hold, and every further delivery asks the same question of a
  // ledger row that has already answered. Spending the budget here also
  // replaces the status that explains the refusal with whatever the last
  // attempt happens to get.
  it('stops asking once the server has refused for a reason a repeat cannot change', async () => {
    apiPost.mockRejectedValue(refusal(413));

    await expect(
      sendFileAndFinish(
        new File(['x'], 'x.png', { type: 'image/png' }),
        TICKET,
        CFG,
      ),
    ).rejects.toMatchObject({ status: 413 });

    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  // The whole point of asking again is to outlast a connection that is down
  // for a second or two. Deliveries with no interval between them all fail for
  // the same reason the first one did, which spends three attempts on one
  // instant and leaves the upload lost.
  it('leaves time between deliveries when nothing answered', async () => {
    vi.useFakeTimers();
    apiPost.mockRejectedValue(refusal(0));

    const settled = sendFileAndFinish(
      new File(['x'], 'x.png', { type: 'image/png' }),
      TICKET,
      CFG,
    ).then(
      () => 'resolved',
      () => 'rejected',
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(apiPost).toHaveBeenCalledTimes(1);

    // Full jitter puts each wait in [0, base * 2^n), so this covers both.
    await vi.advanceTimersByTimeAsync(CFG.clientRetryBaseDelayMs * 4);
    expect(apiPost).toHaveBeenCalledTimes(CFG.clientMaxAttempts);
    await expect(settled).resolves.toBe('rejected');
  });
});
