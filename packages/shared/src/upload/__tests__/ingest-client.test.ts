// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Sending bytes to the ingest Worker (#173 design §4.2, #181 lane ②, #206
 * design §3.5).
 *
 * Two steps here: open the upload for a session token, then PUT each part and
 * take the fresh token it answers with. Since the token rotates per part, what
 * has to be shown is that part n carries the token part n-1 handed back.
 *
 * Finishing is a third step, and it belongs to whoever drives it. The browser
 * hands what it holds to our server, which finishes on its behalf; our own
 * worker finishes for itself. Both go through the same call, and both present
 * the shared secret the Worker asks for — which is what keeps a page from
 * finishing an upload behind our back.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { httpRequest } from '@shared/http/request.js';
import {
  sendBytesToIngest,
  finishUploadAtIngest,
  computePutTimeoutMs,
  type IngestTarget,
  type UploadClientConfig,
} from '@shared/upload/ingest-client.js';

vi.mock('@shared/http/request.js', () => ({ httpRequest: vi.fn() }));

const mockedRequest = vi.mocked(httpRequest);

const PART_SIZE = 5 * 1024 * 1024;
const SECRET = 'shared-secret';
const WORKER_URL = 'https://ingest.example.com';

const cfg: UploadClientConfig = {
  maxUploadBytes: 2 * 1024 * 1024 * 1024,
  clientMaxAttempts: 3,
  clientRetryBaseDelayMs: 500,
  clientRequestTimeoutMs: 30_000,
  clientPutMinBytesPerSec: 50_000,
};

/** A ticket for a file of `totalParts` parts. */
function ticketFor(totalParts: number): IngestTarget {
  return {
    ticket: 'signed-ticket',
    uploadUrl: WORKER_URL,
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
  const init = mockedRequest.mock.calls[nth]?.[1];
  return (init?.headers ?? {}) as Record<string, string>;
}

/** The transport options of the nth call. */
function optionsOf(nth: number): { replaySafe: boolean; timeoutMs?: number } {
  const options = mockedRequest.mock.calls[nth]?.[2];
  if (options === undefined) throw new Error(`no call ${nth}`);
  return options;
}

beforeEach(() => {
  mockedRequest.mockReset();
});

/** Answer an open and `parts` part PUTs. */
function wireOpenAndParts(parts: number): void {
  mockedRequest.mockResolvedValueOnce(
    answers(200, { uploadId: 'upload-1', token: 'token-0' }),
  );
  for (let n = 1; n <= parts; n += 1) {
    mockedRequest.mockResolvedValueOnce(
      answers(200, { token: `token-${n}`, partNumber: n, etag: `etag-${n}` }),
    );
  }
}

/** What the Worker measures over an object that landed. */
const MEASURED = {
  sha256: 'a'.repeat(64),
  sizeBytes: 1024,
  contentType: 'image/png',
};

describe('sending bytes to the ingest Worker', () => {
  it('opens the upload with the ticket our server signed', async () => {
    wireOpenAndParts(1);

    await sendBytesToIngest(fileOf(1024), ticketFor(1), cfg);

    expect(urlOf(0)).toBe('https://ingest.example.com/uploads');
    expect(headersOf(0)['x-upload-ticket']).toBe('signed-ticket');
  });

  it('cuts at the signed part size, and only the last part may be short', async () => {
    wireOpenAndParts(3);

    await sendBytesToIngest(fileOf(PART_SIZE * 2 + 700), ticketFor(3), cfg);

    const sizes = [1, 2, 3].map((n) => {
      const init = mockedRequest.mock.calls[n]?.[1];
      return (init?.body as Blob).size;
    });
    expect(sizes).toEqual([PART_SIZE, PART_SIZE, 700]);
  });

  it('sends each part to the address for its own part number', async () => {
    wireOpenAndParts(2);

    await sendBytesToIngest(fileOf(PART_SIZE + 10), ticketFor(2), cfg);

    expect(urlOf(1)).toBe('https://ingest.example.com/uploads/upload-1/parts/1');
    expect(urlOf(2)).toBe('https://ingest.example.com/uploads/upload-1/parts/2');
  });

  // The token rotates per part, so a leaked one can only write the next part
  // of this one upload.
  it('carries the token the previous part handed back', async () => {
    wireOpenAndParts(2);

    await sendBytesToIngest(fileOf(PART_SIZE + 10), ticketFor(2), cfg);

    expect(headersOf(1)['x-upload-token']).toBe('token-0');
    expect(headersOf(2)['x-upload-token']).toBe('token-1');
  });

  // Nothing on the Worker's side remembers which parts landed, so what
  // finishes an upload is the list this side built up (design §6.1). Handing
  // it back rather than using it here is what lets our server finish for the
  // browser, which cannot hold the secret the Worker asks for.
  it('hands back what finishing this upload will need', async () => {
    wireOpenAndParts(3);

    const held = await sendBytesToIngest(
      fileOf(PART_SIZE * 2 + 700),
      ticketFor(3),
      cfg,
    );

    expect(held).toEqual({
      uploadId: 'upload-1',
      token: 'token-3',
      parts: [
        { partNumber: 1, etag: 'etag-1' },
        { partNumber: 2, etag: 'etag-2' },
        { partNumber: 3, etag: 'etag-3' },
      ],
    });
  });

  it('stops once the last part has landed', async () => {
    wireOpenAndParts(2);

    await sendBytesToIngest(fileOf(PART_SIZE + 10), ticketFor(2), cfg);

    // One open and two parts. A third delivery here would be a finish this
    // caller may not be able to authorise.
    expect(mockedRequest).toHaveBeenCalledTimes(3);
  });
});

describe('finishing an upload', () => {
  const held = {
    uploadId: 'upload-1',
    token: 'token-3',
    parts: [
      { partNumber: 1, etag: 'etag-1' },
      { partNumber: 2, etag: 'etag-2' },
    ],
  };

  it('asks the upload it holds to finish, with the newest token', async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, MEASURED));

    await finishUploadAtIngest(WORKER_URL, held, SECRET);

    expect(urlOf(0)).toBe(
      'https://ingest.example.com/uploads/upload-1/complete',
    );
    expect(headersOf(0)['x-upload-token']).toBe('token-3');
  });

  // A ticket and a session token both travel to the browser. The secret is the
  // one thing only our own servers hold, and finishing is the step whose
  // permission lives in our ledger rather than in the token.
  it('presents the shared secret', async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, MEASURED));

    await finishUploadAtIngest(WORKER_URL, held, SECRET);

    expect(headersOf(0)['x-ingest-secret']).toBe(SECRET);
  });

  it('hands back every part receipt, as JSON it says is JSON', async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, MEASURED));

    await finishUploadAtIngest(WORKER_URL, held, SECRET);

    expect(headersOf(0)['content-type']).toBe('application/json');
    expect(JSON.parse(mockedRequest.mock.calls[0]?.[1]?.body as string)).toEqual({
      parts: held.parts,
    });
  });

  it('answers with what the Worker measured over the stored object', async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, MEASURED));

    const measured = await finishUploadAtIngest(WORKER_URL, held, SECRET);

    expect(measured).toEqual(MEASURED);
  });

  // 409 means parts are missing: this upload will never become the object it
  // was opened for.
  it('fails when the Worker says the upload never completed', async () => {
    mockedRequest.mockResolvedValueOnce(
      answers(409, { reason: 'only 0 of 1 parts arrived' }),
    );

    await expect(
      finishUploadAtIngest(WORKER_URL, held, SECRET),
    ).rejects.toThrow();
  });
});

// What the transport is told decides how many times a request is delivered and
// when one is given up on. Neither is visible in the response, so it is stated
// here or nowhere.
describe('what the shared transport is told', () => {
  // The test is whether a request names the upload it writes into. A part and
  // a completion do, so a repeat writes the same part under its own number or
  // is answered out of the ledger. Opening carries no id: it mints one, and
  // the Worker opens a fresh multipart upload on every delivery, so a replay
  // abandons the first one holding parts R2 charges for.
  it('declares opening unsafe to replay, and the parts safe', async () => {
    wireOpenAndParts(2);

    await sendBytesToIngest(fileOf(PART_SIZE + 10), ticketFor(2), cfg);

    expect(optionsOf(0).replaySafe).toBe(false);
    expect(optionsOf(1).replaySafe).toBe(true);
    expect(optionsOf(2).replaySafe).toBe(true);
  });

  // A stall guard sized to the part, so a part that is transferring at all is
  // never cut off and one that has stopped does not hold the whole file's
  // budget.
  it('gives each part a deadline its own size earns', async () => {
    wireOpenAndParts(2);

    await sendBytesToIngest(fileOf(PART_SIZE + 10), ticketFor(2), cfg);

    expect(optionsOf(1).timeoutMs).toBe(computePutTimeoutMs(PART_SIZE, cfg));
    expect(optionsOf(2).timeoutMs).toBe(computePutTimeoutMs(10, cfg));
  });

  // Completing carries no bytes, and the work it waits on — reading the
  // assembled object back to hash it — happens inside Cloudflare's network, at
  // a rate the caller's own upload figures say nothing about. So it takes the
  // transport's default rather than a deadline sized from those figures, which
  // at the upload cap would have been hours.
  it('sizes finishing by nothing the caller measured, and repeats it', async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, MEASURED));

    await finishUploadAtIngest(
      WORKER_URL,
      { uploadId: 'upload-1', token: 'token-3', parts: [] },
      SECRET,
    );

    expect(optionsOf(0).replaySafe).toBe(true);
    expect(optionsOf(0).timeoutMs).toBeUndefined();
    // The figure that would otherwise have been handed over, kept here so this
    // test says what it is refusing rather than only that a field is absent.
    expect(computePutTimeoutMs(PART_SIZE * 2 + 700, cfg)).toBeGreaterThan(
      cfg.clientRequestTimeoutMs,
    );
  });
});

describe('when the Worker refuses', () => {
  it('sends no bytes when the upload cannot be opened', async () => {
    mockedRequest.mockResolvedValueOnce(answers(401, {}));

    await expect(
      sendBytesToIngest(fileOf(1024), ticketFor(1), cfg),
    ).rejects.toThrow();

    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it('stops at a refused part instead of sending the rest', async () => {
    mockedRequest.mockResolvedValueOnce(
      answers(200, { uploadId: 'upload-1', token: 'token-0' }),
    );
    mockedRequest.mockResolvedValueOnce(answers(400, {}));

    await expect(
      sendBytesToIngest(fileOf(PART_SIZE + 10), ticketFor(2), cfg),
    ).rejects.toThrow();

    expect(mockedRequest).toHaveBeenCalledTimes(2);
  });
});
