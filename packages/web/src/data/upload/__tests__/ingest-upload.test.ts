// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Sending bytes to the ingest Worker (#173, design §4.2).
 *
 * Three steps: open the upload for a session token, PUT each part and take the
 * fresh token it answers with, then complete. Since the token rotates per
 * part, what has to be shown here is that part n carries the token part n-1
 * handed back.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { httpRequest } from '@breatic/shared';
import type * as shared from '@breatic/shared';
import { sendFileToIngest } from '@web/data/upload/ingest-upload';
import type { UploadTicket } from '@web/data/upload/ingest-upload';
import {
  computePutTimeoutMs,
  type UploadClientConfig,
} from '@web/data/upload/upload-retry';

vi.mock('@breatic/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof shared>()),
  httpRequest: vi.fn(),
}));

const mockedRequest = vi.mocked(httpRequest);

const PART_SIZE = 5 * 1024 * 1024;

const cfg: UploadClientConfig = {
  maxUploadBytes: 2 * 1024 * 1024 * 1024,
  clientMaxAttempts: 3,
  clientRetryBaseDelayMs: 500,
  clientRequestTimeoutMs: 30_000,
  clientPutMinBytesPerSec: 50_000,
};

/** A ticket for a file of `totalParts` parts. */
function ticketFor(totalParts: number): UploadTicket {
  return {
    ticket: 'signed-ticket',
    storageKey: 'image/2026-08-31/abc.png',
    uploadUrl: 'https://ingest.example.com',
    kind: 'image',
    partSize: PART_SIZE,
    totalParts,
  };
}

/** A file of `bytes` bytes. */
function fileOf(bytes: number): File {
  return new File([new Uint8Array(bytes)], 'shot.png', { type: 'image/png' });
}

/** An answer with `body` as its JSON. */
function answers(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** The url of the nth call. */
function urlOf(nth: number): string {
  return String(mockedRequest.mock.calls[nth]?.[0]);
}

/** The headers of the nth call. */
function headersOf(nth: number): Record<string, string> {
  const init = mockedRequest.mock.calls[nth]?.[1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  mockedRequest.mockReset();
});

/** Answer an open, `parts` part PUTs, and a complete. */
function wireHappyPath(parts: number, outcome: unknown): void {
  mockedRequest.mockResolvedValueOnce(
    answers(200, { uploadId: 'upload-1', token: 'token-0' }),
  );
  for (let n = 1; n <= parts; n += 1) {
    mockedRequest.mockResolvedValueOnce(answers(200, { token: `token-${n}` }));
  }
  mockedRequest.mockResolvedValueOnce(answers(200, outcome));
}

describe('sending a file to the ingest Worker', () => {
  it('opens the upload with the ticket our server signed', async () => {
    wireHappyPath(1, { fileUrl: 'https://cdn/x.png', kind: 'image' });

    await sendFileToIngest(fileOf(1024), ticketFor(1), cfg);

    expect(urlOf(0)).toBe('https://ingest.example.com/uploads');
    expect(headersOf(0)['x-upload-ticket']).toBe('signed-ticket');
  });

  it('cuts at the signed part size, and only the last part may be short', async () => {
    wireHappyPath(3, {});

    await sendFileToIngest(fileOf(PART_SIZE * 2 + 700), ticketFor(3), cfg);

    const sizes = [1, 2, 3].map((n) => {
      const init = mockedRequest.mock.calls[n]?.[1];
      return (init?.body as Blob).size;
    });
    expect(sizes).toEqual([PART_SIZE, PART_SIZE, 700]);
  });

  it('sends each part to the address for its own part number', async () => {
    wireHappyPath(2, {});

    await sendFileToIngest(fileOf(PART_SIZE + 10), ticketFor(2), cfg);

    expect(urlOf(1)).toBe('https://ingest.example.com/uploads/upload-1/parts/1');
    expect(urlOf(2)).toBe('https://ingest.example.com/uploads/upload-1/parts/2');
  });

  // The token rotates per part, so a leaked one can only write the next part
  // of this one upload.
  it('carries the token the previous part handed back', async () => {
    wireHappyPath(2, {});

    await sendFileToIngest(fileOf(PART_SIZE + 10), ticketFor(2), cfg);

    expect(headersOf(1)['x-upload-token']).toBe('token-0');
    expect(headersOf(2)['x-upload-token']).toBe('token-1');
  });

  it('completes with the newest token and hands the answer back', async () => {
    wireHappyPath(1, { fileUrl: 'https://cdn/x.png', kind: 'image' });

    const outcome = await sendFileToIngest(fileOf(1024), ticketFor(1), cfg);

    expect(urlOf(2)).toBe(
      'https://ingest.example.com/uploads/upload-1/complete',
    );
    expect(headersOf(2)['x-upload-token']).toBe('token-1');
    expect(outcome).toEqual({ fileUrl: 'https://cdn/x.png', kind: 'image' });
  });
});

/** The transport options of the nth call. */
function optionsOf(nth: number): { replaySafe: boolean; timeoutMs?: number } {
  const options = mockedRequest.mock.calls[nth]?.[2];
  if (options === undefined) throw new Error(`no call ${nth}`);
  return options;
}

// What the transport is told decides how many times a request is delivered and
// when one is given up on. Neither is visible in the response, so it is stated
// here or nowhere.
describe('what the shared transport is told', () => {
  // The Durable Object behind this upload answers a repeated open with the
  // upload already open, records a part under its own number, and completes
  // once — so delivering any of the three again costs nothing.
  it('declares every step replay-safe', async () => {
    wireHappyPath(2, {});

    await sendFileToIngest(fileOf(PART_SIZE + 10), ticketFor(2), cfg);

    expect(optionsOf(0).replaySafe).toBe(true);
    expect(optionsOf(1).replaySafe).toBe(true);
    expect(optionsOf(3).replaySafe).toBe(true);
  });

  // A stall guard sized to the part, so a part that is transferring at all is
  // never cut off and one that has stopped does not hold the whole file's
  // budget.
  it('gives each part a deadline its own size earns', async () => {
    wireHappyPath(2, {});

    await sendFileToIngest(fileOf(PART_SIZE + 10), ticketFor(2), cfg);

    expect(optionsOf(1).timeoutMs).toBe(computePutTimeoutMs(PART_SIZE, cfg));
    expect(optionsOf(2).timeoutMs).toBe(computePutTimeoutMs(10, cfg));
  });

  // Completing carries no bytes, and the work it waits on — reading the
  // assembled object back to hash it — happens inside Cloudflare's network, at
  // a rate the browser's own upload figures say nothing about. So it takes the
  // transport's default rather than a deadline sized from those figures, which
  // at the upload cap would have been hours.
  it('sizes completing by nothing the browser measured', async () => {
    wireHappyPath(3, {});
    const file = fileOf(PART_SIZE * 2 + 700);

    await sendFileToIngest(file, ticketFor(3), cfg);

    expect(optionsOf(4).replaySafe).toBe(true);
    expect(optionsOf(4).timeoutMs).toBeUndefined();
    // The figure that used to be handed over, kept here so this test says what
    // it is refusing rather than only that a field is absent.
    expect(computePutTimeoutMs(file.size, cfg)).toBeGreaterThan(
      cfg.clientRequestTimeoutMs,
    );
  });
});

describe('when the Worker refuses', () => {
  it('sends no bytes when the upload cannot be opened', async () => {
    mockedRequest.mockResolvedValueOnce(answers(401, {}));

    await expect(
      sendFileToIngest(fileOf(1024), ticketFor(1), cfg),
    ).rejects.toThrow();

    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it('stops at a refused part instead of sending the rest', async () => {
    mockedRequest.mockResolvedValueOnce(
      answers(200, { uploadId: 'upload-1', token: 'token-0' }),
    );
    mockedRequest.mockResolvedValueOnce(answers(400, {}));

    await expect(
      sendFileToIngest(fileOf(PART_SIZE + 10), ticketFor(2), cfg),
    ).rejects.toThrow();

    expect(mockedRequest).toHaveBeenCalledTimes(2);
  });

  // 409 means parts are missing: this upload will never become the object it
  // was opened for.
  it('fails when finishing says the upload never completed', async () => {
    wireHappyPath(1, {});
    mockedRequest.mockReset();
    mockedRequest.mockResolvedValueOnce(
      answers(200, { uploadId: 'upload-1', token: 'token-0' }),
    );
    mockedRequest.mockResolvedValueOnce(answers(200, { token: 'token-1' }));
    mockedRequest.mockResolvedValueOnce(
      answers(409, { outcome: 'aborted', reason: 'only 0 of 1 parts arrived' }),
    );

    await expect(
      sendFileToIngest(fileOf(1024), ticketFor(1), cfg),
    ).rejects.toThrow();
  });
});
